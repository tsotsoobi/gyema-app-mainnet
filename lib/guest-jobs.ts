// Client-side lookup for guest jobs, via the sanitized server read route.
// The guest rail has no anon Supabase surface by design; this fetch wrapper
// is the only way client code reads a guest job.

export type GuestJobStatus =
  | "posted"
  | "accepted"
  | "in_transit"
  | "delivered"
  | "cancelled"
  | "expired"

export type GuestJobView = {
  kind: "guest"
  trackingId: string
  pickupArea: string
  dropoffArea: string
  status: GuestJobStatus
  createdAt: string
  assignedCourier: string | null
}

export async function getGuestJobByTrackingIdAsync(
  trackingId: string
): Promise<GuestJobView | null> {
  const id = trackingId.trim().toUpperCase()
  if (!id) return null
  try {
    const res = await fetch(`/api/guest/track?trackingId=${encodeURIComponent(id)}`)
    if (res.status === 404) return null
    if (!res.ok) {
      console.error("[gyema] guest track fetch failed:", res.status)
      return null
    }
    const body = await res.json()
    return body?.found ? (body.job as GuestJobView) : null
  } catch (e) {
    console.error("[gyema] guest track fetch error:", e)
    return null
  }
}