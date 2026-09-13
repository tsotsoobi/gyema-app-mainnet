import { getAnonClient, getAuthedClient } from "./supabase"
import { getSupabaseSession } from "./pi-network"
import type { Listing, ListingStatus, PackageSize } from "./listings"

// Database row shape (snake_case, as stored in Supabase)
type ListingRow = {
  id: string
  kind: "trip" | "package"
  from_city: string
  to_city: string
  posted_by_id: string
  posted_by_username: string
  status: "open" | "expired" | "matched" | "in_transit" | "completed"
  tracking_id: string
  created_at: string
  // Trip-only
  travel_date: string | null
  capacity: string | null
  price_pi: number | null
  notes: string | null
  // Package-only
  deliver_by: string | null
  size: string | null
  description: string | null
  offer_pi: number | null
  // v2 — Accept / Mark Complete
  matched_with_user_id: string | null
  matched_with_username: string | null
  matched_at: string | null
  sender_confirmed: boolean
  traveller_confirmed: boolean
  completed_at: string | null
  archived_at: string | null
  archived_by_matched_at: string | null
}

// Convert a Supabase row → app-shaped Listing (camelCase)
function fromRow(row: ListingRow): Listing {
  const base = {
    id: row.id,
    trackingId: row.tracking_id,
    postedById: row.posted_by_id,
    postedByUsername: row.posted_by_username,
    status: row.status,
    fromCity: row.from_city,
    toCity: row.to_city,
    createdAt: row.created_at,
    // v2 fields surface as nullable values from the DB
    matchedWithUserId: row.matched_with_user_id,
    matchedWithUsername: row.matched_with_username,
    matchedAt: row.matched_at,
    senderConfirmed: row.sender_confirmed,
    travellerConfirmed: row.traveller_confirmed,
    completedAt: row.completed_at,
  }

  if (row.kind === "trip") {
    return {
      ...base,
      kind: "trip",
      travelDate: row.travel_date ?? "",
      capacity: (row.capacity as PackageSize) ?? "small",
      pricePi: row.price_pi ?? 0,
      notes: row.notes ?? "",
    } as Listing
  }

  return {
    ...base,
    kind: "package",
    deliverBy: row.deliver_by ?? "",
    size: (row.size as PackageSize) ?? "small",
    description: row.description ?? "",
    offerPi: row.offer_pi ?? 0,
  } as Listing
}

// ---- Read paths ----
//
// EVERY read names its columns. select("*") is not available any more and
// that is deliberate on both sides of the boundary:
//
//   In the database, db/migrations/2026-09-07_grant_baseline.sql gives anon
//   and authenticated column level SELECT on listings with whatsapp and
//   matched_with_whatsapp excluded, so select("*") is answered with 42501
//   rather than with a phone number. The grant is the control; this list is
//   how the app stays inside it.
//
//   In the app, a column list is the payload contract written where a reviewer
//   can see it. The guest rail has done this since it was built (see the
//   header of app/api/guest/mine/route.ts); the Pioneer rail was still on
//   select("*"), which is finding S-1.
//
// The two phone columns are not here and must not be added. A matched party
// gets the other party's number from getCounterpartContactAsync below, which
// goes through an RPC that checks who is asking. Adding either column here
// would fail at the database anyway, which is the point.
// supabase-js can only infer a row shape from a string LITERAL passed to
// .select(); given a joined constant it falls back to GenericStringError, so
// every call site casts through unknown. Same trade the guest routes made for
// the same reason (app/api/guest/mine/route.ts). Keep ListingRow in sync with
// this list by hand.
const LISTING_COLUMNS = [
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

// Public read — anyone can browse the open listings feed.
export async function getOpenListingsAsync(): Promise<Listing[]> {
  const { data, error } = await getAnonClient()
    .from("listings")
    .select(LISTING_COLUMNS)
    .eq("status", "open")
    .order("created_at", { ascending: false })

  if (error) {
    console.error("getOpenListingsAsync error:", error)
    return []
  }

  return (data as unknown as ListingRow[]).map(fromRow)
}

// User-scoped read — returns listings the user posted or was matched into.
// Requires authentication: tightened RLS will key on auth.jwt() pi_uid.
export async function getListingsByUserAsync(userId: string): Promise<Listing[]> {
  // Return both: listings the user posted, AND listings where the user
  // accepted (matched_with_user_id). Either makes the listing "theirs".
  // The uid is interpolated into a PostgREST filter string, where a comma, a
  // dot or a paren is structure rather than data: a crafted value would change
  // the shape of the filter instead of the value being compared (S-18). Pi uids
  // are alphanumeric, so anything else is refused before the query is built
  // rather than escaped, which PostgREST gives no way to do reliably.
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(userId)) {
    console.error("getListingsByUserAsync: uid failed the filter safety check")
    return []
  }

  const { data, error } = await getAuthedClient()
    .from("listings")
    .select(LISTING_COLUMNS)
    .or(`posted_by_id.eq.${userId},matched_with_user_id.eq.${userId}`)
    .order("created_at", { ascending: false })

  if (error) {
    console.error("getListingsByUserAsync error:", error)
    return []
  }

  // Per-user archive: hide a listing only from the side that archived it.
  // Poster archived sets archived_at; matched party archived sets
  // archived_by_matched_at. The row and Track-by-ID are never affected.
  const rows = (data as unknown as ListingRow[]).filter((r) => {
    const hiddenForUser =
      (r.posted_by_id === userId && r.archived_at != null) ||
      (r.matched_with_user_id === userId && r.archived_by_matched_at != null)
    return !hiddenForUser
  })
  return rows.map(fromRow)
}

