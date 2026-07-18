"use client"

import { Suspense, useCallback, useEffect, useState } from "react"
import { useSearchParams } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { type Listing } from "@/lib/listings"
import { getListingByTrackingIdAsync } from "@/lib/listings-async"
import { getGuestJobByTrackingIdAsync, type GuestJobView } from "@/lib/guest-jobs"
import { DeliveryTracker } from "@/components/delivery-tracker"

// Public tracking route. Reachable at /track (manual search) and
// /track?id=GYM-XXXXXX (auto-resolves and renders on load). This is the
// routed surface WhatsApp/dispatch templates deep-link to; the Track TAB on
// the home page stays unchanged. Resolution mirrors track-tab.tsx exactly:
// Pioneer rail first (listings), then guest rail (guest_jobs).
function TrackContent() {
  const searchParams = useSearchParams()
  const idParam = searchParams.get("id") ?? ""

  const [trackingId, setTrackingId] = useState(idParam.toUpperCase())
  const [result, setResult] = useState<Listing | GuestJobView | null | "not-found">(null)
  const [searching, setSearching] = useState(false)

  const runLookup = useCallback(async (rawId: string) => {
    const id = rawId.trim()
    if (!id) return
    setSearching(true)
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
    if (idParam.trim()) {
      void runLookup(idParam)
    }
  }, [idParam, runLookup])

  const handleTrack = () => {
    if (!trackingId.trim() || searching) return
    void runLookup(trackingId)
  }

  return (
    <div className="px-4 py-4 space-y-3 max-w-md mx-auto">
      <h2 className="text-lg font-semibold">Tracking</h2>

      <Card className="p-4 space-y-3">
        <div className="text-center space-y-1">
          <div className="text-4xl">{"\uD83D\uDCCD"}</div>
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

          {result.status === "completed" && (
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

export default function TrackPage() {
  return (
    <Suspense fallback={<div className="px-4 py-4 text-sm text-muted-foreground">Loading tracker...</div>}>
      <TrackContent />
    </Suspense>
  )
}