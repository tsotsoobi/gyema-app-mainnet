"use client"

import { useEffect, useState } from "react"
import { SignIn } from "@/components/sign-in"
import { AppHeader } from "@/components/app-header"
import { BottomNav, type Tab } from "@/components/bottom-nav"
import { HomeTab } from "@/components/home-tab"
import { TripsTab } from "@/components/trips-tab"
import { TrackTab } from "@/components/track-tab"
import { ProfileTab } from "@/components/profile-tab"
import { WelcomeSheet } from "@/components/welcome-sheet"
import { ListingDetailSheet } from "@/components/listing-detail-sheet"
import { getListingByTrackingIdAsync } from "@/lib/listings-async"
import type { Listing } from "@/lib/listings"
import {
  clearStoredAuth,
  getStoredRole,
  getStoredUser,
  isGuest,
  restoreSessionFromStorage,
  setStoredRole,
  setStoredUser,
  type PiUser,
  type UserRole,
} from "@/lib/pi-network"

export default function Gyema() {
  const [user, setUser] = useState<PiUser | null>(null)
  const [role, setRole] = useState<UserRole>("traveller")
  const [activeTab, setActiveTab] = useState<Tab>("home")
  const [refreshKey, setRefreshKey] = useState(0)
  const [hydrated, setHydrated] = useState(false)
  const [showWelcome, setShowWelcome] = useState(false)
  const [deepListing, setDeepListing] = useState<Listing | null>(null)
  const [pendingShareId, setPendingShareId] = useState<string | null>(null)

  useEffect(() => {
    const storedRole = getStoredRole()
    if (storedRole) setRole(storedRole)

    // Cold-mount session restore: if there's a stored user, verify their
    // session is still good before trusting it. Guests pass through
    // immediately; Pioneers get their Supabase session refreshed via
    // /api/auth/verify so backend POSTs (listings, trips, payments) work
    // on fresh tabs. Without this, returning Pioneers see "Could not
    // post your delivery" on cold Pi Ecosystem entry until they sign
    // out and back in.
    let cancelled = false
    ;(async () => {
      const stored = getStoredUser()
      if (!stored) {
        if (!cancelled) setHydrated(true)
        return
      }

      if (isGuest(stored)) {
        if (!cancelled) {
          setUser(stored)
          setHydrated(true)
        }
        return
      }

      const restored = await restoreSessionFromStorage()
      if (cancelled) return

      if (restored) {
        setUser(restored)
      } else {
        // Stored session is no longer valid — clear it and show SignIn.
        clearStoredAuth()
      }
      setHydrated(true)
    })()

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (typeof window === "undefined") return
    try {
      const seen = localStorage.getItem("gyema-welcome-seen")
      if (seen !== "true") {
        setShowWelcome(true)
      }
    } catch {
      // localStorage may throw in private browsing or restricted contexts.
    }
  }, [])

  // Deep link: a shared link of the form ?listing=GYM-XXXX (opened in Pi
  // Browser via a pi:// share link) should land on that listing. Capture the
  // code on mount and strip it from the URL so a later refresh doesn't reopen
  // the sheet unexpectedly.
  useEffect(() => {
    if (typeof window === "undefined") return
    const code = new URLSearchParams(window.location.search).get("listing")
    if (code) {
      setPendingShareId(code)
      window.history.replaceState({}, "", window.location.pathname)
    }
  }, [])

  // Resolve the deep-linked listing once hydration settles. The lookup is the
  // public tracking-id read, so it works even before the viewer signs in; the
  // sheet itself gates Accept behind sign-in for guests.
  useEffect(() => {
    if (!pendingShareId || !hydrated) return
    let cancelled = false
    ;(async () => {
      const found = await getListingByTrackingIdAsync(pendingShareId)
      if (!cancelled) {
        if (found) setDeepListing(found)
        setPendingShareId(null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [pendingShareId, hydrated])

  const dismissWelcome = () => {
    setShowWelcome(false)
    if (typeof window !== "undefined") {
      try {
        localStorage.setItem("gyema-welcome-seen", "true")
      } catch {
        // Same reasoning as the read above.
      }
    }
  }

  const handleSignedIn = (signedInUser: PiUser) => {
    setUser(signedInUser)
  }

  const handleContinueAsGuest = () => {
    const guestId =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    const guest: PiUser = {
      uid: `guest-${guestId}`,
      username: "guest",
      accessToken: "",
    }
    setStoredUser(guest)
    setUser(guest)
  }

  const handleRoleChange = (newRole: UserRole) => {
    setRole(newRole)
    setStoredRole(newRole)
  }

  const handleSignOut = () => {
    clearStoredAuth()
    setUser(null)
    setActiveTab("home")
  }

  const triggerRefresh = () => setRefreshKey((k) => k + 1)

  if (!hydrated) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="h-10 w-10 rounded-full border-4 border-primary border-t-transparent animate-spin" />
      </div>
    )
  }

  if (!user) {
    return (
      <>
        <SignIn
          onSignedIn={handleSignedIn}
          onContinueAsGuest={handleContinueAsGuest}
        />
        {showWelcome && <WelcomeSheet onDismiss={dismissWelcome} />}
      </>
    )
  }

  return (
    <div className="min-h-screen bg-background pb-20 max-w-md mx-auto">
      <AppHeader role={role} onRoleChange={handleRoleChange} piBalance={0} />

      {activeTab === "home" && (
        <HomeTab
          role={role}
          user={user}
          refreshKey={refreshKey}
          onListingCreated={triggerRefresh}
          onSignedIn={handleSignedIn}
        />
      )}
      {activeTab === "trips" && (
        <TripsTab
          user={user}
          role={role}
          refreshKey={refreshKey}
          onNavigate={setActiveTab}
        />
      )}
      {activeTab === "track" && <TrackTab />}
      {activeTab === "profile" && (
        <ProfileTab
          user={user}
          onSignOut={handleSignOut}
          refreshKey={refreshKey}
          onNavigate={setActiveTab}
          onSignedIn={handleSignedIn}
        />
      )}

      <BottomNav active={activeTab} onChange={setActiveTab} />

      {deepListing && (
        <ListingDetailSheet
          listing={deepListing}
          currentUser={{
            uid: user.uid,
            username: user.username,
            whatsapp: undefined,
          }}
          onClose={() => setDeepListing(null)}
          onSignedIn={handleSignedIn}
          onListingUpdated={(updated) => setDeepListing(updated)}
        />
      )}

      {showWelcome && <WelcomeSheet onDismiss={dismissWelcome} />}
    </div>
  )
}
