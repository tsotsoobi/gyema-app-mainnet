// POST /api/auth/verify
//
// The Pi-KYC gate. This is the only path by which a Pioneer obtains
// a Supabase session. Every authenticated Supabase request from the
// frontend uses the access_token returned here.
//
// Flow:
//   1. Frontend calls Pi.authenticate() in Pi Browser, gets accessToken
//   2. Frontend POSTs accessToken to this endpoint
//   3. Server verifies the Pi accessToken with Pi Platform /v2/me
//   4. Server finds-or-creates a Supabase Auth user mapped to Pi UID
//      (keyed on pi_username — see findOrCreatePioneerUser for why)
//   5. Server generates a Supabase session using the CANONICAL pi_uid
//      from the pioneer row, not the (possibly rotated) uid Pi returned
//   6. Frontend stores access_token + refresh_token, uses them for all
//      Supabase requests (RLS sees auth.uid() = supabase user id)
//
// IMPORTANT: this route MUST run on the Node.js runtime. The Supabase
// admin SDK uses Node's crypto module, which Edge runtime doesn't expose.
//
// Observability: every phase logs to (a) console with [auth/verify] prefix
// for live debugging, and (b) the auth_events table for durable, queryable
// observability. Pi UIDs and Supabase IDs are truncated to first 8 chars
// to preserve correlation without exposing full KYC-linked identifiers.
//
// Why waitUntil? On Vercel serverless, the function context is torn down
// the instant the response is returned. An unawaited promise (fire-and-forget)
// is killed mid-flight before its I/O completes. waitUntil tells the runtime
// to keep the function alive until the promise settles, without blocking
// the response.

import { NextRequest, NextResponse } from "next/server"
import { waitUntil } from "@vercel/functions"
import { verifyPiAccessToken } from "@/lib/pi-platform"
import { AuthVerifyBody } from "@/lib/schemas"
import {
  findOrCreatePioneerUser,
  generatePioneerSession,
  logAuthEvent,
  setPioneerAppMetadata,
} from "@/lib/supabase-admin"

// Force Node.js runtime — required for crypto.
export const runtime = "nodejs"

// No caching — every verification is a fresh check.
export const dynamic = "force-dynamic"

type GateFailureReason =
  | "MISSING_TOKEN"
  | "INVALID_TOKEN"
  | "PROVISIONING_ERROR"
  | "SESSION_ERROR"
  | "MALFORMED_REQUEST"

type GateSuccess = {
  ok: true
  pioneer: {
    pi_uid: string
    pi_username: string
    supabase_user_id: string
  }
  session: {
    access_token: string
    refresh_token: string
  }
}

type GateFailure = {
  ok: false
  reason: GateFailureReason
  message: string
}

// Truncate an ID for safe logging — preserves enough for correlation
// without exposing the full identifier.
function shortId(id: string): string {
  return id.slice(0, 8)
}

