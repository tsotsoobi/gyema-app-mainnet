// Server-side Supabase admin client for privileged operations.
//
// Runs ONLY in Next.js API routes (route.ts files under app/api/).
// Never imported into client components or browser-running code.
//
// Uses the service_role key, which BYPASSES Row-Level Security and
// has full access to the database. This is why it lives in a separate
// file with explicit warnings — to make accidental misuse harder.
//
// Used for:
// - Creating Supabase Auth users mapped to Pi-verified Pioneers
// - Issuing Supabase session tokens via admin.generateLink
// - Future v2 escrow operations that legitimately need to bypass RLS
// - Writing auth observability events (auth_events table)
//
// SUPABASE_SERVICE_ROLE_KEY must be set in Vercel's environment
// variables. NEVER committed to the repo. NEVER exposed to the client.

import { createClient, SupabaseClient } from "@supabase/supabase-js"
import { createHmac } from "crypto"
import { assertUsablePioneerSalt } from "./env-guard"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!

/**
 * Create a Supabase admin client.
 *
 * The client is per-call rather than memoized to make secret-leak
 * incidents easier to recover from (rotating the service_role key
 * doesn't require redeployment if no client is held in module state).
 *
 * @returns A Supabase client with service_role privileges
 */
export function createAdminClient(): SupabaseClient {
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!serviceRoleKey) {
    throw new Error(
      "[supabase-admin] SUPABASE_SERVICE_ROLE_KEY is not configured"
    )
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      // Admin clients don't have user sessions of their own.
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  })
}

/**
 * Synthetic email format for Pi-verified Pioneers in Supabase Auth.
 *
 * Supabase Auth requires email-based or phone-based identifiers. Since
 * Pi UIDs are neither, we use a synthetic local-only domain that's
 * unmistakable as not being a real email address.
 *
 * Format: pi-{uid}@gyema.local
 *
 * The "@gyema.local" TLD is the IETF-reserved ".local" namespace
 * (RFC 6762), guaranteed to never resolve as a real domain.
 */
export function piUidToSyntheticEmail(piUid: string): string {
  return `pi-${piUid}@gyema.local`
}

/** How many users a page of the fallback scan asks for. */
const SCAN_PAGE_SIZE = 200

/**
 * Pages the fallback scan will read before giving up, so a bug cannot turn
 * into an unbounded loop on a sign-in path. 100 pages of 200 is 20,000 users;
 * if that is ever reached the answer is to stop scanning, not to scan harder.
 */
const SCAN_PAGE_LIMIT = 100

/**
 * Find one Supabase Auth user by exact email.
 *
 * WHY THIS EXISTS
 *
 * This lookup used to be `listUsers({ page: 1, perPage: 1000 })` followed by a
 * find over the result. That is correct until the project has more than 1000
 * users and silently wrong afterwards: a Pioneer outside the first page is
 * invisible to it, so the caller concludes they do not exist, calls createUser
 * for an email that is already taken, gets an error, and answers the sign in
 * with PROVISIONING_ERROR. Retrying does not help. Testnet crossed 1000 users
 * some time ago and reached 2689 by 7 September 2026, which is when this was
 * found.
 *
 * TWO STEPS, in order:
 *
 *   1. Ask GoTrue's admin API for this email directly. Its `filter` parameter
 *      is a partial match on email, so the result is verified against the exact
 *      address before it is believed: a filter for pi-abc@gyema.local would
 *      otherwise happily return pi-abcd@gyema.local.
 *
 *   2. If that finds nothing, page through listUsers until a short page comes
 *      back. A short page is the end of the list; anything else is a page
 *      boundary and stopping there is the bug this replaces. This runs when
 *      the filtered lookup genuinely found nothing AND when an older GoTrue
 *      ignored the parameter entirely, which is indistinguishable from here
 *      and is why the scan is kept rather than deleted.
 *
 * Returns null only after both have looked. Throws if the scan itself fails,
 * because "cannot tell" and "not there" must not answer the same way when the
 * caller's next move is to create the user.
 */
