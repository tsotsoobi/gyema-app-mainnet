import { NextRequest, NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase-admin"

// Server-side listing claim. Runs with the service_role client so it bypasses
// the listings RLS UPDATE policy, which only allows the poster (or an
// already-matched party) to update a row and therefore can never authorize
// the INITIAL claim by a non-owner accepter. We verify the accepter's
// identity from their Supabase session token and claim atomically, guarded
// to OPEN, non-owner rows only.
//
// TEMPORARY DIAGNOSTICS: this version records its decision path to the
// public.accept_debug table on every invocation, because Vercel function
// logs are not reliably queryable on the current plan. Remove the `diag`
// object and the finally block once the accept failure is understood.

// supabase-admin uses the Node crypto module via the admin SDK, which the
// Edge runtime does not expose. Pin this route to the Node.js runtime.
export const runtime = "nodejs"

export async function POST(request: NextRequest) {
  const diag: Record<string, unknown> = {}
  let admin: ReturnType<typeof createAdminClient> | null = null

  try {
    const { accessToken, listingId, accepterWhatsapp } = await request.json()
    diag.has_token = !!accessToken
    diag.token_len = typeof accessToken === "string" ? accessToken.length : 0
    diag.listing_id = listingId ?? null

    if (!accessToken || !listingId) {
      diag.branch = "bad_request"
      return NextResponse.json(
        { ok: false, reason: "bad_request" },
        { status: 400 },
      )
    }

    admin = createAdminClient()

    // Verify the accepter from their Supabase session token.
    const { data: userData, error: userErr } =
      await admin.auth.getUser(accessToken)
    diag.getuser_error = userErr?.message ?? null
    diag.user_id = userData?.user?.id ?? null
    if (userErr || !userData?.user) {
      diag.branch = "unauthorized"
      return NextResponse.json(
        { ok: false, reason: "unauthorized" },
        { status: 401 },
      )
    }

    const meta = (userData.user.user_metadata ?? {}) as {
      pi_uid?: string
      pi_username?: string
    }
    diag.meta_pi_uid = meta.pi_uid ?? null
    diag.meta_pi_username = meta.pi_username ?? null
    if (!meta.pi_uid || !meta.pi_username) {
      diag.branch = "no_identity"
      return NextResponse.json(
        { ok: false, reason: "no_identity" },
        { status: 401 },
      )
    }

    // Atomic claim, guarded to OPEN, non-owner rows only.
    const { data, error } = await admin
      .from("listings")
      .update({
        status: "matched",
        matched_with_user_id: meta.pi_uid,
        matched_with_username: meta.pi_username,
        matched_with_whatsapp: accepterWhatsapp ?? null,
        matched_at: new Date().toISOString(),
      })
      .eq("id", listingId)
      .eq("status", "open")
      .neq("posted_by_id", meta.pi_uid)
      .select()
      .single()

    diag.update_error = error?.message ?? null
    diag.update_code = (error as { code?: string } | null)?.code ?? null
    diag.update_got_row = !!data

    if (error || !data) {
      diag.branch = "not_open"
      return NextResponse.json({ ok: false, reason: "not_open" })
    }

    diag.branch = "ok"
    return NextResponse.json({ ok: true, listing: data })
  } catch (err) {
    diag.branch = "server_error"
    diag.exception = err instanceof Error ? err.message : String(err)
    console.error("[gyema] accept route error:", err)
    return NextResponse.json(
      { ok: false, reason: "server_error" },
      { status: 500 },
    )
  } finally {
    // Best-effort: record the decision path so it can be queried in Supabase.
    try {
      if (!admin) admin = createAdminClient()
      await admin.from("accept_debug").insert({ detail: diag })
    } catch (e) {
      console.error("[gyema] accept_debug insert failed:", e)
    }
  }
}
