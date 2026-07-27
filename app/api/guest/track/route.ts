import { NextRequest, NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase-admin"

export const runtime = "nodejs"

// Public tracking lookup for guest jobs. Server-side only: guest_jobs is
// RLS-on with no public policy, so this route is the single sanctioned
// read path. Returns a sanitized payload only. Never expose recipient_phone,
// sender_phone, recipient_name, landmarks, or quote_cedis here.
// Unverified drafts (phone_verified = false) never resolve publicly:
// tracking IDs are only issued after OTP, so an unverified row is an
// abandoned draft that should stay invisible and age out via TTL.
export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get("trackingId")
  if (!raw) {
    return NextResponse.json({ error: "trackingId is required" }, { status: 400 })
  }
  const trackingId = raw.trim().toUpperCase()
  if (!/^GYM-[A-Z0-9]{6}$/.test(trackingId)) {
    return NextResponse.json({ error: "Invalid tracking ID format" }, { status: 400 })
  }

  const admin = createAdminClient()
  const { data, error } = await admin
    .from("guest_jobs")
    .select("tracking_id, pickup_area, dropoff_area, status, created_at, assigned_courier, pickup_confirmed_at, delivery_confirmed_at")
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
    },
  })
}