export async function POST(req: NextRequest) {
  const startedAt = Date.now()
  console.log("[auth/verify] Request received", {
    ts: new Date().toISOString(),
  })

  // Fire and forget via waitUntil — observability must not slow auth,
  // but the promise must survive function teardown on Vercel.
  waitUntil(logAuthEvent({ event_type: "request_received", elapsed_ms: 0 }))

  // 1. Parse the request body.
  let body: { accessToken?: unknown }
  try {
    body = await req.json()
  } catch {
    const elapsed = Date.now() - startedAt
    console.warn("[auth/verify] Rejected: MALFORMED_REQUEST", { ms: elapsed })
    waitUntil(logAuthEvent({ event_type: "rejected_malformed", elapsed_ms: elapsed }))
    return jsonError("MALFORMED_REQUEST", "Request body is not valid JSON", 400)
  }

  // 2. Validate the access token shape.
  //
  // Bounded as well as present: this value is sent to Pi Platform in a header,
  // and an unbounded one is a request a stranger chooses the size of.
  const parsedBody = AuthVerifyBody.safeParse(body)
  const accessToken = parsedBody.success ? parsedBody.data.accessToken : undefined
  if (!accessToken) {
    const elapsed = Date.now() - startedAt
    console.warn("[auth/verify] Rejected: MISSING_TOKEN", { ms: elapsed })
    waitUntil(logAuthEvent({ event_type: "rejected_missing_token", elapsed_ms: elapsed }))
    return jsonError(
      "MISSING_TOKEN",
      "accessToken is required and must be a string",
      400
    )
  }

  // 3. Verify the access token with Pi Platform.
  const piUser = await verifyPiAccessToken(accessToken)
  if (!piUser) {
    const elapsed = Date.now() - startedAt
    console.warn("[auth/verify] Rejected: INVALID_TOKEN", { ms: elapsed })
    waitUntil(logAuthEvent({ event_type: "rejected_invalid_token", elapsed_ms: elapsed }))
    return jsonError(
      "INVALID_TOKEN",
      "Pi Platform could not verify this access token",
      401
    )
  }
  const piTokenElapsed = Date.now() - startedAt
  console.log("[auth/verify] Pi token verified", {
    pi_uid: shortId(piUser.uid),
    pi_username: piUser.username,
    ms: piTokenElapsed,
  })
  waitUntil(logAuthEvent({
    event_type: "pi_token_verified",
    pi_uid_prefix: shortId(piUser.uid),
    pi_username: piUser.username,
    elapsed_ms: piTokenElapsed,
  }))

  // 4. Find or create the Supabase Auth user mapped to this Pioneer.
  //
  // findOrCreatePioneerUser keys on pi_username (not pi_uid) because
  // Pi.authenticate() on Testnet returns different pi_uids for the
  // same Pioneer across sessions. The function returns canonical_pi_uid
  // — the uid stored in the pioneer row — which may differ from
  // piUser.uid received this session.
  let supabaseUserId: string
  let canonicalPiUid: string
  let userCreated: boolean
  try {
    const result = await findOrCreatePioneerUser({
      pi_uid: piUser.uid,
      pi_username: piUser.username,
    })
    supabaseUserId = result.supabase_user_id
    canonicalPiUid = result.canonical_pi_uid
    userCreated = result.created
  } catch (error) {
    const elapsed = Date.now() - startedAt
    const errorMessage =
      error instanceof Error ? error.message : String(error)
    console.error("[auth/verify] User provisioning failed", {
      pi_uid: shortId(piUser.uid),
      error: errorMessage,
      ms: elapsed,
    })
    waitUntil(logAuthEvent({
      event_type: "failed_provisioning",
      pi_uid_prefix: shortId(piUser.uid),
      pi_username: piUser.username,
      error_message: errorMessage,
      elapsed_ms: elapsed,
    }))
    return jsonError(
      "PROVISIONING_ERROR",
      "Could not set up your Gyema account — please try again or contact support",
      500
    )
  }
  const provisionElapsed = Date.now() - startedAt
  const piUidRotated = canonicalPiUid !== piUser.uid
  console.log("[auth/verify] User provisioned", {
    pi_uid_received: shortId(piUser.uid),
    pi_uid_canonical: shortId(canonicalPiUid),
    pi_uid_rotated: piUidRotated,
    supabase_user_id: shortId(supabaseUserId),
    created: userCreated,
    ms: provisionElapsed,
  })
  waitUntil(logAuthEvent({
    event_type: "user_provisioned",
    pi_uid_prefix: shortId(piUser.uid),
    supabase_user_id_prefix: shortId(supabaseUserId),
    pi_username: piUser.username,
    user_created: userCreated,
    elapsed_ms: provisionElapsed,
    metadata: piUidRotated
      ? {
          pi_uid_rotated: true,
          pi_uid_canonical_prefix: shortId(canonicalPiUid),
        }
      : undefined,
  }))

  // 4b. Stamp the Pi identity into app_metadata, BEFORE the session is
  // generated so the token carries the claim.
  //
  // app_metadata is writable only with the service_role key. user_metadata,
  // where pi_uid used to live, is writable by the user themselves with
  // supabase.auth.updateUser, so every check that read it was reading a value
  // the caller chose. Routes and RLS policies now read app_metadata.
  //
  // Fatal on failure, deliberately: a session minted without the claim is one
  // that cannot read its owner's own listings, and a Pioneer would rather be
  // told to try again than be signed in to an app that behaves as though they
  // own nothing.
  try {
    await setPioneerAppMetadata({
      supabase_user_id: supabaseUserId,
      pi_uid: canonicalPiUid,
      pi_username: piUser.username,
    })
  } catch (error) {
    const elapsed = Date.now() - startedAt
    const errorMessage = error instanceof Error ? error.message : String(error)
    console.error("[auth/verify] app_metadata write failed", {
      supabase_user_id: shortId(supabaseUserId),
      error: errorMessage,
      ms: elapsed,
    })
    waitUntil(logAuthEvent({
      event_type: "failed_provisioning",
      pi_uid_prefix: shortId(canonicalPiUid),
      supabase_user_id_prefix: shortId(supabaseUserId),
      pi_username: piUser.username,
      error_message: errorMessage,
      elapsed_ms: elapsed,
    }))
    return jsonError(
      "PROVISIONING_ERROR",
      "Could not set up your Gyema account — please try again or contact support",
      500
    )
  }

  // 5. Generate a Supabase session for the Pioneer.
  //
  // Use canonical_pi_uid (the uid stored in the pioneer row), NOT
  // piUser.uid (which may be a session-rotated uid from Pi). This
  // ensures the session authenticates against the canonical auth.users
  // record so RLS-filtered queries see the Pioneer's full history.
  let session: { access_token: string; refresh_token: string }
  try {
    session = await generatePioneerSession({ pi_uid: canonicalPiUid })
  } catch (error) {
    const elapsed = Date.now() - startedAt
    const errorMessage =
      error instanceof Error ? error.message : String(error)
    console.error("[auth/verify] Session generation failed", {
      pi_uid: shortId(canonicalPiUid),
      supabase_user_id: shortId(supabaseUserId),
      error: errorMessage,
      ms: elapsed,
    })
    waitUntil(logAuthEvent({
      event_type: "failed_session",
      pi_uid_prefix: shortId(canonicalPiUid),
      supabase_user_id_prefix: shortId(supabaseUserId),
      pi_username: piUser.username,
      error_message: errorMessage,
      elapsed_ms: elapsed,
    }))
    return jsonError(
      "SESSION_ERROR",
      "Could not create your Gyema session — please try again",
      500
    )
  }

  // 6. Success.
  const totalElapsed = Date.now() - startedAt
  console.log("[auth/verify] Sign-in complete", {
    pi_uid_canonical: shortId(canonicalPiUid),
    pi_username: piUser.username,
    supabase_user_id: shortId(supabaseUserId),
    new_user: userCreated,
    ms: totalElapsed,
  })
  waitUntil(logAuthEvent({
    event_type: "sign_in_complete",
    pi_uid_prefix: shortId(canonicalPiUid),
    supabase_user_id_prefix: shortId(supabaseUserId),
    pi_username: piUser.username,
    user_created: userCreated,
    elapsed_ms: totalElapsed,
  }))

  // Response uses canonical_pi_uid so the frontend's idea of "my pi_uid"
  // matches what's stored in the database. This is important for any
  // client-side code that uses pioneer.pi_uid for further queries or
  // display.
  const response: GateSuccess = {
    ok: true,
    pioneer: {
      pi_uid: canonicalPiUid,
      pi_username: piUser.username,
      supabase_user_id: supabaseUserId,
    },
    session,
  }

  return NextResponse.json(response, { status: 200 })
}

// Helper: structured error response.
function jsonError(
  reason: GateFailureReason,
  message: string,
  status: number
) {
  const body: GateFailure = { ok: false, reason, message }
  return NextResponse.json(body, { status })
}

// All other methods rejected.
export async function GET() {
  return NextResponse.json(
    { ok: false, reason: "METHOD_NOT_ALLOWED", message: "Use POST" },
    { status: 405 }
  )
}
