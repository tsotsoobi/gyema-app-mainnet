import { NextRequest, NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase-admin"
import { parseQuery, trackingId as trackingIdSchema } from "@/lib/schemas"

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