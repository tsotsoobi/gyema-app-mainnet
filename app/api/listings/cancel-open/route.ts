import { NextRequest, NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase-admin"
import { ListingActionBody, parseJsonBody } from "@/lib/schemas"
import { resolveCaller } from "@/lib/route-auth"

// Cancel an OPEN listing, before anyone has claimed it. Poster only.
//
// This used to be a client side UPDATE through the authed client
// (cancelOpenListingAsync), which worked because authenticated held UPDATE on
// every column of listings including status. It does not any more:
// db/migrations/2026-09-07_grant_baseline.sql grants UPDATE on the two archive
// columns and nothing else, so a status write from a browser is refused with
// 42501.
//
// That is the point rather than an inconvenience. A client that can write
// status can write any status, on any row the UPDATE policy admits it to: mark
// somebody else's delivery in transit, expire an open listing out from under
// its poster, or walk a row to completed. The policy is row level and cannot
// see which column a request touches. So the transitions move here, where the
// caller is resolved from their session token and the legal states are named.
//
// Transitions: open -> expired. Deliberately not a delete. The row stays, its
// tracking ID keeps resolving on the public tracker, and it falls into Past
// Trips and Deliveries. There is no delete of a listing anywhere in this app
// and authenticated holds no DELETE grant.
//
// Race guard: .eq("status", "open") means an accept that lands between the
// sheet rendering and the tap wins. We never yank a match somebody has already
// paid a connection fee for.

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

    // Poster only, and only while still open. Both guards ride the UPDATE so
    // there is no read-then-write window for a concurrent accept to slip
    // through.
    const { data, error } = await admin
      .from("listings")
      .update({ status: "expired" })
      .eq("id", listingId)
      .eq("status", "open")
      .eq("posted_by_id", caller.pi_uid)
      .select("id, status")
      .maybeSingle()

    if (error) {
      console.error("[gyema] cancel-open update error:", error.message)
      return NextResponse.json({ ok: false, reason: "update_failed" }, { status: 500 })
    }
    if (!data) {
      // Not open any more, or not the caller's listing. One answer for both,
      // so this cannot be used to probe who posted what.
      return NextResponse.json({ ok: false, reason: "not_cancellable" }, { status: 409 })
    }

    return NextResponse.json({ ok: true, listingId: data.id, status: data.status })
  } catch (err) {
    console.error("[gyema] cancel-open route error:", err)
    return NextResponse.json({ ok: false, reason: "server_error" }, { status: 500 })
  }
}
