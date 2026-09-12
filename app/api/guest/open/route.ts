import { NextRequest, NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase-admin"
import { checkLimit, ipIdentifier, retryAfterHeaders } from "@/lib/rate-limit"

export const runtime = "nodejs"

// Open guest jobs for the Traveller board. Sanitized: quote and route only,
// never phones, landmarks, or names. Those reveal only on accept.
export async function GET(request: NextRequest) {
  // Sixty per ten minutes per address, and it fails open on a Redis error.
  // The payload carries nothing sensitive, so the only thing a limit protects
  // here is the database read: refusing a courier their job board to save a
  // query would be the wrong trade.
  const limit = await checkLimit("guest_open", ipIdentifier(request))
  if (!limit.ok) {
    return NextResponse.json(
      { ok: false, reason: "rate_limited" },
      { status: 429, headers: retryAfterHeaders(limit.retryAfterSeconds) }
    )
  }

  try {
    const admin = createAdminClient()
    const { data, error } = await admin
      .from("guest_jobs")
      .select("tracking_id, pickup_area, dropoff_area, package_size, when_pref, scheduled_date, payment_type, quote_cedis, created_at")
      .eq("phone_verified", true)
      .eq("status", "posted")
      .is("assigned_courier", null)
      .order("created_at", { ascending: false })
      .limit(20)
    if (error) {
      console.error("[gyema] guest open jobs error:", error)
      return NextResponse.json({ ok: false }, { status: 500 })
    }
    return NextResponse.json({
      ok: true,
      jobs: (data ?? []).map((j) => ({
        kind: "guest",
        trackingId: j.tracking_id,
        pickupArea: j.pickup_area,
        dropoffArea: j.dropoff_area,
        packageSize: j.package_size,
        whenPref: j.when_pref,
        scheduledDate: j.scheduled_date,
        paymentType: j.payment_type,
        quoteCedis: j.quote_cedis,
        createdAt: j.created_at,
      })),
    })
  } catch (err) {
    console.error("[gyema] guest open jobs error:", err)
    return NextResponse.json({ ok: false }, { status: 500 })
  }
}