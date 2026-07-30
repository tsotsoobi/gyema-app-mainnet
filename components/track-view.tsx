"use client"

import { useCallback, useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { type Listing } from "@/lib/listings"
import { getListingByTrackingIdAsync } from "@/lib/listings-async"
import { getGuestJobByTrackingIdAsync, type GuestJobView } from "@/lib/guest-jobs"
import { DeliveryTracker } from "@/components/delivery-tracker"

// Shared tracker UI for both /track (search + ?id=) and /track/[id] (path).
// initialId, when provided, auto-resolves on mount. Resolution mirrors
// track-tab.tsx: Pioneer rail (listings) first, then guest rail (guest_jobs).
export function TrackView({ initialId = "" }: { initialId?: string }) {
  const [trackingId, setTrackingId] = useState(initialId.toUpperCase())
  const [result, setResult] = useState<Listing | GuestJobView | null | "not-found">(null)
  const [searching, setSearching] = useState(false)
  const [confirmLast4, setConfirmLast4] = useState("")
  const [confirming, setConfirming] = useState(false)
  const [confirmError, setConfirmError] = useState<string | null>(null)
  const [confirmedAtLocal, setConfirmedAtLocal] = useState<string | null>(null)
  const [deliveryLast4, setDeliveryLast4] = useState("")
  const [deliveryConfirming, setDeliveryConfirming] = useState(false)
  const [deliveryError, setDeliveryError] = useState<string | null>(null)
  const [deliveryConfirmedAtLocal, setDeliveryConfirmedAtLocal] = useState<string | null>(null)

  const runLookup = useCallback(async (rawId: string) => {
    const id = rawId.trim()
    if (!id) return
    setSearching(true)
    setConfirmLast4("")
    setConfirming(false)
    setConfirmError(null)
    setConfirmedAtLocal(null)
    setDeliveryLast4("")
    setDeliveryConfirming(false)
    setDeliveryError(null)
    setDeliveryConfirmedAtLocal(null)
    try {
      const found =
        (await getListingByTrackingIdAsync(id)) ??
        (await getGuestJobByTrackingIdAsync(id))
      setResult(found ?? "not-found")
    } catch (e) {
      console.error("[gyema] Tracking lookup failed:", e)
      alert("Could not look up that tracking ID. Check your connection and try again.")
    } finally {
      setSearching(false)
    }
  }, [])

  useEffect(() => {
    if (initialId.trim()) {
      void runLookup(initialId)
    }
  }, [initialId, runLookup])

  const handleTrack = () => {
    if (!trackingId.trim() || searching) return
    void runLookup(trackingId)
  }

  return (
    <div className="min-h-screen" style={{ backgroundColor: "#FEF7E6" }}>
      <div className="p-4 md:py-8" style={{ background: "linear-gradient(90deg, #1E1B4B, #15803D)" }}>
        <div className="max-w-md md:max-w-2xl mx-auto">
          <h1 className="text-2xl md:text-3xl font-bold text-white">Gyema</h1>
          <p className="text-sm md:text-base text-white/90 mt-1">Track your delivery live.</p>
        </div>
      </div>
      <div className="h-1.5 flex">
        <div className="flex-1" style={{ backgroundColor: "#DC2626" }} />
        <div className="flex-1" style={{ backgroundColor: "#F5B800" }} />
        <div className="flex-1" style={{ backgroundColor: "#DC2626" }} />
        <div className="flex-1" style={{ backgroundColor: "#F5B800" }} />
      </div>

      <div className="px-4 py-4 md:py-8 space-y-3 max-w-md md:max-w-2xl mx-auto">
        <Card className="p-4 space-y-3">
          <div className="text-center space-y-1">
            <div className="text-4xl">{"\uD83D\uDCCD"}</div>
            <h3 className="font-semibold">Live Tracking</h3>
            <p className="text-xs text-muted-foreground">Enter a tracking ID to see status</p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="tracking">Enter Tracking ID</Label>
            <Input
              id="tracking"
              placeholder="GYM-00012A"
              value={trackingId}
              onChange={(e) => setTrackingId(e.target.value.toUpperCase())}
              className="font-mono"
            />
          </div>

          <Button className="w-full h-11" onClick={handleTrack} disabled={!trackingId.trim() || searching}>
            {searching ? "Searching..." : "Track"}
          </Button>

          <p className="text-xs text-center text-muted-foreground">
            Tip: tracking IDs are shown on every listing
          </p>
        </Card>

        {result === "not-found" && (
          <Card className="p-4 bg-red-50 border-red-200">
            <p className="text-sm text-red-900">No listing found with that tracking ID.</p>
            <p className="text-xs text-red-700 mt-1">
              Double-check the ID. Tracking IDs are case-insensitive but every character matters.
            </p>
          </Card>
        )}

        {result && result !== "not-found" && (
          <Card className="p-4 space-y-4">
            <div className="flex items-center justify-between">
              <Badge variant="secondary" className="text-xs">
                {result.kind === "trip" ? "Trip" : result.kind === "guest" ? "Guest delivery" : "Package"}
              </Badge>
              <span className="text-[10px] font-mono text-muted-foreground">{result.trackingId}</span>
            </div>

            <DeliveryTracker listing={result} />

            {result.kind === "guest" && (() => {
              const confirmedAt = confirmedAtLocal ?? result.pickupConfirmedAt
              if (confirmedAt) {
                if (result.status === "delivered" || result.status === "completed") return null
                return (
                  <div className="rounded-md p-3 space-y-1" style={{ backgroundColor: "#15803D14", border: "1px solid #15803D33" }}>
                    <p className="text-sm font-semibold" style={{ color: "#15803D" }}>Pickup confirmed</p>
                    <p className="text-xs" style={{ color: "#166534" }}>
                      You confirmed the courier collected this package.
                    </p>
                  </div>
                )
              }
              if (result.status !== "accepted") return null
              return (
                <div className="rounded-md p-3 space-y-2" style={{ backgroundColor: "#F5B80022", border: "1px solid #F5B80066" }}>
                  <p className="text-sm font-semibold">Courier collected your package?</p>
                  <p className="text-xs text-muted-foreground">
                    Confirm pickup with the last 4 digits of the phone you posted with, so only you can confirm this delivery.
                  </p>
                  <div className="space-y-1.5">
                    <Label htmlFor="confirm-last4">Last 4 digits</Label>
                    <Input
                      id="confirm-last4"
                      inputMode="numeric"
                      maxLength={4}
                      value={confirmLast4}
                      onChange={(e) => setConfirmLast4(e.target.value.replace(/[^0-9]/g, ""))}
                      placeholder="1234"
                    />
                  </div>
                  {confirmError && <p className="text-xs" style={{ color: "#DC2626" }}>{confirmError}</p>}
                  <Button
                    className="w-full"
                    disabled={confirming || confirmLast4.length !== 4}
                    onClick={async () => {
                      setConfirming(true)
                      setConfirmError(null)
                      try {
                        const res = await fetch("/api/guest/confirm-pickup", {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ trackingId: result.trackingId, last4: confirmLast4 }),
                        })
                        const body = await res.json()
                        if (body.ok) {
                          setConfirmedAtLocal(body.confirmedAt ?? new Date().toISOString())
                        } else if (body.reason === "guard_failed") {
                          setConfirmError("Those digits do not match the phone this delivery was posted with.")
                        } else if (body.reason === "not_confirmable" || body.reason === "state_changed") {
                          setConfirmError("This delivery cannot be confirmed right now. Refreshing status.")
                          void runLookup(result.trackingId)
                        } else {
                          setConfirmError("Could not confirm. Please try again.")
                        }
                      } catch {
                        setConfirmError("Network problem. Please try again.")
                      } finally {
                        setConfirming(false)
                      }
                    }}
                  >
                    {confirming ? "Confirming..." : "Confirm pickup"}
                  </Button>
                </div>
              )
            })()}
            {result.kind === "guest" && (() => {
              const deliveredAt = deliveryConfirmedAtLocal ?? result.deliveryConfirmedAt
              if (deliveredAt) {
                if (result.status === "delivered" || result.status === "completed") return null
                return (
                  <div className="rounded-md p-3 space-y-1" style={{ backgroundColor: "#15803D14", border: "1px solid #15803D33" }}>
                    <p className="text-sm font-semibold" style={{ color: "#15803D" }}>Delivery confirmed</p>
                    <p className="text-xs" style={{ color: "#166534" }}>
                      You signed off on this delivery. Thanks for moving things across Gyema the safer way.
                    </p>
                  </div>
                )
              }
              if (result.status !== "in_transit") return null
              return (
                <div className="rounded-md p-3 space-y-2" style={{ backgroundColor: "#F5B80022", border: "1px solid #F5B80066" }}>
                  <p className="text-sm font-semibold">Package arrived?</p>
                  <p className="text-xs text-muted-foreground">
                    Confirm delivery with the last 4 digits of the phone you posted with. This closes the delivery.
                  </p>
                  <div className="space-y-1.5">
                    <Label htmlFor="delivery-last4">Last 4 digits</Label>
                    <Input
                      id="delivery-last4"
                      inputMode="numeric"
                      maxLength={4}
                      value={deliveryLast4}
                      onChange={(e) => setDeliveryLast4(e.target.value.replace(/[^0-9]/g, ""))}
                      placeholder="1234"
                    />
                  </div>
                  {deliveryError && <p className="text-xs" style={{ color: "#DC2626" }}>{deliveryError}</p>}
                  <Button
                    className="w-full"
                    disabled={deliveryConfirming || deliveryLast4.length !== 4}
                    onClick={async () => {
                      setDeliveryConfirming(true)
                      setDeliveryError(null)
                      try {
                        const res = await fetch("/api/guest/confirm-delivery", {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ trackingId: result.trackingId, last4: deliveryLast4 }),
                        })
                        const body = await res.json()
                        if (body.ok) {
                          setDeliveryConfirmedAtLocal(body.confirmedAt ?? new Date().toISOString())
                        } else if (body.reason === "guard_failed") {
                          setDeliveryError("Those digits do not match the phone this delivery was posted with.")
                        } else if (body.reason === "not_confirmable" || body.reason === "state_changed") {
                          setDeliveryError("This delivery cannot be confirmed right now. Refreshing status.")
                          void runLookup(result.trackingId)
                        } else {
                          setDeliveryError("Could not confirm. Please try again.")
                        }
                      } catch {
                        setDeliveryError("Network problem. Please try again.")
                      } finally {
                        setDeliveryConfirming(false)
                      }
                    }}
                  >
                    {deliveryConfirming ? "Confirming..." : "Confirm delivery"}
                  </Button>
                </div>
              )
            })()}
            {(result.status === "completed" || result.status === "delivered") && (
              <div className="rounded-md p-3 space-y-1" style={{ backgroundColor: "#15803D14", border: "1px solid #15803D33" }}>
                <p className="text-sm font-semibold" style={{ color: "#15803D" }}>Delivery completed</p>
                <p className="text-xs" style={{ color: "#166534" }}>
                  {result.kind === "guest"
                    ? "You confirmed pickup and delivery. Thanks for moving things across Gyema the safer way."
                    : "Both sender and traveller confirmed this delivery as done. Thanks for moving things across Gyema the safer way."}
                </p>
              </div>
            )}
          </Card>
        )}
      </div>
    </div>
  )
}