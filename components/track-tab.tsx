"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { type Listing } from "@/lib/listings"
import { getListingByTrackingIdAsync } from "@/lib/listings-async"
import { getGuestJobByTrackingIdAsync, type GuestJobView } from "@/lib/guest-jobs"
import { DeliveryTracker } from "./delivery-tracker"

export function TrackTab() {
  const [trackingId, setTrackingId] = useState("")
  const [result, setResult] = useState<Listing | GuestJobView | null | "not-found">(null)
  const [searching, setSearching] = useState(false)

  const handleTrack = async () => {
    if (!trackingId.trim() || searching) return
    setSearching(true)
    try {
      const found = (await getListingByTrackingIdAsync(trackingId)) ?? (await getGuestJobByTrackingIdAsync(trackingId))
      setResult(found ?? "not-found")
    } catch (e) {
      console.error("[gyema] Tracking lookup failed:", e)
      alert("Could not look up that tracking ID. Check your connection and try again.")
    } finally {
      setSearching(false)
    }
  }

  return (
    <div className="px-4 py-4 space-y-3">
      <h2 className="text-lg font-semibold">Tracking</h2>

      <Card className="p-4 space-y-3">
        <div className="text-center space-y-1">
          <div className="text-4xl">📍</div>
          <h3 className="font-semibold">Live Tracking</h3>
          <p className="text-xs text-muted-foreground">
            Enter a tracking ID to see status
          </p>
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

        <Button
          className="w-full h-11"
          onClick={handleTrack}
          disabled={!trackingId.trim() || searching}
        >
          {searching ? "Searching..." : "Track"}
        </Button>

        <p className="text-xs text-center text-muted-foreground">
          Tip: tracking IDs are shown on every listing
        </p>
      </Card>

      {result === "not-found" && (
        <Card className="p-4 bg-red-50 border-red-200">
          <p className="text-sm text-red-900">
            No listing found with that tracking ID.
          </p>
          <p className="text-xs text-red-700 mt-1">
            Double-check the ID. Tracking IDs are case-insensitive but every
            character matters.
          </p>
        </Card>
      )}

      {result && result !== "not-found" && (
        <Card className="p-4 space-y-4">
          <div className="flex items-center justify-between">
            <Badge variant="secondary" className="text-xs">
              {result.kind === "trip" ? "Trip" : result.kind === "guest" ? "Guest delivery" : "Package"}
            </Badge>
            <span className="text-[10px] font-mono text-muted-foreground">
              {result.trackingId}
            </span>
          </div>

          <DeliveryTracker listing={result} />

          {(result.status === "completed" || result.status === "delivered") && (
            <div className="rounded-md p-3 space-y-1" style={{ backgroundColor: "#15803D14", border: "1px solid #15803D33" }}>
              <p className="text-sm font-semibold" style={{ color: "#15803D" }}>
                Delivery completed
              </p>
              <p className="text-xs" style={{ color: "#166534" }}>
                Both sender and traveller confirmed this delivery as done.
                Thanks for moving things across Gyema the safer way.
              </p>
            </div>
          )}
        </Card>
      )}
    </div>
  )
}