export async function findAuthUserByEmail(
  admin: SupabaseClient,
  email: string
): Promise<{ id: string } | null> {
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  // --- Step 1: direct, filtered lookup ---
  if (serviceRoleKey) {
    try {
      const url = `${supabaseUrl}/auth/v1/admin/users?per_page=${SCAN_PAGE_SIZE}&filter=${encodeURIComponent(email)}`
      const res = await fetch(url, {
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
        },
        cache: "no-store",
      })
      if (res.ok) {
        const body = (await res.json()) as { users?: Array<{ id?: string; email?: string }> }
        const exact = (body.users ?? []).find(
          (u) => (u.email ?? "").toLowerCase() === email.toLowerCase()
        )
        if (exact?.id) return { id: exact.id }
      } else {
        console.warn(`[supabase-admin] filtered user lookup returned ${res.status}, falling back to scan`)
      }
    } catch (error) {
      console.warn("[supabase-admin] filtered user lookup failed, falling back to scan:", error)
    }
  }

  // --- Step 2: paged scan, until a short page ---
  for (let page = 1; page <= SCAN_PAGE_LIMIT; page++) {
    const { data, error } = await admin.auth.admin.listUsers({
      page,
      perPage: SCAN_PAGE_SIZE,
    })
    if (error) {
      throw new Error(`[supabase-admin] listUsers failed on page ${page}: ${error.message}`)
    }
    const users = data?.users ?? []
    const exact = users.find((u) => (u.email ?? "").toLowerCase() === email.toLowerCase())
    if (exact?.id) return { id: exact.id }

    // A short page is the end of the list. A full page is a boundary, and
    // stopping on one is exactly the bug this function replaces.
    if (users.length < SCAN_PAGE_SIZE) return null
  }

  throw new Error(
    `[supabase-admin] user scan hit the ${SCAN_PAGE_LIMIT} page limit without a conclusive answer`
  )
}

/**
 * Find or create a Supabase Auth user for a Pi-verified Pioneer.
 *
 * IDENTITY MODEL (updated May 18 2026):
 *   pi_username is the canonical Pioneer identity. Pi.authenticate() on
 *   Testnet has been observed to return DIFFERENT pi_uids for the same
 *   Pioneer across sessions (a fresh sign-in returns one uid, a
 *   sign-out-sign-in returns another). pi_uid is therefore treated as a
 *   session-time attribute, not an identity. Identity is keyed on
 *   pi_username, which Pi returns stably across all sessions.
 *
 * Returns:
 *   - supabase_user_id: what becomes auth.uid() in RLS policies
 *   - canonical_pi_uid: the pi_uid stored in the pioneer row, which may
 *     DIFFER from params.pi_uid if Pi rotated this session. The route
 *     uses this for session generation so the access_token authenticates
 *     against the canonical auth.users record, not the rotated one.
 *   - created: true if a brand-new Pioneer was provisioned
 *
 * Lookup strategy (fastest → slowest, most stable → least stable):
 *   1a. pi_username indexed lookup — the canonical key
 *   1b. pi_uid indexed lookup — legacy compat for rows pre-dating the
 *       username-key migration (shouldn't be reachable in practice)
 *   2.  email lookup fallback — defends against pioneers/auth.users drift
 *   3.  createUser — provisions a brand-new Pioneer
 *
 * Throws on any failure — the calling route should catch and return
 * a 500 to the client.
 */
