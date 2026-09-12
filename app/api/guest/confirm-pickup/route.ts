import { NextRequest, NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase-admin"
import { GuestLast4Body, parseJsonBody } from "@/lib/schemas"
import { verifyLast4 } from "@/lib/last4-guard"
import { checkLimit, ipIdentifier, retryAfterHeaders } from "@/lib/rate-limit"
export const runtime = "nodejs"

// Sender-side pickup confirmation for guest jobs (handshake Part 2).
// Public endpoint; the tracking ID plus the last 4 digits of the sender
// phone form the guard (a speed bump, not auth, per the handshake spec).
// Only an accepted job can be confirmed. Idempotent on re-confirm.
// Never expose sender_phone or any contact field in any response.
export async function POST(req: NextRequest) {
  // The shared last-4 bucket: a hundred and twenty an hour per address across
  // all three sender-side routes, because they are one handshake by one
  // person. Fails OPEN on a Redis error, deliberately: the control on this
  // route is the permanent ten-attempt ceiling in lib/last4-guard.ts, which
  // lives in Postgres and does not decay, and refusing a sender at a door
  // because a cache is unreachable would cost more than it protects.
  const limit = await checkLimit("guest_last4", ipIdentifier(req))
  if (!limit.ok) {
    return NextResponse.json(
      { ok: false, reason: "rate_limited" },
      { status: 429, headers: retryAfterHeaders(limit.retryAfterSeconds) }
    )
  }

  const parsed = await parseJsonBody(req, GuestLast4Body)
  if (!parsed.ok) return parsed.response
  const { trackingId, last4 } = parsed.data

  const admin = createAdminClient()
  const { data, error } = await admin
    .from("guest_jobs")
    .select("tracking_id, status, sender_phone, pickup_confirmed_at, last4_attempts")
    .eq("tracking_id", trackingId)
    .eq("phone_verified", true)
    .maybeSingle()
  if (error) {
    console.error("[gyema] confirm-pickup lookup error:", error)
    return NextResponse.json({ ok: false, reason: "lookup_failed" }, { status: 500 })
  }
  if (!data) {
    return NextResponse.json({ ok: false, reason: "not_found" }, { status: 404 })
  }

  // Last-4 guard, with the attempt ceiling. See lib/last4-guard.ts.
  const verdict = await verifyLast4({
    admin,
    trackingId,
    senderPhone: data.sender_phone,
    attemptsSoFar: data.last4_attempts,
    last4,
  })
  if (!verdict.ok) {
    return NextResponse.json(
      { ok: false, reason: verdict.reason, attemptsLeft: verdict.attemptsLeft },
      { status: verdict.status }
    )
  }

  // Idempotent: already confirmed is a success, not an error.
  if (data.pickup_confirmed_at) {
    return NextResponse.json({ ok: true, confirmedAt: data.pickup_confirmed_at, already: true })
  }
  if (data.status !== "accepted") {
    return NextResponse.json({ ok: false, reason: "not_confirmable" }, { status: 409 })
  }

  const { data: updated, error: updErr } = await admin
    .from("guest_jobs")
    .update({ pickup_confirmed_at: new Date().toISOString(), pickup_confirmed_by: "sender" })
    .eq("tracking_id", trackingId)
    .eq("status", "accepted")
    .is("pickup_confirmed_at", null)
    .select("pickup_confirmed_at")
    .maybeSingle()
  if (updErr) {
    console.error("[gyema] confirm-pickup update error:", updErr)
    return NextResponse.json({ ok: false, reason: "update_failed" }, { status: 500 })
  }
  if (!updated) {
    // Zero-row update: state changed between read and write. Report honestly.
    return NextResponse.json({ ok: false, reason: "state_changed" }, { status: 409 })
  }
  return NextResponse.json({ ok: true, confirmedAt: updated.pickup_confirmed_at })
}
