import { NextRequest, NextResponse } from "next/server"
import { randomBytes } from "crypto"
import { createAdminClient } from "@/lib/supabase-admin"
import { ListingCreateBody, parseJsonBody } from "@/lib/schemas"
import { resolveCaller } from "@/lib/route-auth"

// Create a listing. The server composes the row; the client sends its contents.
//
// WHY THIS ROUTE EXISTS (finding S-15)
//
// Creation was a client-side INSERT through the authed client, so the browser
// composed the whole row. The catalog carries an INSERT policy,
// listings_insert_own, whose WITH CHECK pins posted_by_id to
// auth.jwt() -> app_metadata ->> pi_uid, and that genuinely closed
// impersonation at the id level: one Pioneer could not attribute a listing to
// another Pioneer's uid.
//
// It closed one column. The grant behind it is table-wide
// (db/migrations/2026-09-07_grant_baseline.sql: grant insert on public.listings
// to authenticated), so the policy was the only filter on the insert and it
// filtered exactly one field. Five things were still whatever the client sent,
// and each is now derived here or refused:
//
//   1. tracking_id      chosen freely, and unchecked against anything. No
//                       constraint can span two tables, and BOTH trackers
//                       resolve listings before guest jobs, so a listing
//                       carrying an existing guest job's code shadowed that
//                       delivery on the public tracker. A sender following
//                       their parcel saw somebody else's listing. That is
//                       invariant 3, the two rails never blend, broken from
//                       the Pioneer side, and it is the reason this route was
//                       written first rather than the grant being narrowed.
//   2. matched_with_*   settable at insert, so a row could arrive already
//                       matched to a victim and appear in their My Activity as
//                       a job they never accepted, carrying a phone number the
//                       author chose.
//   3. posted_by_username  unconstrained by the policy, which pins only the
//                       id. A Pioneer could post under their own uid and
//                       another Pioneer's name. Not an authorization bypass,
//                       since every listings route decides on pi_uid, but
//                       CLAUDE.md invariant 7 names pi_username the identity
//                       anchor and it is the field a human reads.
//   4. status           settable to completed or in_transit at insert,
//                       bypassing every transition guard the sibling routes in
//                       this directory exist to enforce.
//   5. created_at       future-datable, and the open feed orders by it
//                       descending, so one row could sit at the top of it
//                       indefinitely.
//
// The pattern is the one cancel-open, cancel-matched and mark-in-transit
// already follow, and the one the guest rail has followed since it was written:
// identity from the session, never from the body.
//
// AFTER THIS SHIPS, authenticated needs no INSERT on listings at all. The
// revoke is db/migrations/2026-09-11_listings_create_server_side.sql, applied
// by hand, and it is what makes this route the only way a listing is created
// rather than the preferred one.

export const runtime = "nodejs"

/**
 * Columns returned to the client after a successful insert.
 *
 * Deliberately never a select("*"), and the two omissions are the point:
 * `whatsapp` and `matched_with_whatsapp` are contact details that reveal only
 * through the counterpart RPC, which checks who is asking. This list mirrors
 * LISTING_COLUMNS in lib/listings-async.ts, which the client's row mapper
 * expects. That file is a browser module and importing it here would pull the
 * Pi SDK into a server route, so the list is repeated rather than shared, and
 * the two are kept in step by hand.
 */
const RETURNED_COLUMNS = [
  "id",
  "kind",
  "from_city",
  "to_city",
  "posted_by_id",
  "posted_by_username",
  "status",
  "tracking_id",
  "created_at",
  "travel_date",
  "capacity",
  "price_pi",
  "notes",
  "deliver_by",
  "size",
  "description",
  "offer_pi",
  "matched_with_user_id",
  "matched_with_username",
  "matched_at",
  "sender_confirmed",
  "traveller_confirmed",
  "completed_at",
  "archived_at",
  "archived_by_matched_at",
].join(", ")

/** How many times to try for a free tracking ID before giving up. */
const MAX_ID_ATTEMPTS = 8

/**
 * GYM- plus six upper-case hex characters.
 *
 * The same shape the rail has always used, so nothing downstream changes: the
 * regex in lib/schemas.ts, the deep links, the dispatch templates and every
 * stored ID all still match. What changes is the source. It was
 * Math.random().toString(16), which is finding S-17: a tracking ID is the entry
 * ticket to every public guest route and Math.random is predictable from prior
 * output. randomBytes is the same one line and is not.
 */