export async function findOrCreatePioneerUser(params: {
  pi_uid: string
  pi_username: string
}): Promise<{
  supabase_user_id: string
  canonical_pi_uid: string
  created: boolean
}> {
  const admin = createAdminClient()

  // --- Step 1a: PRIMARY lookup — by pi_username ---
  // Username is the stable identity across Pi's session-rotated uids.
  // Ordered by created_at to deterministically prefer the oldest row
  // in the (currently possible) event of multiple rows per username.
  // Once the UNIQUE(pi_username) constraint is added in a follow-up
  // migration, this ordering becomes a no-op (only one row can exist).
  const { data: byUsername, error: usernameLookupError } = await admin
    .from("pioneers")
    .select("supabase_user_id, pi_uid")
    .eq("pi_username", params.pi_username)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle()

  if (usernameLookupError) {
    console.warn(
      "[supabase-admin] pioneers username lookup failed, falling back to pi_uid:",
      usernameLookupError.message
    )
  }

  if (byUsername?.supabase_user_id && byUsername?.pi_uid) {
    return {
      supabase_user_id: byUsername.supabase_user_id,
      canonical_pi_uid: byUsername.pi_uid,
      created: false,
    }
  }

  // --- Step 1b: SECONDARY lookup — by pi_uid (legacy compat) ---
  // Defends against any pioneer row where pi_username was never set.
  // Should be unreachable in practice on current schema (all rows have
  // pi_username populated since the column was added), but kept for
  // graceful degradation.
  const { data: byUid, error: uidLookupError } = await admin
    .from("pioneers")
    .select("supabase_user_id, pi_uid")
    .eq("pi_uid", params.pi_uid)
    .maybeSingle()

  if (uidLookupError) {
    console.warn(
      "[supabase-admin] pioneers uid lookup failed, falling back to listUsers:",
      uidLookupError.message
    )
  }

  if (byUid?.supabase_user_id && byUid?.pi_uid) {
    return {
      supabase_user_id: byUid.supabase_user_id,
      canonical_pi_uid: byUid.pi_uid,
      created: false,
    }
  }

  // --- Step 2: Fallback — look the synthetic email up ---
  // Only runs if no pioneers row matched either key. Defends against schema
  // drift (e.g. a row created via SQL that didn't insert into pioneers).
  //
  // findAuthUserByEmail asks GoTrue for this address directly and only pages
  // through the user list if that finds nothing. It used to be a single page
  // of 1000 users, which stopped being correct the day the project passed
  // 1000: see that function's header for what that did to a sign in.
  const email = piUidToSyntheticEmail(params.pi_uid)
  const existing = await findAuthUserByEmail(admin, email)
  if (existing) {
    // Found via fallback — backfill the pioneers row so the next sign-in
    // hits the fast path. Failure to backfill is non-fatal.
    const { error: backfillError } = await admin.from("pioneers").insert({
      pi_uid: params.pi_uid,
      supabase_user_id: existing.id,
      pi_username: params.pi_username,
    })
    if (backfillError) {
      console.warn(
        "[supabase-admin] pioneers backfill insert failed (non-fatal):",
        backfillError.message
      )
    }
    return {
      supabase_user_id: existing.id,
      canonical_pi_uid: params.pi_uid,
      created: false,
    }
  }

  // --- Step 3: Provision new user ---
  const syntheticPassword = derivePioneerPassword(params.pi_uid)
  const { data: newUser, error: createError } =
    await admin.auth.admin.createUser({
      email,
      password: syntheticPassword,
      email_confirm: true, // Skip email verification — Pi already verified identity
      user_metadata: {
        pi_uid: params.pi_uid,
        pi_username: params.pi_username,
        provider: "pi-network",
      },
    })

  if (createError || !newUser?.user) {
    throw new Error(
      `[supabase-admin] createUser failed: ${createError?.message || "no user returned"}`
    )
  }

  // Write to pioneers so the next sign-in is O(1). Failure here is
  // non-fatal: the user exists in auth.users, and the email lookup fallback
  // will still find them on the next sign-in (just slower until someone
  // notices and backfills manually).
  const { error: insertError } = await admin.from("pioneers").insert({
    pi_uid: params.pi_uid,
    supabase_user_id: newUser.user.id,
    pi_username: params.pi_username,
  })
  if (insertError) {
    console.warn(
      "[supabase-admin] pioneers insert failed for new user (non-fatal):",
      insertError.message
    )
  }

  return {
    supabase_user_id: newUser.user.id,
    canonical_pi_uid: params.pi_uid,
    created: true,
  }
}

/**
 * Generate a Supabase session for a Pioneer.
 *
 * Returns the access_token and refresh_token that the frontend will
 * use to authenticate Supabase requests. These are signed by Supabase
 * with its own private key (the asymmetric signing keys system) and
 * RLS will see them as legitimate authenticated sessions.
 *
 * IMPORTANT: callers must pass the CANONICAL pi_uid (from
 * findOrCreatePioneerUser's return value), NOT whatever pi_uid Pi
 * returned this session. Pi rotates uids across sessions; the canonical
 * uid is the one stored in the pioneer row.
 *
 * The session is generated via signInWithPassword using a deterministic
 * synthetic password. This is acceptable because:
 * - The synthetic email is non-routable (.local TLD)
 * - The "password" is server-derived from the Pi UID + a server secret
 * - The actual auth gate is Pi-KYC; Supabase Auth is just session storage
 */
export async function generatePioneerSession(params: {
  pi_uid: string
}): Promise<{ access_token: string; refresh_token: string }> {
  const admin = createAdminClient()
  const email = piUidToSyntheticEmail(params.pi_uid)
  const syntheticPassword = derivePioneerPassword(params.pi_uid)

  // Sign in with the deterministic password to get a real session.
  const { data: session, error: signInError } =
    await admin.auth.signInWithPassword({ email, password: syntheticPassword })

  if (signInError || !session?.session) {
    throw new Error(
      `[supabase-admin] signInWithPassword failed: ${signInError?.message || "no session"}`
    )
  }

  return {
    access_token: session.session.access_token,
    refresh_token: session.session.refresh_token,
  }
}

