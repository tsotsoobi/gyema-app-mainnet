import { getSupabaseSession } from "./pi-network"
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
  pickupConfirmedAt: string | null
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
export type OpenGuestJob = {
  kind: "guest"
  trackingId: string
  pickupArea: string
  dropoffArea: string
  packageSize: string
  whenPref: string | null
  scheduledDate: string | null
  paymentType: string | null
  quoteCedis: number | null
  createdAt: string
}

export type AcceptedGuestJob = {
  trackingId: string
  pickupArea: string
  pickupLandmark: string | null
  dropoffArea: string
  dropoffLandmark: string | null
  recipientName: string | null
  recipientPhone: string | null
  senderPhone: string
  quoteCedis: number | null
  paymentType: string | null
}

export async function getOpenGuestJobsAsync(): Promise<OpenGuestJob[]> {
  try {
    const res = await fetch("/api/guest/open")
    if (!res.ok) return []
    const body = await res.json()
    return body?.ok ? (body.jobs as OpenGuestJob[]) : []
  } catch (e) {
    console.error("[gyema] getOpenGuestJobsAsync error:", e)
    return []
  }
}

export async function acceptGuestJobAsync(input: {
  trackingId: string
  accepterWhatsapp: string
}): Promise<AcceptedGuestJob | null> {
  const session = getSupabaseSession()
  if (!session?.accessToken) {
    console.error("acceptGuestJobAsync: no active Supabase session")
    return null
  }
  try {
    const res = await fetch("/api/guest/accept", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accessToken: session.accessToken,
        trackingId: input.trackingId,
        accepterWhatsapp: input.accepterWhatsapp,
      }),
    })
    const body = await res.json()
    if (!res.ok || !body?.ok || !body.job) {
      console.warn("acceptGuestJobAsync: claim not completed:", body?.reason)
      return null
    }
    const j = body.job
    return {
      trackingId: j.tracking_id,
      pickupArea: j.pickup_area,
      pickupLandmark: j.pickup_landmark,
      dropoffArea: j.dropoff_area,
      dropoffLandmark: j.dropoff_landmark,
      recipientName: j.recipient_name,
      recipientPhone: j.recipient_phone,
      senderPhone: j.sender_phone,
      quoteCedis: j.quote_cedis,
      paymentType: j.payment_type,
    }
  } catch (err) {
    console.error("acceptGuestJobAsync error:", err)
    return null
  }
}