function mintTrackingId(): string {
  return `GYM-${randomBytes(3).toString("hex").toUpperCase()}`
}

/** listing_<millis>_<6 chars>, the existing id shape, from a CSPRNG. */
function mintListingId(): string {
  return `listing_${Date.now()}_${randomBytes(3).toString("hex")}`
}

/**
 * A tracking ID free on BOTH rails.
 *
 * The guest rail has always checked both tables when minting
 * (app/api/guest/create/route.ts). The Pioneer rail checked neither, which was
 * survivable while the ID was random and fatal once the client could choose it.
 * Checking both here is what actually keeps one ID pointing at one row across a
 * boundary no database constraint can see.
 */
async function generateUniqueTrackingId(
  admin: ReturnType<typeof createAdminClient>
): Promise<string | null> {
  for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt++) {
    const code = mintTrackingId()
    const [{ data: listing }, { data: guest }] = await Promise.all([
      admin.from("listings").select("tracking_id").eq("tracking_id", code).maybeSingle(),
      admin.from("guest_jobs").select("tracking_id").eq("tracking_id", code).maybeSingle(),
    ])
    if (!listing && !guest) return code
  }
  return null
}

export async function POST(request: NextRequest) {
  try {
    // ListingCreateBody is strict, so a body carrying posted_by_id, status,
    // tracking_id, created_at or any matched_with_* field is refused here with
    // reason "forbidden_field" rather than having those fields quietly dropped.
    const parsed = await parseJsonBody(request, ListingCreateBody)
    if (!parsed.ok) return parsed.response
    const body = parsed.data

    const admin = createAdminClient()

    // Identity from the verified session, never from the body. resolveCaller
    // reads app_metadata, which only the service-role key can write, so both
    // the uid and the username are values the caller could not choose.
    const caller = await resolveCaller(admin, body.accessToken)
    if (!caller) {
      return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 })
    }

    const trackingId = await generateUniqueTrackingId(admin)
    if (!trackingId) {
      return NextResponse.json(
        { ok: false, reason: "id_generation_failed" },
        { status: 500 }
      )
    }

    // Everything the server owns, in one place. matched_with_user_id,
    // matched_with_username, matched_with_whatsapp, matched_at,
    // sender_confirmed, traveller_confirmed and completed_at are deliberately
    // ABSENT rather than set to null: they take their database defaults, and a
    // row is never born matched or confirmed. The accept route is the only
    // thing that writes them.
    const serverOwned = {
      id: mintListingId(),
      posted_by_id: caller.pi_uid,
      posted_by_username: caller.pi_username,
      status: "open" as const,
      tracking_id: trackingId,
      created_at: new Date().toISOString(),
    }

    // Typed as a plain record on purpose. The two branches are different column
    // sets, and supabase-js infers the insert argument from the first one, so a
    // union here is rejected for not being the trip shape. The same trade the
    // read paths already make when they cast a joined column constant.
    const row: Record<string, unknown> =
      body.kind === "trip"
        ? {
            ...serverOwned,
            kind: "trip" as const,
            from_city: body.fromCity,
            to_city: body.toCity,
            whatsapp: body.whatsapp,
            travel_date: body.travelDate,
            capacity: body.capacity,
            price_pi: body.pricePi,
            notes: body.notes ?? null,
          }
        : {
            ...serverOwned,
            kind: "package" as const,
            from_city: body.fromCity,
            to_city: body.toCity,
            whatsapp: body.whatsapp,
            deliver_by: body.deliverBy,
            size: body.size,
            description: body.description,
            offer_pi: body.offerPi,
          }

    const { data, error } = await admin
      .from("listings")
      .insert(row)
      .select(RETURNED_COLUMNS)
      .single()

    if (error) {
      // 23505 is a unique violation. Once the unique index on tracking_id in
      // the accompanying migration exists, this is the race that the eight
      // attempts above cannot see: two requests minting the same ID between
      // one another's check and insert. Rare enough to answer honestly rather
      // than retry, and the caller simply posts again.
      console.error("[gyema] listings create insert error:", error.message)
      return NextResponse.json({ ok: false, reason: "insert_failed" }, { status: 500 })
    }

    console.log("[gyema] listing created", {
      kind: row.kind,
      tracking_id: trackingId,
      posted_by: caller.pi_username,
    })

    return NextResponse.json({ ok: true, listing: data })
  } catch (err) {
    console.error("[gyema] listings create route error:", err)
    return NextResponse.json({ ok: false, reason: "server_error" }, { status: 500 })
  }
}