/**
 * Derive a synthetic password for a Pioneer from their Pi UID.
 *
 * Uses HMAC-SHA256 keyed by PIONEER_PASSWORD_SALT, producing a 64-char
 * hex string. This is:
 * - Deterministic (same Pi UID + same salt = same password every time)
 * - Fixed-length, well under bcrypt's 72-byte limit (Supabase Auth uses
 *   bcrypt internally; a longer password causes a runtime panic)
 * - Cryptographically opaque (the Pi UID cannot be recovered from the
 *   password without the salt)
 *
 * Versioning note: the "gyema-v2" suffix on the HMAC input lets us
 * rotate the derivation scheme in the future by changing the suffix
 * (e.g. "gyema-v3") and invalidating all existing synthetic passwords.
 */
function derivePioneerPassword(piUid: string): string {
  // Refuses an absent, placeholder, short or low-entropy salt, at first use.
  // See lib/env-guard.ts: this value is the whole authentication chain, and a
  // deployment running on "changeme" should fail its first sign in rather
  // than work quietly (finding S-8).
  const salt = process.env.PIONEER_PASSWORD_SALT
  assertUsablePioneerSalt(salt)
  return createHmac("sha256", salt).update(`${piUid}.gyema-v2`).digest("hex")
}

/**
 * Write the Pioneer's identity into app_metadata.
 *
 * WHY THIS EXISTS, AND WHY user_metadata IS NOT ENOUGH.
 *
 * user_metadata is the user's own metadata. A signed in client can write it
 * with supabase.auth.updateUser({ data: { ... } }) holding nothing but the
 * anon key and their own session. Anything read from there is a value the
 * caller chose, which makes it fine for a display name and useless as an
 * identity.
 *
 * pi_uid was living there, and it is the key every route and every RLS policy
 * decides ownership with. A Pioneer could set their own pi_uid to somebody
 * else's and become them for every check that read it.
 *
 * app_metadata is written only with the service_role key. A client cannot
 * touch it at any price, and it rides in the JWT the same way, so policies can
 * read it as auth.jwt() -> 'app_metadata' ->> 'pi_uid'.
 *
 * Called on every sign in, before the session is generated, so the token the
 * Pioneer walks away with carries the claim. Idempotent: writing the same
 * values again is a no-op as far as anything downstream is concerned.
 *
 * Throws on failure. The caller decides whether that is fatal; /api/auth/verify
 * treats it as fatal, because a session minted without the claim is a session
 * that cannot read its owner's own listings.
 */
export async function setPioneerAppMetadata(params: {
  supabase_user_id: string
  pi_uid: string
  pi_username: string
}): Promise<void> {
  const admin = createAdminClient()
  const { error } = await admin.auth.admin.updateUserById(params.supabase_user_id, {
    app_metadata: {
      pi_uid: params.pi_uid,
      pi_username: params.pi_username,
      provider: "pi-network",
    },
  })
  if (error) {
    throw new Error(`[supabase-admin] app_metadata write failed: ${error.message}`)
  }
}

// ============================================================================
// Auth observability
// ============================================================================

/**
 * Auth event types — must match the CHECK constraint on auth_events.event_type
 */
export type AuthEventType =
  | "request_received"
  | "pi_token_verified"
  | "user_provisioned"
  | "sign_in_complete"
  | "rejected_malformed"
  | "rejected_missing_token"
  | "rejected_invalid_token"
  | "failed_provisioning"
  | "failed_session"

/**
 * Record an auth event for observability.
 *
 * Writes to the auth_events table. Failures are deliberately swallowed —
 * observability must never break the auth flow.
 *
 * Pi UIDs and Supabase user IDs should be truncated to first 8 chars
 * before passing in, matching the convention in console logs.
 */
export async function logAuthEvent(event: {
  event_type: AuthEventType
  pi_uid_prefix?: string
  supabase_user_id_prefix?: string
  pi_username?: string
  user_created?: boolean
  error_message?: string
  elapsed_ms?: number
  metadata?: Record<string, unknown>
}): Promise<void> {
  try {
    const admin = createAdminClient()
    const { error } = await admin.from("auth_events").insert({
      event_type: event.event_type,
      pi_uid_prefix: event.pi_uid_prefix,
      supabase_user_id_prefix: event.supabase_user_id_prefix,
      pi_username: event.pi_username,
      user_created: event.user_created,
      error_message: event.error_message,
      elapsed_ms: event.elapsed_ms,
      metadata: event.metadata,
    })
    if (error) {
      console.error("[auth-observability] Insert failed:", error.message)
    }
  } catch (error) {
    // Swallow — observability must never break auth
    console.error("[auth-observability] Unexpected error:", error)
  }
}
