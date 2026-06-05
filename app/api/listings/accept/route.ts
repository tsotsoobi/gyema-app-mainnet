import { NextRequest, NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase-admin"

// Server-side listing claim. Runs with the service_role client so it bypasses
// the listings RLS UPDATE policy, which only allows the poster (or an
// already-matched party) to update a row and therefore can never authorize
// the INITIAL claim by a non-owner accepter (at accept time the accepter is
// neither, so a client-side UPDATE touches 0 rows). We verify the accepter's
// identity from their Supabase session token (never trust a client-supplied
// uid) and claim atomically, guarded to OPEN, non-owner rows only.
//
// NOTE: service_role must hold UPDATE (and SELECT) on public.listings for this
// to work. A missing UPDATE grant surfaces as Postgres 42501
// "permission denied for table listings" and a silently failed claim.

// supabase-admin uses the Node crypto module via the admin SDK, which the
// Edge runtime does not expose. Pin this route to the Node.js runtime.
export const runtime = "nodejs"

export async function POST(request: NextRequest) {
  try {
    const { accessToken, listingId, accepterWhatsapp } = await request.json()

    if (!accessToken || !listingId) {
      return NextResponse.json(
        { ok: false, reason: "bad_request" },
        { status: 400 },
      )
    }

    const admin = createAdminClient()

    // Verify the accepter from their Supabase session token.
    const { data: userData, error: userErr } =
      await admin.auth.getUser(accessToken)
    if (userErr || !userData?.user) {
      return NextResponse.json(
        { ok: false, reason: "unauthorized" },
        { status: 401 },
      )
    }
    const meta = (userData.user.user_metadata ?? {}) as {
      pi_uid?: string
      pi_username?: string
    }
    if (!meta.pi_uid || !meta.pi_username) {
      return NextResponse.json(
        { ok: false, reason: "no_identity" },
        { status: 401 },
      )
    }

    // Atomic claim. Guards:
    //   .eq("status", "open")        only an open listing can be claimed
    //   .neq("posted_by_id", uid)    a Pioneer cannot accept their own listing
    // If 0 rows match, the listing is genuinely unavailable (taken, not open,
    // or own) and .single() yields an error / no data -> reason "not_open".
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

    if (error || !data) {
      return NextResponse.json({ ok: false, reason: "not_open" })
    }

    return NextResponse.json({ ok: true, listing: data })
  } catch (err) {
    console.error("[gyema] accept route error:", err)
    return NextResponse.json(
      { ok: false, reason: "server_error" },
      { status: 500 },
    )
  }
}
