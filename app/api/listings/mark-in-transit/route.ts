import { NextRequest, NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase-admin"
import { ListingActionBody, parseJsonBody } from "@/lib/schemas"
import { resolveCaller, travellerUid } from "@/lib/route-auth"

// Mark a matched listing as picked up. The TRAVELLER only.
//
// Moved server side with the other two status transitions. See
// app/api/listings/cancel-open/route.ts for why a client cannot write status.
//
// WHICH SIDE IS THE TRAVELLER IS DERIVED HERE, FROM THE ROW.
//
// On a 'trip' the poster is the traveller and the matched party is the sender.
// On a 'package' it is the other way round. The old client side version had no
// such check: its comment said "traveller-only in practice (the UI gates the
// action)", which is a gate a REST client walks straight past. Either party
// could mark a delivery picked up, including the sender, on any row the UPDATE
// policy admitted them to.
//
// The request body carries the listing id and the session token and nothing
// else. There is no role, party or side argument, and there is nothing here
// that would read one if a client sent it. That is CLAUDE.md invariant 1 and
// it is the same rule the F17 fix established for completion.
//
// Transitions: matched -> in_transit. A read is needed first because the
// traveller depends on kind, so this is a read then a guarded write rather
// than a single statement; the write re-guards on status and on the matched
// party, so a concurrent cancel or release wins rather than being overwritten.

export const runtime = "nodejs"

export async function POST(request: NextRequest) {
  try {
    const parsed = await parseJsonBody(request, ListingActionBody)
    if (!parsed.ok) return parsed.response
    const { accessToken, listingId } = parsed.data

    const admin = createAdminClient()
    const caller = await resolveCaller(admin, accessToken)
    if (!caller) {
      return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 })
    }

    const { data: listing, error: readError } = await admin
      .from("listings")
      .select("id, kind, status, posted_by_id, matched_with_user_id")
      .eq("id", listingId)
      .maybeSingle()

    if (readError) {
      console.error("[gyema] mark-in-transit read error:", readError.message)
      return NextResponse.json({ ok: false, reason: "lookup_failed" }, { status: 500 })
    }
    // No such listing and not-your-listing give the same answer below.
    if (!listing) {
      return NextResponse.json({ ok: false, reason: "not_transitionable" }, { status: 409 })
    }

    const traveller = travellerUid(listing as never)
    if (!traveller || traveller !== caller.pi_uid) {
      // The sender asking to mark their own delivery picked up lands here, and
      // so does a stranger. Same answer for both.
      return NextResponse.json({ ok: false, reason: "not_traveller" }, { status: 403 })
    }

    const { data, error } = await admin
      .from("listings")
      .update({ status: "in_transit" })
      .eq("id", listingId)
      .eq("status", "matched")
      .select("id, status")
      .maybeSingle()

    if (error) {
      console.error("[gyema] mark-in-transit update error:", error.message)
      return NextResponse.json({ ok: false, reason: "update_failed" }, { status: 500 })
    }
    if (!data) {
      // State moved between the read and the write. Report honestly.
      return NextResponse.json({ ok: false, reason: "not_transitionable" }, { status: 409 })
    }

    return NextResponse.json({ ok: true, listingId: data.id, status: data.status })
  } catch (err) {
    console.error("[gyema] mark-in-transit route error:", err)
    return NextResponse.json({ ok: false, reason: "server_error" }, { status: 500 })
  }
}
