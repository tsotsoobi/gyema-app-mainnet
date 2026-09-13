import { NextResponse } from "next/server"
import { isAuthRetryableFetchError } from "@supabase/supabase-js"
import type { SupabaseClient } from "@supabase/supabase-js"

// Caller identity for API routes, in one place.
//
// Every route that does anything on behalf of a Pioneer needs the same three
// steps: read the Supabase session token, ask Supabase who it belongs to, and
// pull the Pi identity off that user. Six routes had those steps inline and
// slightly differently, which is how a difference gets introduced without
// anyone deciding to introduce one.
//
// CLAUDE.md invariant 1: identity for sensitive operations is derived
// server-side from admin.auth.getUser, never taken from the request body. This
// module is where that happens, so a route that wants a uid has to go through
// a function that cannot read one out of a body.

export type CallerIdentity = {
  pi_uid: string
  pi_username: string
}

/**
 * Resolve the Pioneer behind a Supabase session token.
 *
 * Returns null when the token is missing, unrecognised, or belongs to a user
 * with no Pi identity attached. Callers turn that into a 401. The three cases
 * are deliberately not distinguished: a caller learns only that they are not
 * signed in as someone this route will act for.
 */
/**
 * Why a caller could not be resolved.
 *
 * These are two different failures wearing one uniform, and telling them apart
 * is the whole point of this type.
 *
 *   no_token / bad_token / no_claim   The caller is not who they need to be.
 *                                     401. The client should sign in again.
 *
 *   auth_unavailable                  We could not ASK. 503. The caller's
 *                                     session is probably fine and a retry is
 *                                     the right move.
 *
 * WHY THIS TYPE EXISTS AT ALL. On 13 September a Pioneer on Mainnet posted a
 * trip at 07:44:07, was refused 401 at 07:45:16, and posted a package at
 * 07:46:34, on one token with no re-authentication in between. auth_events
 * showed a single verify at 07:43:14. The token could not have changed and
 * nothing refreshes it, because the authed client is built with
 * autoRefreshToken false.
 *
 * The cause was this function collapsing every getUser outcome into one null:
 *
 *     const { data, error } = await admin.auth.getUser(accessToken)
 *     if (error || !data?.user) return null
 *
 * auth-js catches inside getUser and RETURNS any AuthError rather than
 * throwing it. AuthRetryableFetchError, which is what a transient fetch issue
 * raises, extends AuthError. So a network blip, a GoTrue 5xx and a 429 all
 * arrived on the same branch as a genuinely expired token, and every one of
 * them was reported to the Pioneer as "not signed in".
 *
 * A non-AuthError is still rethrown by getUser and still becomes the route's
 * own server_error, which is why that case is not represented here.
 */
export type CallerRefusal =
  | { ok: false; reason: "no_token" | "bad_token" | "no_claim"; status: 401 }
  | { ok: false; reason: "auth_unavailable"; status: 503 }

export type CallerVerdict = { ok: true; caller: CallerIdentity } | CallerRefusal

/**
 * Is this error the auth service being unreachable rather than the token being
 * wrong?
 *
 * Three signatures, and the order matters. AuthRetryableFetchError is the one
 * auth-js raises by name for a transient fetch. A 5xx or 429 carries a status
 * that says the same thing. An error with NO status at all reached us without
 * a reply from GoTrue, which is also not the token's fault.
 *
 * Anything else, which in practice means a 400, 401 or 403 from GoTrue, is a
 * real answer about a real token, and treating it as transient would be the
 * dangerous direction of this mistake: retrying a genuinely invalid session
 * forever rather than asking the Pioneer to sign in.
 */
function isTransientAuthFailure(error: unknown): boolean {
  if (isAuthRetryableFetchError(error)) return true
  const status = (error as { status?: unknown })?.status
  if (typeof status !== "number") return true
  return status === 429 || status >= 500
}

