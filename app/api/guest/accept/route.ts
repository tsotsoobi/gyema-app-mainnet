import { NextRequest, NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase-admin"
import { mintDeliveryCode, hashDeliveryCode } from "@/lib/delivery-code"

// Server-side guest job claim, mirroring /api/listings/accept. Verify the
// accepter from their Supabase session token, never a client-supplied uid,
// then claim atomically, guarded to verified, posted, unassigned rows.
// No Pi fee fires here: a guest job is a dispatch job, not a connection.
// Contact fields reveal ONLY in the response to the successful accepter.
//
// The claim also mints the one-time delivery code. It rides the same atomic
// update as the claim itself, so a job is never assigned without a code and
// a code is never minted for a job the courier failed to win.
export const runtime = "nodejs"

// Explicit column list, same convention as /api/guest/mine. NEVER select()
// or select("*"): guest_jobs holds sender_phone and the remit_* settlement
// economics, none of which may reach a client. Declared as an array so each
// column sits on its own line and the list stays verifiable at a glance.
//
// 9 columns. sender_phone is not one of them and must never be added here:
// the public tracker guards both sender confirmations with its last four
// digits, so a courier holding it could confirm pickup and delivery on a job
// they never carried.
//
// delivery_code_hash is not one of them either, and must never be added: the
// code space is 4 digits, so the hash IS the code to anyone holding it.
const ACCEPTED_JOB_COLUMNS = [
  "tracking_id",
  "pickup_area",
  "pickup_landmark",
  "dropoff_area",
  "dropoff_landmark",
  "recipient_name",
  "recipient_phone",
  "quote_cedis",
  "payment_type",
].join(", ")

export async function POST(request: NextRequest) {
  try {
    const { accessToken, trackingId, accepterWhatsapp } = await request.json()
    if (!accessToken || !trackingId) {
      return NextResponse.json({ ok: false, reason: "bad_request" }, { status: 400 })
    }
    const admin = createAdminClient()
    const { data: userData, error: userErr } = await admin.auth.getUser(accessToken)
    if (userErr || !userData?.user) {
      return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 })
    }
    const meta = (userData.user.user_metadata ?? {}) as {
      pi_uid?: string
      pi_username?: string
    }
    if (!meta.pi_uid || !meta.pi_username) {
      return NextResponse.json({ ok: false, reason: "no_identity" }, { status: 401 })
    }
    const deliveryCode = mintDeliveryCode()
    const { data, error } = await admin
      .from("guest_jobs")
      .update({
        status: "accepted",
        assigned_courier: meta.pi_username,
        assigned_courier_whatsapp: accepterWhatsapp ?? null,
        delivery_code_hash: hashDeliveryCode(deliveryCode),
        updated_at: new Date().toISOString(),
      })
      .eq("tracking_id", trackingId)
      .eq("status", "posted")
      .eq("phone_verified", true)
      .is("assigned_courier", null)
      .select(ACCEPTED_JOB_COLUMNS)
      .single()
    if (error || !data) {
      if (error) console.error("[gyema] guest accept update error:", error)
      return NextResponse.json({ ok: false, reason: "not_open" })
    }
    // The plaintext leaves the server exactly once, here, and is never
    // readable again: only its hash was stored. The client mapper in
    // lib/guest-jobs.ts deliberately drops it rather than surfacing it in the
    // accept sheet, since the accepter is the courier and a code the courier
    // already knows proves nothing about where they are standing.
    return NextResponse.json({ ok: true, job: data, deliveryCode })
  } catch (err) {
    console.error("[gyema] guest accept route error:", err)
    return NextResponse.json({ ok: false, reason: "server_error" }, { status: 500 })
  }
}