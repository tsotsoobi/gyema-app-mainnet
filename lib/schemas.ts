import { z } from "zod"
import { NextResponse } from "next/server"

// Request validation for every API route, in one file.
//
// zod has been a dependency since the repository was created and was imported
// nowhere: every route hand-rolled its checks, so they differed. The guest
// routes were careful (strict regexes, bounded area lists, enum checks) and the
// Pioneer routes were not (truthiness, and whatever the client sent went
// through). Phase 3 of the hardening brief closes that gap.
//
// TWO RULES THIS FILE FOLLOWS.
//
// Every field is bounded. A string with no maximum is a row a stranger can
// make arbitrarily large, and /api/guest/create takes free text from an
// unauthenticated caller. Every cap below is a number somebody has to justify,
// not a default.
//
// The refusal reason a route returns does not change. The UI branches on some
// of them and the tests assert others, so a schema failure is mapped back to
// the string that route already used (invalid_tracking_id, bad_size, and so
// on). Validation moved; the contract did not.

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/**
 * A Supabase session token.
 *
 * The security property here is the MAXIMUM: without one, a caller chooses how
 * much text the route hands to getUser. There is no meaningful minimum, and a
 * short string is not a malformed request, it is a wrong credential: it goes
 * to resolveCaller and comes back 401. Setting a minimum here would turn every
 * wrong token into a 400 and lose that distinction.
 */
export const accessToken = z.string().min(1).max(4096)

/** listing_<millis>_<6 chars>, generated client-side. Bounded, not parsed. */
export const listingId = z.string().min(1).max(128)

/** GYM- plus six upper-case alphanumerics. The one identifier a stranger types. */
export const trackingId = z
  .string()
  .transform((v) => v.trim().toUpperCase())
  .refine((v) => /^GYM-[A-Z0-9]{6}$/.test(v), { message: "invalid_tracking_id" })

/** The last four digits of a phone number: the sender side guard. */
export const last4 = z.string().trim().regex(/^[0-9]{4}$/, { message: "invalid_last4" })

/** The one-time delivery code. Same shape, different meaning, so it says so. */
export const deliveryCode = z.string().trim().regex(/^[0-9]{4}$/, { message: "invalid_code" })

/** Pi payment identifier. Opaque to us; bounded and free of path characters. */
export const piPaymentId = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/)

/** Stellar transaction hash: 64 hex characters. */
export const txid = z.string().trim().regex(/^[0-9a-fA-F]{64}$/, { message: "bad_txid" })

/**
 * A Ghanaian phone number, as a person types it.
 *
 * Accepts the two forms in use, 0244123456 and +233244123456, with spaces,
 * dashes and brackets, because that is how numbers arrive from a form on a
 * phone. Validated on the digits, not the punctuation.
 *
 * NINE DIGITS MINIMUM, and the reason is specific rather than general: the
 * last four digits of this number become the guard on three public routes
 * (lib/last4-guard.ts). A number stored with fewer than four digits creates a
 * job whose guard can never be satisfied by anybody, including its owner, and
 * that job then needs an operator to unpick. Nine is the shortest a real
 * Ghanaian number gets once a leading zero is dropped.
 *
 * Deliberately NOT normalised to E.164 here. Rewriting what a sender typed
 * would silently change the last four digits on numbers entered with a country
 * code, which is the guard. Normalisation is a migration with a backfill, not
 * a validation rule, and it is still queued.
 */
export const ghanaPhone = z
  .string()
  .trim()
  .min(9)
  .max(24)
  .refine(
    (v) => {
      const digits = v.replace(/[^0-9]/g, "")
      return digits.length >= 9 && digits.length <= 15
    },
    { message: "invalid_phone" }
  )
  .refine((v) => /^[0-9+()\s-]+$/.test(v), { message: "invalid_phone" })

/** A guest rail area name. Bounded list checked separately, in the route. */
export const areaName = z.string().trim().min(1).max(80)

/** A landmark, which is free text a courier reads at the door. */
export const landmark = z.string().trim().min(1).max(160)

/** What is in the package, in the sender's words. */
export const contentsNote = z.string().trim().min(1).max(500)

/** A person's name, as the sender writes it. */
export const personName = z.string().trim().min(1).max(80)

export const packageSize = z.enum(["small", "medium", "large"])
export const paymentType = z.enum(["cash", "momo"])
export const whenPref = z.string().trim().min(1).max(40)

/** A calendar date, YYYY-MM-DD, and a real one. */
export const isoDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => !Number.isNaN(Date.parse(v)), { message: "invalid_date" })

/** A WhatsApp number a Pioneer supplies when accepting. Same rules as a phone. */
export const whatsapp = ghanaPhone