// Public read — anyone with a tracking ID can look up a listing's status.
// This is by design: tracking IDs are short and shareable specifically so
// recipients can check delivery progress without signing in.
export async function getListingByTrackingIdAsync(
  trackingId: string
): Promise<Listing | null> {
  const { data, error } = await getAnonClient()
    .from("listings")
    .select(LISTING_COLUMNS)
    .eq("tracking_id", trackingId.trim().toUpperCase())
    .maybeSingle()

  if (error) {
    console.error("getListingByTrackingIdAsync error:", error)
    return null
  }
  if (!data) return null

  return fromRow(data as unknown as ListingRow)
}

// ---- Status transitions ----
//
// The three transitions below are server routes, not client writes.
//
// They were client writes until the grant baseline
// (db/migrations/2026-09-07_grant_baseline.sql), which took UPDATE on every
// listings column except the two archive ones away from authenticated. A
// browser can no longer write status, and that is the fix rather than the
// obstacle: the listings UPDATE policy is row level and cannot see WHICH
// column a request touches, so any client able to write status could write any
// status on any row the policy admitted it to. Expire somebody else's open
// listing, mark a delivery picked up that nobody collected, walk a row to
// completed.
//
// Nothing on this side of the wire names a party. mark-in-transit works out
// which side is the traveller from the listing's own kind, server side, the
// same way completion does.

type StatusTransition = "cancel-open" | "cancel-matched" | "mark-in-transit"

/**
 * POST one status transition and return the status the server ended up in.
 *
 * Returns null on every failure, which the callers turn into a message. The
 * refusals are not distinguished: "not your listing", "no such listing" and
 * "state already moved" all come back the same way, and none of them should
 * tell an unrelated caller anything about a row.
 */
