import { getSupabaseSession } from "./pi-network"
import { STAMP_COURIER_CODE } from "./delivery-stamps"
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
  deliveryConfirmedAt: string | null
  // Which sides have signed off delivery, and whether this job carries a
  // one-time delivery code at all. Never the hash: /api/guest/track emits
  // nullity only. Optional on the type because a cached older payload will
  // not carry them.
  deliveryConfirmedBy?: string | null
  hasDeliveryCode?: boolean
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
// Sender-side reveal of the one-time delivery code, guarded by the same last
// 4 digits as the confirm routes. Reading it stamps nothing.
export type DeliveryCodeReveal =
  | { ok: true; code: string }
  | { ok: false; reason: string }

export async function revealDeliveryCodeAsync(input: {
  trackingId: string
  last4: string
}): Promise<DeliveryCodeReveal> {
  try {
    const res = await fetch("/api/guest/delivery-code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        trackingId: input.trackingId.trim().toUpperCase(),
        last4: input.last4,
      }),
    })
    const body = await res.json()
    if (body?.ok && typeof body.code === "string") {
      return { ok: true, code: body.code }
    }
    return { ok: false, reason: typeof body?.reason === "string" ? body.reason : "failed" }
  } catch (e) {
    console.error("[gyema] revealDeliveryCodeAsync error:", e)
    return { ok: false, reason: "network" }
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
  quoteCedis: number | null
  paymentType: string | null
}

// A guest job as its assigned courier sees it, for the persistent My Activity
// surface. Carries NO senderPhone, because /api/guest/mine never selects that
// column. Neither does the accept-sheet reveal: no courier-facing shape holds
// the sender's phone, since the public tracker guards both sender
// confirmations with its last four digits.
export type CourierGuestJob = {
  kind: "guest"
  trackingId: string
  pickupArea: string
  pickupLandmark: string | null
  dropoffArea: string
  dropoffLandmark: string | null
  packageSize: string
  recipientName: string | null
  recipientPhone: string | null
  quoteCedis: number | null
  paymentType: string | null
  whenPref: string | null
  scheduledDate: string | null
  status: GuestJobStatus
  pickupConfirmedAt: string | null
  pickupConfirmedBy: string | null
  deliveryConfirmedAt: string | null
  deliveryConfirmedBy: string | null
  // Whether this job has a one-time delivery code, so the card knows to ask
  // for one. Nullity only, never the hash: a courier holding the hash of a
  // 4-digit code holds the code.
  hasDeliveryCode: boolean
}

// Jobs assigned to the signed-in courier. Identity is never sent: the route
// derives it from the session token server-side and matches assigned_courier
// against the verified pi_username. Guests have no session and so get [].
export async function getMyGuestJobsAsync(): Promise<CourierGuestJob[]> {
  const session = getSupabaseSession()
  if (!session?.accessToken) return []
  try {
    const res = await fetch("/api/guest/mine", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accessToken: session.accessToken }),
    })
    if (!res.ok) {
      console.error("[gyema] getMyGuestJobsAsync failed:", res.status)
      return []
    }
    const body = await res.json()
    return body?.ok ? (body.jobs as CourierGuestJob[]) : []
  } catch (e) {
    console.error("[gyema] getMyGuestJobsAsync error:", e)
    return []
  }
}

// The courier entering the delivery code the recipient read out at the door.
// The one write the courier card makes. Identity travels as the session token
// and is resolved server-side against assigned_courier, exactly as /mine does:
// the route will not spend this job's attempt budget for anyone else.
export type DeliveryCodeSubmit =
  | { ok: true; delivered: boolean }
  | { ok: false; reason: string; attemptsLeft?: number }

export async function submitDeliveryCodeAsync(input: {
  trackingId: string
  code: string
}): Promise<DeliveryCodeSubmit> {
  const session = getSupabaseSession()
  if (!session?.accessToken) {
    return { ok: false, reason: "unauthorized" }
  }
  try {
    const res = await fetch("/api/guest/confirm-delivery", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        trackingId: input.trackingId,
        via: STAMP_COURIER_CODE,
        code: input.code,
        accessToken: session.accessToken,
      }),
    })
    const body = await res.json()
    if (body?.ok) return { ok: true, delivered: body.delivered === true }
    return {
      ok: false,
      reason: typeof body?.reason === "string" ? body.reason : "failed",
      attemptsLeft: typeof body?.attemptsLeft === "number" ? body.attemptsLeft : undefined,
    }
  } catch (e) {
    console.error("[gyema] submitDeliveryCodeAsync error:", e)
    return { ok: false, reason: "network" }
  }
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
      quoteCedis: j.quote_cedis,
      paymentType: j.payment_type,
    }
  } catch (err) {
    console.error("acceptGuestJobAsync error:", err)
    return null
  }
}