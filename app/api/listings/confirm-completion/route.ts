import { NextRequest, NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase-admin"

// Server-side completion confirmation. One party stamps their own side of a
// delivery; the delivery closes when both stamps are in.
//
// This runs server-side for a different reason than the accept route. Accept
// is here because RLS cannot authorize the initial claim at all. This is here
// because RLS is ROW-level: the listings UPDATE policy admits the poster and
// the matched party to the row, and no policy clause can tell which of the
// two attestation columns a request is writing. The old client-side path took
// the party as an argument and wrote the column that argument named, so
// either party could set both flags and close a delivery alone.
//
// So the party is no longer an argument, anywhere. This route sends the
// listing id and the pi_uid it read from the caller's verified session token,
// and nothing else. Which column gets written is decided inside
// public.listing_confirm_completion, from the row: on a 'package' the poster
// is the sender, on a 'trip' the poster is the traveller. The request body
// has no role field, the RPC has no role parameter, and there is nothing
// here that would read one if a client sent it.
//
// The RPC also owns the completion transition, computed inside its UPDATE
// rather than from a prior read, so two parties confirming at the same moment
// cannot both conclude the other side is outstanding and leave the row
// both-confirmed but never completed.
//
// DEPENDS ON: db/migrations/2026-08-14_listing_completion_rls.sql, pass A.
// Until that function exists this route cannot stamp anything — PostgREST
// answers an unknown function with PGRST202 and the call lands in the catch
// below as a server_error.
//
// NOTE: service_role must hold EXECUTE on the function (the migration grants
// it, and revokes it from everyone else). The function is security definer
// and trusts the pi_uid it is handed, which is safe only because this route
// is the sole caller that can reach it and derives that uid from a verified
// token rather than from the request body.

// supabase-admin uses the Node crypto module via the admin SDK, which the
// Edge runtime does not expose. Pin this route to the Node.js runtime.
export const runtime = "nodejs"

export async function POST(request: NextRequest) {
  try {
    const { accessToken, listingId } = await request.json()

    if (!accessToken || !listingId) {
      return NextResponse.json(
        { ok: false, reason: "bad_request" },
        { status: 400 },
      )
    }

    const admin = createAdminClient()

    // Verify the caller from their Supabase session token. Never trust a
    // client-supplied uid — this is the identity the whole attestation rests
    // on. Same derivation as the accept and release routes; pi_uid lives in
    // user_metadata, written there by /api/auth/verify.
    const { data: userData, error: userErr } =
      await admin.auth.getUser(accessToken)
    if (userErr || !userData?.user) {
      return NextResponse.json(
        { ok: false, reason: "unauthorized" },
        { status: 401 },
      )
    }
    const meta = (userData.user.user_metadata ?? {}) as { pi_uid?: string }
    if (!meta.pi_uid) {
      return NextResponse.json(
        { ok: false, reason: "no_identity" },
        { status: 401 },
      )
    }

    // The stamp. Returns the listing row when this party's attestation is on
    // the record — whether this call put it there or an earlier one did — and
    // no row at all otherwise.
    const { data, error } = await admin.rpc("listing_confirm_completion", {
      p_listing_id: listingId,
      p_pi_uid: meta.pi_uid,
    })

    if (error) {
      console.error("[gyema] confirm-completion rpc error:", error)
      return NextResponse.json(
        { ok: false, reason: "server_error" },
        { status: 500 },
      )
    }

    // setof listings comes back as an array; a refusal is an empty one.
    const listing = Array.isArray(data) ? data[0] : data
    if (!listing) {
      // ONE reason for every refusal, deliberately. The function does not
      // distinguish "no such listing" from "you are not a party to it" from
      // "it is expired" from "it is already completed without your
      // attestation", and neither does this route: telling a caller which
      // one applies would tell them something about a row they may have no
      // part in. The sheet's copy is the same in every case.
      return NextResponse.json({ ok: false, reason: "not_confirmable" })
    }

    return NextResponse.json({ ok: true, listing })
  } catch (err) {
    console.error("[gyema] confirm-completion route error:", err)
    return NextResponse.json(
      { ok: false, reason: "server_error" },
      { status: 500 },
    )
  }
}
