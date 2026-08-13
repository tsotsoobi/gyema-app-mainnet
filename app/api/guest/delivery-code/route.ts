import { NextRequest, NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase-admin"
import { codeFromHash } from "@/lib/delivery-code"
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
    .select("tracking_id, sender_phone, delivery_code_hash")
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

  // Last-4 guard, byte-for-byte the check both confirm routes run: digits-tail
  // comparison, format-proof against however the sender typed their number.
  // This guard must never weaken relative to those two, since this route hands
  // back a secret where they only stamp a column.
  const phoneDigits = (data.sender_phone ?? "").replace(/[^0-9]/g, "")
  if (phoneDigits.length < 4 || phoneDigits.slice(-4) !== last4) {
    return NextResponse.json({ ok: false, reason: "guard_failed" }, { status: 403 })
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
