"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { type Listing } from "@/lib/listings"
import { getListingByTrackingIdAsync } from "@/lib/listings-async"

export function TrackTab() {
  const [trackingId, setTrackingId] = useState("")
  const [result, setResult] = useState<Listing | null | "not-found">(null)
  const [searching, setSearching] = useState(false)

  const handleTrack = async () => {
    if (!trackingId.trim() || searching) return
    setSearching(true)
    try {
      const found = await getListingByTrackingIdAsync(trackingId)
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
        <Card className="p-4 space-y-3">
          <div className="flex items-center justify-between">
            <Badge variant="secondary" className="text-xs">
              {result.kind === "trip" ? "✈️ Trip" : "📦 Package"}
            </Badge>
            <Badge variant="outline" className="text-[10px]">
              {result.status}
            </Badge>
          </div>
          <div>
            <p className="font-semibold">
              {result.fromCity} → {result.toCity}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {result.kind === "package"
                ? result.description
                : `${result.capacity || "—"}${result.notes ? ` · ${result.notes}` : ""}`}
            </p>
          </div>

          {/* V1.1 — celebratory banner for completed deliveries.
              Renders only when both parties have confirmed completion
              (status === "completed" + completedAt is set in the DB).
              Below the route info but above the posted-by metadata
              so it reads as the headline outcome of the delivery. */}
          {result.status === "completed" && (
            <div className="rounded-md bg-green-50 border border-green-200 p-3 space-y-1">
              <p className="text-sm font-semibold text-green-900">
                ✅ Delivery completed!
              </p>
              <p className="text-xs text-green-800">
                Both sender and traveller confirmed this delivery as done.
                Thanks for moving things across Gyema the safer way.
              </p>
            </div>
          )}

          <div className="flex items-center justify-between border-t pt-3">
            <p className="text-xs text-muted-foreground">Posted by</p>
            <p className="text-sm font-medium">@{result.postedByUsername}</p>
          </div>
          <p className="text-xs text-muted-foreground italic">
            Live GPS tracking coming in v2.
          </p>
        </Card>
      )}
    </div>
  )
}
