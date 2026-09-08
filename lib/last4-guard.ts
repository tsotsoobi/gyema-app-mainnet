import type { SupabaseClient } from "@supabase/supabase-js"

// The sender side last-4 guard, in one place, with a ceiling.
//
// Three public routes are guarded by a tracking ID and the last four digits of
// the sender's phone: /api/guest/delivery-code, /api/guest/confirm-pickup and
// /api/guest/confirm-delivery on its via = "sender" path. Four digits is ten
// thousand values, and until now none of the three counted a wrong answer
// (finding S-2). A few minutes of scripted requests won the delivery code, a
// pickup confirmation and a delivery sign off on a package nobody collected.
//
// The courier code path in confirm-delivery has had a five attempt ceiling
// since 2026-08-13. This is the same mechanism for the other side of the same
// handshake: a counter column and an atomic RPC to increment it, because a
// read-modify-write from a route lets two simultaneous wrong guesses cost one
// attempt between them.
//
// Requires db/migrations/2026-09-07_last4_attempt_ceiling.sql.

/**
 * Wrong answers allowed per job, for the life of the job.
 *
 * Ten rather than the courier path's five: the courier is typing a code they
 * were told once, at a door. The sender is typing their own phone number,
 * which they may have stored with a country code they did not type it with,
 * or on an old handset, or badly on a small screen. Ten is still 1 in 1000 for
 * a blind guess.
 *
 * No decay and no reset on success. A window that reopens is a window an
 * attacker waits for. A genuine sender who exhausts it gets an operator to
 * zero the column after identifying them, which is the right amount of
 * friction for a rare event.
 */
export const MAX_LAST4_ATTEMPTS = 10

export type Last4Verdict =
  | { ok: true }
  | { ok: false; reason: "guard_locked" | "guard_failed"; attemptsLeft: number; status: 403 }

/**
 * Check the last four digits of a sender's phone, counting failures.
 *
 * Order matters and is the same as the courier path's: the budget is checked
 * BEFORE the comparison, so an exhausted job cannot be ground down further and
 * a correct answer arriving after the ceiling is still refused. That last part
 * is the point of a ceiling and the part that surprises people, so it is
 * worth being explicit: once locked, the real sender is locked out too.
 *
 * Digits are compared tail first, format-proof, because sender_phone may be
 * stored 0-prefixed or +233-prefixed. Phone normalisation is a queued item;
 * comparing digit tails is what makes this correct without it.
 */
export async function verifyLast4(params: {
  admin: SupabaseClient
  trackingId: string
  senderPhone: string | null
  attemptsSoFar: number | null
  last4: string
}): Promise<Last4Verdict> {
  const { admin, trackingId, senderPhone, attemptsSoFar, last4 } = params

  const attempts = attemptsSoFar ?? 0
  if (attempts >= MAX_LAST4_ATTEMPTS) {
    return { ok: false, reason: "guard_locked", attemptsLeft: 0, status: 403 }
  }

  const phoneDigits = (senderPhone ?? "").replace(/[^0-9]/g, "")
  const matches = phoneDigits.length >= 4 && phoneDigits.slice(-4) === last4

  if (matches) {
    return { ok: true }
  }

  // Atomic increment. A read-modify-write here would let two concurrent wrong
  // guesses cost one attempt between them.
  const { data: bumped, error } = await admin.rpc("guest_bump_last4_attempts", {
    p_tracking_id: trackingId,
  })

  if (error) {
    // The counter is the control. If it cannot be incremented, refuse rather
    // than allowing an uncounted guess: failing open here would restore
    // exactly the unlimited guessing this exists to stop.
    console.error("[last4-guard] attempt bump failed:", error.message)
    return { ok: false, reason: "guard_failed", attemptsLeft: 0, status: 403 }
  }

  const used = typeof bumped === "number" ? bumped : attempts + 1
  const attemptsLeft = Math.max(0, MAX_LAST4_ATTEMPTS - used)

  return {
    ok: false,
    reason: attemptsLeft === 0 ? "guard_locked" : "guard_failed",
    attemptsLeft,
    status: 403,
  }
}
