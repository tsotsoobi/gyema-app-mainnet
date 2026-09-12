import { NextRequest, NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase-admin"
import { parseQuery, trackingId as trackingIdSchema } from "@/lib/schemas"
import { checkLimit, ipIdentifier, retryAfterHeaders } from "@/lib/rate-limit"

export const runtime = "nodejs"

// Public tracking lookup for guest jobs. Server-side only: guest_jobs is
// RLS-on with no public policy, so this route is the single sanctioned
// read path. Returns a sanitized payload only. Never expose recipient_phone,
// sender_phone, recipient_name, landmarks, or quote_cedis here.
//
// delivery_code_hash is selected but NEVER emitted: this payload is
// anonymous, and over a 4-digit space the hash is the code. Only its nullity
// leaves, as hasDeliveryCode, so the tracker knows whether a code exists to
// reveal. The plaintext lives behind the last-4 guard on
// /api/guest/delivery-code and nowhere else.
// Unverified drafts (phone_verified = false) never resolve publicly. The flag
// is set by the operator by hand in the Supabase dashboard after matching the
// sender's WhatsApp message to the row; there is no OTP step and no route that
// writes it. An unverified row is therefore either an unmatched draft or an
// abandoned one, and either way it stays invisible and ages out via TTL.
export async function GET(req: NextRequest) {
  // A hundred and twenty per ten minutes per address, failing open on a Redis
  // error. Nothing polls this route, so every call is a person pressing Track
  // or opening a deep link; the limit exists to make scanning for valid GYM-
  // IDs pointless rather than to ration lookups.
  //
  // Keyed on the address ONLY, never on the tracking ID, and that is a
  // decision rather than an omission. A per-job window here would let anyone
  // who knows a tracking ID spend it and leave the real sender unable to look
  // up their own delivery. The job is the victim in that design, not the
  // attacker.
  const limit = await checkLimit("guest_track", ipIdentifier(req))
  if (!limit.ok) {
    // A distinct status and reason, because the client must not read this as
    // "no such job": the tracker turns a 404 into "not found", and telling a
    // waiting sender their delivery does not exist is the worst possible way
    // to report a rate limit.
    return NextResponse.json(
      { error: "Too many lookups", reason: "rate_limited" },
      { status: 429, headers: retryAfterHeaders(limit.retryAfterSeconds) }
    )
  }

  const parsed = parseQuery(req.nextUrl.searchParams.get("trackingId"), trackingIdSchema)
  if (!parsed.ok) return parsed.response
  const trackingId = parsed.data

  const admin = createAdminClient()
  const { data, error } = await admin
    .from("guest_jobs")
    .select("tracking_id, pickup_area, dropoff_area, status, created_at, assigned_courier, pickup_confirmed_at, delivery_confirmed_at, delivery_confirmed_by, delivery_code_hash")
    .eq("tracking_id", trackingId)
    .eq("phone_verified", true)
    .maybeSingle()

  if (error) {
    console.error("[gyema] guest track lookup error:", error)
    return NextResponse.json({ error: "Lookup failed" }, { status: 500 })
  }
  if (!data) {
    return NextResponse.json({ found: false }, { status: 404 })
  }

  return NextResponse.json({
    found: true,
    job: {
      kind: "guest",
      trackingId: data.tracking_id,
      pickupArea: data.pickup_area,
      dropoffArea: data.dropoff_area,
      status: data.status,
      createdAt: data.created_at,
      assignedCourier: data.assigned_courier,
      pickupConfirmedAt: data.pickup_confirmed_at,
      deliveryConfirmedAt: data.delivery_confirmed_at,
      // Which sides have signed off. On a coded job delivery_confirmed_at
      // alone no longer means "the sender confirmed": the courier may have
      // stamped first, and the tracker must not read that as the sender's
      // own sign-off and withdraw their confirm button.
      deliveryConfirmedBy: data.delivery_confirmed_by,
      hasDeliveryCode: data.delivery_code_hash !== null,
    },
  })
}