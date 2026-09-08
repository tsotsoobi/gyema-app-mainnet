import type { SupabaseClient } from "@supabase/supabase-js"
import type { CallerIdentity } from "./route-auth"

// What Gyema will and will not approve, in one place.
//
// The approve and complete routes are callbacks: Pi's SDK asks our server to
// confirm a payment, and our server calls Pi Platform back with the app's API
// key. Until now they took a paymentId and nothing else, from anybody. No
// session, no binding to a listing, no expected amount. Any caller on the
// internet could hand us an identifier and make us spend PI_API_KEY on it.
//
// This module holds the rules those routes check. It is deliberately a small
// allow list rather than a validation framework: there are exactly two kinds
// of payment this app creates, and anything that is not one of them is not a
// payment we should be approving.

export const PI_PLATFORM_BASE_URL = "https://api.minepi.com"

/** The flat connection fee, in Pi. Mirrors CONNECTION_FEE_PI in the sheet. */
export const CONNECTION_FEE_PI = 1

/** The Developer Portal checklist test payment. */
export const CHECKLIST_TEST_PI = 0.001

export type PaymentKind = "connection_fee" | "checklist_test"

export type PiPaymentRecord = {
  identifier?: string
  amount?: number
  memo?: string
  metadata?: Record<string, unknown>
  status?: Record<string, unknown>
}

export type PolicyRefusal = { ok: false; reason: string }
export type PolicyPass = { ok: true; kind: PaymentKind }
export type PolicyResult = PolicyPass | PolicyRefusal

/**
 * Read one payment back from Pi Platform.
 *
 * The point is that the CALLER does not get to describe the payment. They give
 * us an identifier; everything we then check comes from Pi, not from them.
 *
 * Returns null on any failure. The caller turns that into a refusal without
 * passing Pi's response body along: see the note on redaction in the routes.
 */
export async function fetchPiPayment(
  paymentId: string,
  apiKey: string
): Promise<PiPaymentRecord | null> {
  try {
    const res = await fetch(`${PI_PLATFORM_BASE_URL}/v2/payments/${paymentId}`, {
      method: "GET",
      headers: { Authorization: `Key ${apiKey}` },
      cache: "no-store",
    })
    if (!res.ok) {
      console.warn(`[payments-policy] payment lookup returned ${res.status}`)
      return null
    }
    return (await res.json()) as PiPaymentRecord
  } catch (error) {
    console.error("[payments-policy] payment lookup failed:", error)
    return null
  }
}

/**
 * Decide whether this caller may have this payment approved or completed.
 *
 * Three bindings, all of them checked against the payment as Pi describes it:
 *
 *   kind    metadata.type must be one this app creates.
 *   amount  must equal the amount for that kind, exactly. Not "at least":
 *           an unexpected amount is an unexpected payment, whichever way it
 *           differs.
 *   listing for a connection fee, metadata.listingId must name a listing that
 *           is currently matched to THIS caller. That is what ties a payment
 *           to a person: the fee is charged the moment they claim a listing,
 *           so at approve time the claim is theirs and nobody else's.
 *
 * A checklist test payment has no listing to bind to. It is bound by kind,
 * by amount, and by requiring a session, which is what stops it being a way
 * for anonymous callers to make the server spend its API key.
 */
export async function authorizePayment(params: {
  admin: SupabaseClient
  caller: CallerIdentity
  payment: PiPaymentRecord
  paymentId: string
}): Promise<PolicyResult> {
  const { admin, caller, payment, paymentId } = params

  if (payment.identifier && payment.identifier !== paymentId) {
    return { ok: false, reason: "identifier_mismatch" }
  }

  const metadata = (payment.metadata ?? {}) as Record<string, unknown>
  const type = metadata.type

  if (type === "checklist_test") {
    if (payment.amount !== CHECKLIST_TEST_PI) {
      return { ok: false, reason: "amount_mismatch" }
    }
    return { ok: true, kind: "checklist_test" }
  }

  if (type !== "connection_fee") {
    return { ok: false, reason: "unknown_payment_type" }
  }

  if (payment.amount !== CONNECTION_FEE_PI) {
    return { ok: false, reason: "amount_mismatch" }
  }

  const listingId = metadata.listingId
  if (!listingId || typeof listingId !== "string") {
    return { ok: false, reason: "missing_listing" }
  }

  // The listing must be claimed BY THIS CALLER. A fee is paid at the moment of
  // claiming, so a connection fee for a listing matched to somebody else, or
  // to nobody, is not a payment this app asked for.
  const { data, error } = await admin
    .from("listings")
    .select("id, matched_with_user_id")
    .eq("id", listingId)
    .maybeSingle()

  if (error) {
    console.error("[payments-policy] listing lookup failed:", error.message)
    return { ok: false, reason: "lookup_failed" }
  }
  if (!data || data.matched_with_user_id !== caller.pi_uid) {
    // Not your claim, or no such listing. One answer for both.
    return { ok: false, reason: "listing_not_claimed_by_caller" }
  }

  return { ok: true, kind: "connection_fee" }
}
