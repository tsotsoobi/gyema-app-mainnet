"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { signInAndPersist, type PiUser } from "@/lib/pi-network"

// Guest-mode gate shown in place of a post form when the current user
// is browsing as a guest. Posting on Gyema requires a Pi identity — this
// CTA explains why and offers the upgrade in-place.
//
// Used by:
//   - home-tab.tsx (TravellerHome + SenderHome post forms)
//   - trips-tab.tsx (RegisterTripForm)
//
// The detail-sheet has its own variant (GuestActionGate) with slightly
// different copy because the action verb is "accept" rather than "post".
export function GuestPostGate({
  context,
  onSignedIn,
}: {
  context: "trip" | "package"
  onSignedIn: (user: PiUser) => void
}) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")

  const handleSignIn = async () => {
    setError("")
    setLoading(true)
    try {
      const user = await signInAndPersist()
      onSignedIn(user)
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Sign-in failed. Please try again."
      console.error("[gyema] Guest sign-in upgrade failed:", err)
      setError(message)
    } finally {
      setLoading(false)
    }
  }

  const headline =
    context === "trip"
      ? "Register your trip on Gyema"
      : "Post your delivery on Gyema"

  return (
    <Card className="p-5 space-y-4 border-primary/40 bg-primary/5">
      <div className="space-y-2">
        <h3 className="font-semibold text-base">{headline}</h3>
        <p className="text-sm text-muted-foreground leading-relaxed">
          Posting on Gyema requires a Pi identity. This keeps every trip and
          delivery traceable to a real Pioneer.
        </p>
      </div>

      {error && (
        <div className="rounded-md bg-red-50 border border-red-200 p-3 text-xs text-red-900">
          {error}
        </div>
      )}

      <Button
        className="w-full h-12 text-base font-semibold"
        onClick={handleSignIn}
        disabled={loading}
      >
        {loading ? "Signing in…" : "Sign in with Pi"}
      </Button>

      {context === "package" && (
        <a href="/send" className="block">
          <Button variant="outline" className="w-full h-11">
            Post delivery as guest
          </Button>
        </a>
      )}
      <p className="text-[11px] text-muted-foreground text-center">
        You can keep browsing as a guest. Sign-in is only required to post.
      </p>
    </Card>
  )
}
