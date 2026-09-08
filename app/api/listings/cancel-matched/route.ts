import { NextRequest, NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase-admin"
import { ListingActionBody, parseJsonBody } from "@/lib/schemas"
import { resolveCaller } from "@/lib/route-auth"

// Cancel a MATCHED or IN TRANSIT listing when a deal falls through. Either
// party may call it: the poster or the Pioneer who claimed it.
//
// Moved server side for the same reason as cancel-open. See that file's header
// for why a client cannot be allowed to write status at all.
//
// Transitions: matched or in_transit -> expired. Never from open (that is
// cancel-open, and it has a different party rule) and never from completed,
// which is terminal.
//
// The party check is an OR over the two identity columns rather than a
// membership test done in application code, so it rides the UPDATE and cannot
// race a concurrent release. Note the .or() takes a PostgREST filter string:
// pi_uid values come from a verified session and Pi usernames are alphanumeric,
// but the value is still interpolated, so it is validated below before it goes
// anywhere near the filter.

export const runtime = "nodejs"

// PostgREST filter syntax treats , ( ) and . as structure. A pi_uid that
// contained one would change the shape of the filter rather than the value,
// so anything outside this set is refused before the query is built. This is
// belt and braces: the uid comes from a Supabase session, not from the body.
const SAFE_UID = /^[A-Za-z0-9_-]{1,128}$/

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
    if (!SAFE_UID.test(caller.pi_uid)) {
      console.error("[gyema] cancel-matched: uid failed the filter safety check")
      return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 })
    }

    const { data, error } = await admin
      .from("listings")
      .update({ status: "expired" })
      .eq("id", listingId)
      .in("status", ["matched", "in_transit"])
      .or(
        `posted_by_id.eq.${caller.pi_uid},matched_with_user_id.eq.${caller.pi_uid}`
      )
      .select("id, status")
      .maybeSingle()

    if (error) {
      console.error("[gyema] cancel-matched update error:", error.message)
      return NextResponse.json({ ok: false, reason: "update_failed" }, { status: 500 })
    }
    if (!data) {
      return NextResponse.json({ ok: false, reason: "not_cancellable" }, { status: 409 })
    }

    return NextResponse.json({ ok: true, listingId: data.id, status: data.status })
  } catch (err) {
    console.error("[gyema] cancel-matched route error:", err)
    return NextResponse.json({ ok: false, reason: "server_error" }, { status: 500 })
  }
}