/** A city or town on the Pioneer rail. Free text, because "Other" is an option. */
export const cityName = z.string().trim().min(1).max(80)

/** What a Pioneer writes about a trip. Optional in the form, so no minimum. */
export const listingNotes = z.string().trim().max(500)

/** What a Pioneer is sending. Required: a package with no description is not one. */
export const listingDescription = z.string().trim().min(1).max(500)

/**
 * A Pi amount a Pioneer names on their own listing.
 *
 * Bounded at both ends and required to be finite, because this arrives as
 * parseFloat output from a text input: NaN and Infinity are both one keystroke
 * away and neither is a price. The ceiling is not a policy about what a
 * delivery may cost, it is a refusal to store a number nobody typed on purpose.
 */
export const piAmount = z
  .number()
  .finite()
  .nonnegative()
  .max(10_000, { message: "bad_amount" })

/**
 * A solved Cloudflare Turnstile challenge, on its way to be verified.
 *
 * Opaque to us and never parsed here: the only authority on whether it is real
 * is Cloudflare's siteverify endpoint (lib/turnstile.ts). What this does is
 * bound it, for the same reason every other field is bounded. Cloudflare
 * documents tokens as at most 2048 characters, so anything longer is not a
 * token and there is no reason to carry it as far as an outbound request.
 *
 * OPTIONAL in the schema and required by the route, and only when both
 * Turnstile keys are set on the deployment. Making it required here would
 * refuse every guest post on any environment without Turnstile configured,
 * which includes local development and is the outage lib/turnstile.ts is
 * written to avoid.
 */
export const turnstileToken = z.string().trim().min(1).max(2048)

// ---------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------

/** Present, absent or null: the three shapes a client actually sends. */
const optional = <T extends z.ZodTypeAny>(schema: T) => schema.nullish()


export const AuthVerifyBody = z.object({
  accessToken: z.string().min(1).max(8192),
})

export const ListingActionBody = z.object({
  accessToken,
  listingId,
})

/**
 * Creating a listing. The client sends what it knows and nothing else.
 *
 * STRICT, and that is the security property rather than tidiness. Creation used
 * to be a client-side INSERT through the authed client, so the browser composed
 * the whole row: posted_by_id, posted_by_username, status, tracking_id,
 * created_at and the matched_with_* columns were all whatever it sent. The
 * database policy pinned posted_by_id to the session claim and nothing else,
 * because the INSERT grant behind it was table-wide (finding S-15).
 *
 * Every one of those fields is now derived by the route. `.strict()` means an
 * unknown key is REFUSED rather than dropped, which is what the hardening brief
 * asks for: "any client value for them rejected, not ignored". Refusing beats
 * ignoring twice over. A client that still sends posted_by_id learns it is
 * wrong instead of silently appearing to work, and a column added to this table
 * in future is closed to the client the day it is added rather than the day
 * somebody remembers to close it.
 *
 * A discriminated union on `kind`, so a trip cannot carry a package's fields
 * and the wrong combination is a 400 rather than a row with half its columns
 * null.
 */
const listingCreateCommon = {
  accessToken,
  fromCity: cityName,
  toCity: cityName,
  whatsapp,
}

export const ListingCreateBody = z.discriminatedUnion("kind", [
  z
    .object({
      ...listingCreateCommon,
      kind: z.literal("trip"),
      travelDate: isoDate,
      capacity: packageSize,
      pricePi: piAmount,
      notes: optional(listingNotes),
    })
    .strict(),
  z
    .object({
      ...listingCreateCommon,
      kind: z.literal("package"),
      deliverBy: isoDate,
      size: packageSize,
      description: listingDescription,
      offerPi: piAmount,
    })
    .strict(),
])

export const ListingAcceptBody = z.object({
  accessToken,
  listingId,
  accepterWhatsapp: optional(whatsapp),
})

// The token is optional in the SCHEMA and required by the route: an absent or
// unusable session answers 401 from resolveCaller rather than 400 from here.
// A missing credential is not a malformed request, and the client branches on
// the difference.
export const PaymentApproveBody = z.object({
  accessToken: optional(accessToken),
  paymentId: piPaymentId,
})

export const PaymentCompleteBody = z.object({
  accessToken: optional(accessToken),
  paymentId: piPaymentId,
  txid,
})