/**
 * Resolve the caller, or say why not.
 *
 * The log line lives HERE rather than at each call site, because every
 * authenticated route in the app goes through this function: the listings
 * routes, guest accept and mine, both payment routes, and delivery
 * confirmation. One place cannot drift; twelve copies would.
 *
 * It records the error's name, status and code and nothing else. Those three
 * separate a 429 from a 503 from an expired token, which is exactly what was
 * missing on 13 September. The token never appears, and neither does the
 * message body, which can carry an identifier.
 */
export async function resolveCaller(
  admin: SupabaseClient,
  accessToken: unknown
): Promise<CallerVerdict> {
  if (!accessToken || typeof accessToken !== "string") {
    return { ok: false, reason: "no_token", status: 401 }
  }

  const { data, error } = await admin.auth.getUser(accessToken)

  if (error) {
    const named = error as { name?: string; status?: unknown; code?: string }
    const transient = isTransientAuthFailure(error)
    console.warn(
      `[route-auth] getUser failed: name=${named.name ?? "unknown"} ` +
        `status=${named.status ?? "none"} code=${named.code ?? "none"} ` +
        `classified=${transient ? "transient" : "bad_token"}`
    )
    return transient
      ? { ok: false, reason: "auth_unavailable", status: 503 }
      : { ok: false, reason: "bad_token", status: 401 }
  }

  if (!data?.user) {
    // No error and no user. Not a shape the SDK documents, so it is recorded
    // rather than folded into one of the others.
    console.warn("[route-auth] getUser returned neither a user nor an error")
    return { ok: false, reason: "bad_token", status: 401 }
  }

  // app_metadata, NOT user_metadata.
  //
  // user_metadata is the user's own metadata: a signed in client writes it
  // with supabase.auth.updateUser({ data: { ... } }) holding nothing but the
  // anon key and their own session. pi_uid lived there, and pi_uid is what
  // every route and every RLS policy decides ownership with, so a Pioneer
  // could set theirs to somebody else's and become them for every check that
  // read it: claim their listings, cancel their deliveries, read their
  // counterparty's phone number.
  //
  // app_metadata is writable only with the service_role key. /api/auth/verify
  // stamps it on every sign in, before the session is minted, so the token
  // carries the claim.
  //
  // THERE IS NO FALLBACK TO user_metadata, deliberately. A fallback would be
  // the same forgeable value one branch away, and anyone who wanted it would
  // simply arrange for app_metadata to be absent.
  const meta = (data.user.app_metadata ?? {}) as {
    pi_uid?: string
    pi_username?: string
  }
  if (!meta.pi_uid || !meta.pi_username) {
    console.warn("[route-auth] session carries no app_metadata Pi identity")
    return { ok: false, reason: "no_claim", status: 401 }
  }

  return { ok: true, caller: { pi_uid: meta.pi_uid, pi_username: meta.pi_username } }
}

/**
 * The refusal a route returns, in the shape every route already used.
 *
 * A 401 still answers `unauthorized`, unchanged, because the UI branches on
 * that string and this is not the change to alter it in. What is new is the
 * 503, which is a different thing and says so.
 */
export function callerRefusalResponse(refusal: CallerRefusal): NextResponse {
  const reason = refusal.status === 503 ? "auth_unavailable" : "unauthorized"
  return NextResponse.json({ ok: false, reason }, { status: refusal.status })
}

/**
 * Which side of a listing is the traveller, from the listing itself.
 *
 * On a 'trip' the poster is the traveller and the matched party is the sender.
 * On a 'package' it is the other way round. This is the same derivation
 * public.listing_confirm_completion does inside the database, and it exists
 * here for the routes that have to decide before touching a row.
 *
 * Never take this from the client. A role argument is the F17 defect.
 */
export function travellerUid(listing: {
  kind: string
  posted_by_id: string
  matched_with_user_id: string | null
}): string | null {
  return listing.kind === "trip" ? listing.posted_by_id : listing.matched_with_user_id
}