async function postStatusTransition(
  transition: StatusTransition,
  listingId: string
): Promise<ListingStatus | null> {
  const session = getSupabaseSession()
  if (!session?.accessToken) {
    console.error(`${transition}: no active Supabase session`)
    return null
  }

  try {
    const res = await fetch(`/api/listings/${transition}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accessToken: session.accessToken, listingId }),
    })
    const body = (await res.json()) as {
      ok: boolean
      status?: ListingStatus
      reason?: string
    }
    if (!res.ok || !body.ok || !body.status) {
      console.warn(`${transition} refused:`, body.reason)
      return null
    }
    return body.status
  } catch (err) {
    console.error(`${transition} error:`, err)
    return null
  }
}

// ---- Counterparty contact ----

export type CounterpartContact = {
  counterpartyRole: "poster" | "matched"
  counterpartyUsername: string | null
  whatsapp: string | null
}

/**
 * The other party's WhatsApp number on one matched listing.
 *
 * Neither anon nor authenticated can read whatsapp or matched_with_whatsapp
 * from the table at all after the 2026-09-07 grant baseline, so this RPC is
 * the only path a number reaches a client by. It is security definer, and it
 * decides for itself who is asking: it maps auth.uid() to a pi_uid through
 * public.pioneers and returns a row only when that pi_uid is the poster or
 * the matched party on this listing.
 *
 * Returns null for every refusal, and the refusals are indistinguishable on
 * purpose: not a party, no such listing, and not matched yet all look the
 * same from here because they all return zero rows.
 *
 * Requires a signed in Pioneer. Guests have no session and anon does not hold
 * EXECUTE on the function.
 */
export async function getCounterpartContactAsync(
  listingId: string
): Promise<CounterpartContact | null> {
  const { data, error } = await getAuthedClient().rpc(
    "listing_counterpart_contact",
    { p_listing_id: listingId }
  )

  if (error) {
    console.error("getCounterpartContactAsync error:", error.message)
    return null
  }

  const row = Array.isArray(data) ? data[0] : data
  if (!row) return null

  return {
    counterpartyRole: row.counterparty_role,
    counterpartyUsername: row.counterparty_username ?? null,
    whatsapp: row.whatsapp ?? null,
  }
}

// ---- Write paths ----
//
// All writes require an authenticated session. The authed client carries
// the Pioneer's JWT so RLS policies can verify ownership via the
// posted_by_id / matched_with_user_id columns.

// Creation is a SERVER ROUTE, not a client insert.
//
// It used to be an INSERT through the authed client, which meant the browser
// composed the whole row: posted_by_id, posted_by_username, status,
// tracking_id, created_at and the matched_with_* columns were all whatever was
// sent. The database policy pinned posted_by_id and nothing else, because the
// grant behind it was table-wide (finding S-15).
//
// app/api/listings/create now owns every one of those fields, and
// authenticated holds no INSERT on listings at all, so this is not the
// preferred path, it is the only one. The TODO that used to sit here, about
// moving id, trackingId and createdAt to Postgres defaults, is answered: the
// server sets them, which is better than a default because the tracking ID has
// to be checked against the guest rail as well.

type CreatedListingResponse = {
  ok: boolean
  listing?: ListingRow
  reason?: string
}

/**
 * POST a new listing and map the row back.
 *
 * The caller supplies the contents of the listing and nothing about who is
 * posting it. There is deliberately no postedById or postedByUsername
 * parameter any more: the route reads both from the session token, and the
 * schema is strict, so sending them is a 400 rather than a value that is
 * quietly ignored.
 */
/**
 * Why a create failed, in the terms the person reading the screen needs.
 *
 * A bare null told every caller the same thing and they all said "check your
 * connection", which is wrong for every refusal the server issues. On
 * 13 September a Pioneer was shown that sentence for a 401, then for a 400,
 * and neither had anything to do with their connection.
 *
 *   offline           the request never reached us, so the old sentence is
 *                     right and is kept for exactly this case
 *   signed_out        the session is genuinely gone. Sign in again
 *   auth_unavailable  the session is probably fine and Supabase Auth could
 *                     not be reached. Try again shortly
 *   rejected          the server refused the contents of the form
 */
export type CreateFailure = "offline" | "signed_out" | "auth_unavailable" | "rejected"

export type CreateResult =
  | { ok: true; listing: Listing }
  | { ok: false; failure: CreateFailure }

async function createListingAsync(
  payload: Record<string, unknown>
): Promise<CreateResult> {
  const session = getSupabaseSession()
  if (!session?.accessToken) {
    // No token at all. The app renders as signed in from localStorage while
    // the Supabase session lives in memory only, so this state is reachable
    // and is genuinely "sign in again" rather than a network problem.
    console.error("createListingAsync: no active session")
    return { ok: false, failure: "signed_out" }
  }
  try {
    const res = await fetch("/api/listings/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accessToken: session.accessToken, ...payload }),
    })
    const body = (await res.json().catch(() => null)) as CreatedListingResponse | null

    if (!res.ok || !body?.ok || !body.listing) {
      console.error("createListingAsync failed:", res.status, body?.reason)
      if (res.status === 503 || body?.reason === "auth_unavailable") {
        return { ok: false, failure: "auth_unavailable" }
      }
      if (res.status === 401) return { ok: false, failure: "signed_out" }
      return { ok: false, failure: "rejected" }
    }
    return { ok: true, listing: fromRow(body.listing) }
  } catch (err) {
    // fetch itself threw, which is the only case that really is the network.
    console.error("createListingAsync error:", err)
    return { ok: false, failure: "offline" }
  }
}

/**
 * What to put in front of the person, per failure.
 *
 * Shared by both Pioneer forms so they cannot drift, and worded so each one
 * names an action the reader can take.
 */
export function createFailureMessage(failure: CreateFailure, noun: string): string {
  switch (failure) {
    case "offline":
      return `Could not reach Gyema. Check your connection and try again.`
    case "signed_out":
      return `Your session has expired. Sign in with Pi again, then post your ${noun}.`
    case "auth_unavailable":
      return `Could not confirm your sign-in just now. Nothing was posted. Please try again in a moment.`
    case "rejected":
      return `Could not post your ${noun}. Please check the form and try again.`
  }
}

export async function createTripAsync(input: {
  whatsapp: string
  fromCity: string
  toCity: string
  travelDate: string
  capacity: PackageSize
  pricePi: number
  notes: string
}): Promise<CreateResult> {
  return createListingAsync({ kind: "trip", ...input })
}

export async function createPackageAsync(input: {
  whatsapp: string
  fromCity: string
  toCity: string
  deliverBy: string
  size: PackageSize
  description: string
  offerPi: number
}): Promise<CreateResult> {
  return createListingAsync({ kind: "package", ...input })
}

// ---- Accept / Mark Complete (v2) ----

// Accept a listing: the current user agrees to be the counterparty.
// Only succeeds if the listing is still 'open' — prevents two users
// from both "accepting" the same listing in a race.
//
// On success, the listing transitions: open → matched.
// posted_by_id remains the original poster; matched_with_* records
// the accepter so both parties are now stored on the row.
export async function acceptListingAsync(input: {
  listingId: string
  accepterWhatsapp: string
}): Promise<Listing | null> {
  // The claim runs server-side at /api/listings/accept using the service_role
  // client. This is required because the listings UPDATE RLS policy only
  // permits the poster (or an already-matched party) to update a row, which
  // can never authorize the INITIAL claim: at accept time the accepter is
  // neither, so a client-side UPDATE touches 0 rows and the accept silently
  // fails. The route verifies the accepter from their Supabase session token
  // and writes the claim with elevated privilege, guarded to OPEN, non-owner
  // rows only.
  const session = getSupabaseSession()
  if (!session?.accessToken) {
    console.error("acceptListingAsync: no active Supabase session")
    return null
  }

  try {
    const res = await fetch("/api/listings/accept", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accessToken: session.accessToken,
        listingId: input.listingId,
        accepterWhatsapp: input.accepterWhatsapp,
      }),
    })
    const body = (await res.json()) as {
      ok: boolean
      listing?: ListingRow
      reason?: string
    }
    if (!res.ok || !body.ok || !body.listing) {
      console.warn("acceptListingAsync: claim not completed:", body?.reason)
      return null
    }
    return fromRow(body.listing)
  } catch (err) {
    console.error("acceptListingAsync error:", err)
    return null
  }
}

// Release a claim the current accepter made, reverting the listing to 'open'.
// Used to roll back when the connection-fee payment is cancelled or fails
// after a successful claim, so a listing is never left matched-but-unpaid.
// Runs server-side at /api/listings/release, scoped to the caller's own
// still-'matched' claim (verified from their session token).
export async function releaseListingAsync(input: {
  listingId: string
}): Promise<boolean> {
  const session = getSupabaseSession()
  if (!session?.accessToken) {
    console.error("releaseListingAsync: no active Supabase session")
    return false
  }

  try {
    const res = await fetch("/api/listings/release", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accessToken: session.accessToken,
        listingId: input.listingId,
      }),
    })
    const body = (await res.json()) as { ok: boolean; reason?: string }
    return Boolean(res.ok && body.ok)
  } catch (err) {
    console.error("releaseListingAsync error:", err)
    return false
  }
}

// Confirm completion of a delivery from the caller's own side.
//
// The caller does NOT say which side that is. The confirmation runs
// server-side at /api/listings/confirm-completion, which verifies the caller
// from their Supabase session token and hands the listing id and that
// verified pi_uid to a database function; the function reads the row and
// decides for itself which of the two attestation columns the caller owns
// (on a 'package' the poster is the sender, on a 'trip' the poster is the
// traveller). Nothing on this side of the wire names a party.
//
// This used to take a `role` argument and write the column that argument
// named through the authed client. The listings UPDATE policy is row-level:
// it admits the poster and the matched party to the row and cannot tell
// which column a request is writing, so one party could set both flags and
// close a delivery alone. The authenticated role no longer holds the grant
// to write those columns at all — see
// db/migrations/2026-08-14_listing_completion_rls.sql.
//
// The route returns the listing whenever the caller's attestation is on the
// record, which includes a repeat confirmation: the same call made twice is
// not an error and returns the current row. Any refusal — not a party, no
// such listing, expired, already completed without this attestation — comes
// back as a single undifferentiated reason and surfaces here as null.
export async function confirmCompletionAsync(input: {
  listingId: string
}): Promise<Listing | null> {
  const session = getSupabaseSession()
  if (!session?.accessToken) {
    console.error("confirmCompletionAsync: no active Supabase session")
    return null
  }

  try {
    const res = await fetch("/api/listings/confirm-completion", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accessToken: session.accessToken,
        listingId: input.listingId,
      }),
    })
    const body = (await res.json()) as {
      ok: boolean
      listing?: ListingRow
      reason?: string
    }
    if (!res.ok || !body.ok || !body.listing) {
      console.warn("confirmCompletionAsync: not confirmed:", body?.reason)
      return null
    }
    return fromRow(body.listing)
  } catch (err) {
    console.error("confirmCompletionAsync error:", err)
    return null
  }
}

// Cancel a matched listing: either party (poster or matched user) can call this
// when a deal falls through, the counterparty ghosts, or the date passes
// without completion. Listing transitions: matched/in_transit → expired.
//
// V2: caller responsibility for verifying user is one of the two parties
// is now supplemented by RLS policies that enforce the same constraint
// server-side.
//
// Once expired, the listing cannot be revived — it falls into the user's
// Past Trips/Deliveries section. This is a destructive action; UI must
// confirm before calling.
export async function cancelMatchedListingAsync(input: {
  listing: Listing
}): Promise<Listing | null> {
  const status = await postStatusTransition("cancel-matched", input.listing.id)
  if (!status) return null
  return { ...input.listing, status }
}

// Traveller marks the delivery as picked up: matched -> in_transit.
// Traveller-only in practice (the UI gates the action to the carrying party),
// and race-guarded to status "matched" so it cannot double-fire or fire on the
// wrong state, mirroring cancelMatchedListingAsync. The row and Track-by-ID
// reflect the new state immediately.
export async function markInTransitAsync(input: {
  listing: Listing
}): Promise<Listing | null> {
  const status = await postStatusTransition("mark-in-transit", input.listing.id)
  if (!status) return null
  return { ...input.listing, status }
}

// Cancel an OPEN listing the current user posted, before anyone has accepted
// it. Poster-only: the listings UPDATE RLS policy authorizes the poster via
// posted_by_id = auth pi_uid, so the authed client suffices, no server route.
// Transitions open -> expired, consistent with cancelMatchedListingAsync, so
// the listing leaves the marketplace and falls into Past Trips/Deliveries.
//
// Race guard: only acts while status is still open. If someone accepted
// between sheet render and tap, the row is now matched and this touches 0
// rows, returning null, so we never yank an accepted (and paid) match.
export async function cancelOpenListingAsync(input: {
  listing: Listing
}): Promise<Listing | null> {
  const status = await postStatusTransition("cancel-open", input.listing.id)
  if (!status) return null
  return { ...input.listing, status }
}

// Archive an expired listing from My Activity. This is a soft hide, not a
// delete: it stamps archived_at so getListingsByUserAsync filters the row
// out of the list, while the row stays in the DB so its tracking ID still
// resolves on the public Track tab and the history stays available for the
// future reputation surface.
//
// Scoped to expired and completed listings. Per-user: a poster stamps
// archived_at, a matched party stamps archived_by_matched_at, so each side
// hides only its own view. The authed client suffices; the listings UPDATE
// RLS policy authorizes both the poster and the matched party.
export async function archiveListingAsync(input: {
  listingId: string
  side: "poster" | "matched"
}): Promise<Listing | null> {
  const column =
    input.side === "poster" ? "archived_at" : "archived_by_matched_at"
  const { data, error } = await getAuthedClient()
    .from("listings")
    .update({ [column]: new Date().toISOString() })
    .eq("id", input.listingId)
    .in("status", ["expired", "completed"])
    .select(LISTING_COLUMNS)
    .single()

  if (error) {
    console.error("archiveListingAsync error:", error)
    return null
  }

  return data ? fromRow(data as unknown as ListingRow) : null
}

// ---- Maintenance ----
//
// expireStaleListingsAsync has been removed from this file. Stale listing
// sweeps are now handled server-side by a Vercel Cron Job at:
//   app/api/cron/expire-stale-listings/route.ts
// running on the schedule defined in vercel.json.
//
// Rationale: the sweep is a system maintenance operation that needs to
// run even when no Pioneer has the app open, and it needs to bypass RLS
// (it operates on every Pioneer's listings, not just the caller's).
// Both of these make a server-side cron the right home for it.
