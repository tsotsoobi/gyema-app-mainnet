import { NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase-admin"

export const runtime = "nodejs"

// Open guest jobs for the Traveller board. Sanitized: quote and route only,
// never phones, landmarks, or names. Those reveal only on accept.
export async function GET() {
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