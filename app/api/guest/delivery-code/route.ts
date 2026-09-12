import { NextRequest, NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase-admin"
import { GuestLast4Body, parseJsonBody } from "@/lib/schemas"
import { codeFromHash } from "@/lib/delivery-code"
import { verifyLast4 } from "@/lib/last4-guard"
import { checkLimit, ipIdentifier, retryAfterHeaders } from "@/lib/rate-limit"
export const runtime = "nodejs"

// Sender-side reveal of the one-time delivery code.
//
// Authenticate-without-confirming: the sender proves themselves with the same
// last 4 digits that guard confirm-pickup and confirm-delivery, and gets the
// code back. NOTHING is stamped, no status moves, no counter ticks. A sender
// who opens this and then closes the tab has changed nothing about the job.
//
// Deliberately its own route rather than a branch inside /api/guest/track.
// Track is an unguarded public GET whose entire contract is "sanitized
// payload, no secrets"; hanging a plaintext-returning branch off it would put
// the code one boolean away from the anonymous path. This route is guarded
// from its first line and returns nothing else.
//
// POST rather than GET so the last 4 digits stay out of URLs and access logs,
// same reasoning as /api/guest/mine.
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
    .select("tracking_id, sender_phone, delivery_code_hash, last4_attempts")
    .eq("tracking_id", trackingId)
    .eq("phone_verified", true)
    .maybeSingle()
  if (error) {
    console.error("[gyema] delivery-code lookup error:", error)
    return NextResponse.json({ ok: false, reason: "lookup_failed" }, { status: 500 })
  }
  if (!data) {
    return NextResponse.json({ ok: false, reason: "not_found" }, { status: 404 })
  }

  // Last-4 guard, the same check and the same ceiling all three routes run
  // (lib/last4-guard.ts). This one must never weaken relative to the other
  // two, since it hands back a secret where they only stamp a column.
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

  // Jobs posted before this feature, and jobs nobody has accepted yet, have no
  // code. Not an error: the tracker simply has nothing to reveal.
  if (!data.delivery_code_hash) {
    return NextResponse.json({ ok: false, reason: "no_code" }, { status: 404 })
  }

  const code = codeFromHash(data.delivery_code_hash)
  if (!code) {
    // A stored hash with no preimage in the 4-digit space means the column was
    // written by something other than mintDeliveryCode. Report honestly rather
    // than pretending the job has no code.
    console.error("[gyema] delivery-code unrecoverable hash for", trackingId)
    return NextResponse.json({ ok: false, reason: "code_unavailable" }, { status: 500 })
  }

  // The hash itself never appears here, only the plaintext it stands for.
  return NextResponse.json({ ok: true, code })
}
