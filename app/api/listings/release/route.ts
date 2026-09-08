import { NextRequest, NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase-admin"
import { ListingActionBody, parseJsonBody } from "@/lib/schemas"
import { resolveCaller } from "@/lib/route-auth"

// Release a claim the caller made, reverting the listing to 'open'. Called
// when the connection-fee payment is cancelled or fails after a successful
// claim, so a listing is never left matched-but-unpaid. Scoped server-side to
// the caller's OWN still-'matched' claim, verified from their session token.

// supabase-admin uses the Node crypto module via the admin SDK, which the
// Edge runtime does not expose. Pin this route to the Node.js runtime.
export const runtime = "nodejs"

export async function POST(request: NextRequest) {
  try {
    const parsed = await parseJsonBody(request, ListingActionBody)
    if (!parsed.ok) return parsed.response
    const { accessToken, listingId } = parsed.data

    const admin = createAdminClient()

    const caller = await resolveCaller(admin, accessToken)
    if (!caller) {
      return NextResponse.json(
        { ok: false, reason: "unauthorized" },
        { status: 401 },
      )
    }

    // Revert only the caller's own claim, and only while still 'matched'
    // (before any completion confirmation). Clears the match fields.
    const { data, error } = await admin
      .from("listings")
      .update({
        status: "open",
        matched_with_user_id: null,
        matched_with_username: null,
        matched_with_whatsapp: null,
        matched_at: null,
      })
      .eq("id", listingId)
      .eq("status", "matched")
      .eq("matched_with_user_id", caller.pi_uid)
      .select()
      .single()

    if (error || !data) {
      return NextResponse.json({ ok: false, reason: "not_releasable" })
    }

    return NextResponse.json({ ok: true, listing: data })
  } catch (err) {
    console.error("[gyema] release route error:", err)
    return NextResponse.json(
      { ok: false, reason: "server_error" },
      { status: 500 },
    )
  }
}
