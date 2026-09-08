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
export async function resolveCaller(
  admin: SupabaseClient,
  accessToken: unknown
): Promise<CallerIdentity | null> {
  if (!accessToken || typeof accessToken !== "string") return null

  const { data, error } = await admin.auth.getUser(accessToken)
  if (error || !data?.user) return null

  const meta = (data.user.user_metadata ?? {}) as {
    pi_uid?: string
    pi_username?: string
  }
  if (!meta.pi_uid || !meta.pi_username) return null

  return { pi_uid: meta.pi_uid, pi_username: meta.pi_username }
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
