import { NextRequest, NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase-admin"
export const runtime = "nodejs"

// Sender-side delivery sign-off for guest jobs (handshake Part 2, closing end).
// Symmetric counterpart to confirm-pickup: the same tracking ID plus the last 4
// digits of the sender phone guard both ends of custody (a speed bump, not auth).
// Only an in_transit job can be signed off. Idempotent on re-confirm.
// Never expose sender_phone or any contact field in any response.
export async function POST(req: NextRequest) {
  let body: { trackingId?: string; last4?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, reason: "invalid_body" }, { status: 400 })
  }
  const trackingId = (body.trackingId ?? "").trim().toUpperCase()
  const last4 = (body.last4 ?? "").trim()
  if (!/^GYM-[A-Z0-9]{6}$/.test(trackingId)) {
    return NextResponse.json({ ok: false, reason: "invalid_tracking_id" }, { status: 400 })
  }
  if (!/^[0-9]{4}$/.test(last4)) {
    return NextResponse.json({ ok: false, reason: "invalid_last4" }, { status: 400 })
  }

  const admin = createAdminClient()
  const { data, error } = await admin
    .from("guest_jobs")
    .select("tracking_id, status, sender_phone, delivery_confirmed_at")
    .eq("tracking_id", trackingId)
    .eq("phone_verified", true)
    .maybeSingle()
  if (error) {
    console.error("[gyema] confirm-delivery lookup error:", error)
    return NextResponse.json({ ok: false, reason: "lookup_failed" }, { status: 500 })
  }
  if (!data) {
    return NextResponse.json({ ok: false, reason: "not_found" }, { status: 404 })
  }

  // Last-4 guard. Digits-tail comparison, format-proof against however the
  // sender typed their number at posting time.
  const phoneDigits = (data.sender_phone ?? "").replace(/[^0-9]/g, "")
  if (phoneDigits.length < 4 || phoneDigits.slice(-4) !== last4) {
    return NextResponse.json({ ok: false, reason: "guard_failed" }, { status: 403 })
  }

  // Idempotent: already signed off is a success, not an error.
  if (data.delivery_confirmed_at) {
    return NextResponse.json({ ok: true, confirmedAt: data.delivery_confirmed_at, already: true })
  }
  if (data.status !== "in_transit") {
    return NextResponse.json({ ok: false, reason: "not_confirmable" }, { status: 409 })
  }

  const { data: updated, error: updErr } = await admin
    .from("guest_jobs")
    .update({ delivery_confirmed_at: new Date().toISOString(), delivery_confirmed_by: "sender" })
    .eq("tracking_id", trackingId)
    .eq("status", "in_transit")
    .is("delivery_confirmed_at", null)
    .select("delivery_confirmed_at")
    .maybeSingle()
  if (updErr) {
    console.error("[gyema] confirm-delivery update error:", updErr)
    return NextResponse.json({ ok: false, reason: "update_failed" }, { status: 500 })
  }
  if (!updated) {
    // Zero-row update: state changed between read and write. Report honestly.
    return NextResponse.json({ ok: false, reason: "state_changed" }, { status: 409 })
  }
  return NextResponse.json({ ok: true, confirmedAt: updated.delivery_confirmed_at })
}
