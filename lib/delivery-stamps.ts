// Delivery sign-off stamps for guest jobs.
//
// guest_jobs carries ONE (delivery_confirmed_at, delivery_confirmed_by) pair,
// but a job with a delivery code needs two independent stamps: the sender
// signing off on the tracker, and the courier entering the code at the door.
// Rather than widen the schema, delivery_confirmed_by carries a composite
// value once both have landed. delivery_confirmed_at is set by whichever
// stamp arrives first and is never overwritten, so it keeps meaning "when
// this delivery was first signed off".
//
// Three legal values, and only three. The composite is always written in this
// exact order regardless of who stamped first, so equality comparisons hold
// and neither side has to parse.
//
// Pure module: no imports, no runtime dependencies. Imported by both server
// routes and client components, unlike lib/delivery-code.ts which is
// server-only.

export const STAMP_SENDER = "sender"
export const STAMP_COURIER_CODE = "courier_code"
export const STAMP_BOTH = "sender+courier_code"

export type DeliveryStamp = typeof STAMP_SENDER | typeof STAMP_COURIER_CODE

// Whether a given side has signed off. Exact matches only, never substring:
// "sender" is a substring of the composite, and a match rule that leaned on
// that would quietly accept anything else containing it too.
export function hasStamp(
  by: string | null | undefined,
  stamp: DeliveryStamp
): boolean {
  if (!by) return false
  return by === stamp || by === STAMP_BOTH
}

// Display text for a stamp value. Legacy rows predating the delivery code
// hold a bare "sender" and read the same as they always did.
export function describeStamps(by: string | null | undefined): string | null {
  if (!by) return null
  if (by === STAMP_BOTH) return "sender and delivery code"
  if (by === STAMP_COURIER_CODE) return "delivery code"
  return by
}
