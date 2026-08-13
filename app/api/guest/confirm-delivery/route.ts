import { NextRequest, NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase-admin"
import { hashDeliveryCode, hashesMatch } from "@/lib/delivery-code"
import { STAMP_SENDER, STAMP_COURIER_CODE, hasStamp } from "@/lib/delivery-stamps"
export const runtime = "nodejs"

// Delivery sign-off for guest jobs (handshake Part 2, closing end).
//
// TWO paths, discriminated by an explicit `via` field in the body. Never by
// which optional fields happen to be present: the branch a reviewer has to
// trust should be the one they can see.
//
//   via: "sender"       last 4 digits of the sender phone, as it always was.
//                       Symmetric counterpart to confirm-pickup. Stamps
//                       delivery_confirmed_by = "sender".
//
//   via: "courier_code" the 4-digit delivery code, spoken by the recipient at
//                       the door. The courier's proof of physical presence.
//                       Stamps "courier_code". Requires the courier's session
//                       and a match against assigned_courier.
//
// Delivered gating branches on delivery_code_hash nullity:
//   null      one stamp closes the delivery, exactly as before. Jobs posted
//             before this feature are completely unaffected, down to running
//             the same UPDATE statement they always ran.
//   non-null  BOTH stamps are required, in either order. The two share one
//             (delivery_confirmed_at, delivery_confirmed_by) pair, so the
//             merge and the delivered flip happen inside a locking RPC rather
//             than a read-modify-write from here (see guest_stamp_delivery).
//
// Idempotent on re-confirm from either side. Never expose sender_phone, any
// contact field, or delivery_code_hash in any response.

// Wrong-code budget. The fifth wrong entry exhausts it; from then on the
// courier path refuses outright with a reason distinct from a wrong code, so
// the UI can stop asking rather than inviting a sixth guess. 4 digits with 5
// tries is a 1-in-2000 blind guess.
const MAX_CODE_ATTEMPTS = 5

export async function POST(req: NextRequest) {
  let body: {
    trackingId?: string
    via?: string
    last4?: string
    code?: string
    accessToken?: string
  }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, reason: "invalid_body" }, { status: 400 })
  }
  const trackingId = (body.trackingId ?? "").trim().toUpperCase()
  const via = (body.via ?? "").trim()
  const last4 = (body.last4 ?? "").trim()
  const code = (body.code ?? "").trim()
  if (!/^GYM-[A-Z0-9]{6}$/.test(trackingId)) {
    return NextResponse.json({ ok: false, reason: "invalid_tracking_id" }, { status: 400 })
  }
  // No default. An absent via is a malformed request, not a sender request:
  // inferring one would put the discriminator back in the payload shape.
  if (via !== STAMP_SENDER && via !== STAMP_COURIER_CODE) {
    return NextResponse.json({ ok: false, reason: "invalid_via" }, { status: 400 })
  }
  if (via === STAMP_SENDER && !/^[0-9]{4}$/.test(last4)) {
    return NextResponse.json({ ok: false, reason: "invalid_last4" }, { status: 400 })
  }
  if (via === STAMP_COURIER_CODE && !/^[0-9]{4}$/.test(code)) {
    return NextResponse.json({ ok: false, reason: "invalid_code" }, { status: 400 })
  }

  const admin = createAdminClient()
  const { data, error } = await admin
    .from("guest_jobs")
    .select(
      "tracking_id, status, sender_phone, assigned_courier, delivery_confirmed_at, delivery_confirmed_by, delivery_code_hash, delivery_code_attempts"
    )
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

  const coded = data.delivery_code_hash !== null

  if (via === STAMP_SENDER) {
    // Last-4 guard. Digits-tail comparison, format-proof against however the
    // sender typed their number at posting time.
    const phoneDigits = (data.sender_phone ?? "").replace(/[^0-9]/g, "")
    if (phoneDigits.length < 4 || phoneDigits.slice(-4) !== last4) {
      return NextResponse.json({ ok: false, reason: "guard_failed" }, { status: 403 })
    }
  } else {
    // Courier path. A job with no code cannot take a courier stamp.
    if (!coded) {
      return NextResponse.json({ ok: false, reason: "no_code" }, { status: 409 })
    }

    // Identity is derived server-side from the session token, never from the
    // body, same as /api/guest/mine. This is not belt-and-braces: without it
    // anyone holding a tracking ID could spend the courier's five attempts on
    // wrong guesses and lock the real courier out of their own delivery.
    if (!body.accessToken) {
      return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 })
    }
    const { data: userData, error: userErr } = await admin.auth.getUser(body.accessToken)
    if (userErr || !userData?.user) {
      return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 })
    }
    const meta = (userData.user.user_metadata ?? {}) as { pi_username?: string }
    if (!meta.pi_username) {
      return NextResponse.json({ ok: false, reason: "no_identity" }, { status: 401 })
    }
    if (!data.assigned_courier || data.assigned_courier !== meta.pi_username) {
      return NextResponse.json({ ok: false, reason: "not_assigned" }, { status: 403 })
    }

    // Budget check before the compare, so an exhausted job cannot be ground
    // down by further guessing and a correct code arriving late still refuses.
    const attempts = data.delivery_code_attempts ?? 0
    if (attempts >= MAX_CODE_ATTEMPTS) {
      return NextResponse.json(
        { ok: false, reason: "code_locked", attemptsLeft: 0 },
        { status: 403 }
      )
    }

    if (!hashesMatch(hashDeliveryCode(code), data.delivery_code_hash)) {
      // Atomic increment via RPC: a read-modify-write from here would let two
      // concurrent wrong guesses cost one attempt between them.
      const { data: bumped, error: bumpErr } = await admin.rpc(
        "guest_bump_delivery_code_attempts",
        { p_tracking_id: trackingId }
      )
      if (bumpErr) {
        console.error("[gyema] confirm-delivery attempt bump error:", bumpErr)
        return NextResponse.json({ ok: false, reason: "update_failed" }, { status: 500 })
      }
      const used = typeof bumped === "number" ? bumped : attempts + 1
      const attemptsLeft = Math.max(0, MAX_CODE_ATTEMPTS - used)
      return NextResponse.json(
        {
          ok: false,
          reason: attemptsLeft === 0 ? "code_locked" : "wrong_code",
          attemptsLeft,
        },
        { status: 403 }
      )
    }
  }

  // Idempotent: already signed off by THIS side is a success, not an error.
  // For a coded job that means checking this side's stamp specifically. The
  // old test would have read the courier's stamp as the sender's and locked
  // the sender out of a delivery they never signed for.
  if (coded) {
    if (hasStamp(data.delivery_confirmed_by, via)) {
      return NextResponse.json({ ok: true, confirmedAt: data.delivery_confirmed_at, already: true })
    }
  } else if (data.delivery_confirmed_at) {
    return NextResponse.json({ ok: true, confirmedAt: data.delivery_confirmed_at, already: true })
  }
  if (data.status !== "in_transit") {
    return NextResponse.json({ ok: false, reason: "not_confirmable" }, { status: 409 })
  }

  // Uncoded jobs: the original statement, unchanged. One stamp, no status
  // write, no RPC. Nothing about an old job's write path moves.
  if (!coded) {
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

  // Coded jobs: the merge of two stamps into one column pair, and the flip to
  // delivered once both are in, happen under a row lock inside the RPC. Doing
  // it here would race the other side stamping concurrently and lose one.
  const { data: stamped, error: rpcErr } = await admin.rpc("guest_stamp_delivery", {
    p_tracking_id: trackingId,
    p_via: via,
  })
  if (rpcErr) {
    console.error("[gyema] confirm-delivery stamp rpc error:", rpcErr)
    return NextResponse.json({ ok: false, reason: "update_failed" }, { status: 500 })
  }
  const row = Array.isArray(stamped) ? stamped[0] : stamped
  if (!row) {
    // The RPC returns no row when the job moved out of in_transit between our
    // read and the lock. Same honest answer as the uncoded zero-row case.
    return NextResponse.json({ ok: false, reason: "state_changed" }, { status: 409 })
  }
  return NextResponse.json({
    ok: true,
    confirmedAt: row.delivery_confirmed_at,
    // What the caller genuinely needs to know: whether their stamp closed the
    // delivery or whether the other side is still outstanding.
    delivered: row.status === "delivered",
    awaitingSender: !hasStamp(row.delivery_confirmed_by, STAMP_SENDER),
    awaitingCode: !hasStamp(row.delivery_confirmed_by, STAMP_COURIER_CODE),
  })
}