export const GuestCreateBody = z.object({
  pickupArea: areaName,
  dropoffArea: areaName,
  pickupLandmark: optional(landmark),
  dropoffLandmark: optional(landmark),
  packageSize: packageSize,
  contentsNote: optional(contentsNote),
  recipientName: optional(personName),
  recipientPhone: optional(ghanaPhone),
  senderPhone: ghanaPhone,
  whenPref: optional(whenPref),
  scheduledDate: optional(isoDate),
  paymentType: optional(paymentType),
  offList: optional(z.boolean()),
  turnstileToken: optional(turnstileToken),
})

export const GuestAcceptBody = z.object({
  accessToken,
  trackingId,
  accepterWhatsapp: optional(whatsapp),
})

export const GuestMineBody = z.object({
  accessToken,
})

export const GuestLast4Body = z.object({
  trackingId,
  last4,
})

export const GuestConfirmDeliveryBody = z
  .object({
    trackingId,
    via: z.enum(["sender", "courier_code"], { message: "invalid_via" }),
    last4: optional(last4),
    code: optional(deliveryCode),
    accessToken: optional(accessToken),
  })
  // The discriminator decides which field is required. Checking it here rather
  // than in the route keeps "which branch am I in" in one place, and the route
  // still re-reads `via` explicitly so the branch a reviewer traces is visible.
  .refine((b) => b.via !== "sender" || typeof b.last4 === "string", {
    message: "invalid_last4",
  })
  .refine((b) => b.via !== "courier_code" || typeof b.code === "string", {
    message: "invalid_code",
  })

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Map a schema failure back to the refusal reason the route already used.
 *
 * The messages carried on the primitives above are these reason strings, so a
 * field that has its own name (a tracking ID, a last-4, a via) keeps it, and
 * anything else is a bad_request. The UI branches on some of these and the
 * tests assert others: validation moved into this file, the contract did not.
 */
export function reasonFor(error: z.ZodError): string {
  const issue = error.issues[0]
  if (!issue) return "bad_request"

  // A field the server derives, sent by the client anyway. Named rather than
  // folded into bad_request because the two mean opposite things to whoever
  // reads the log: bad_request is a client that got a field wrong, this is a
  // client reaching for a field it must never set. On ListingCreateBody that
  // is the S-15 attack arriving, and it should be legible as itself.
  if (error.issues.some((i) => i.code === "unrecognized_keys")) {
    return "forbidden_field"
  }

  const named = new Set([
    "invalid_tracking_id",
    "invalid_last4",
    "invalid_code",
    "invalid_via",
    "invalid_phone",
    "invalid_date",
    "bad_txid",
  ])
  if (typeof issue.message === "string" && named.has(issue.message)) {
    return issue.message
  }

  const field = String(issue.path[0] ?? "")
  switch (field) {
    case "trackingId":
      return "invalid_tracking_id"
    case "last4":
      return "invalid_last4"
    case "code":
      return "invalid_code"
    case "via":
      return "invalid_via"
    case "txid":
      return "bad_txid"
    case "packageSize":
      return "bad_size"
    case "paymentType":
      return "bad_payment"
    case "senderPhone":
    case "recipientPhone":
    case "accepterWhatsapp":
    // A poster's own contact number on a new listing. Named here for the same
    // reason as the other three: ghanaPhone checks length before it checks
    // shape, so a number that is merely too short fails the min() rather than
    // the refine that carries the invalid_phone message, and would otherwise
    // reach the caller as a generic bad_request.
    case "whatsapp":
      return "invalid_phone"
    default:
      return "bad_request"
  }
}

export type ParseResult<T> =
  | { ok: true; data: T }
  | { ok: false; response: NextResponse }

/**
 * Read and validate a JSON body.
 *
 * A body that is not JSON and a body that does not fit the schema are
 * different failures and answer differently: invalid_body against 400, and the
 * route's own reason against 400. Neither says which field was wrong beyond
 * naming it, and none of them echo the value back.
 */
export async function parseJsonBody<T extends z.ZodTypeAny>(
  request: Request,
  schema: T
): Promise<ParseResult<z.infer<T>>> {
  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return {
      ok: false,
      response: NextResponse.json({ ok: false, reason: "invalid_body" }, { status: 400 }),
    }
  }

  const result = schema.safeParse(raw)
  if (!result.success) {
    return {
      ok: false,
      response: NextResponse.json(
        { ok: false, reason: reasonFor(result.error) },
        { status: 400 }
      ),
    }
  }

  return { ok: true, data: result.data }
}

/** The same, for a query string parameter. */
export function parseQuery<T extends z.ZodTypeAny>(
  value: string | null,
  schema: T
): ParseResult<z.infer<T>> {
  const result = schema.safeParse(value ?? undefined)
  if (!result.success) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Invalid request", reason: reasonFor(result.error) },
        { status: 400 }
      ),
    }
  }
  return { ok: true, data: result.data }
}
