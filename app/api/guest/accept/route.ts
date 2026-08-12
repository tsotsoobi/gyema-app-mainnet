import { NextRequest, NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase-admin"

// Server-side guest job claim, mirroring /api/listings/accept. Verify the
// accepter from their Supabase session token, never a client-supplied uid,
// then claim atomically, guarded to verified, posted, unassigned rows.
// No Pi fee fires here: a guest job is a dispatch job, not a connection.
// Contact fields reveal ONLY in the response to the successful accepter.
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
    const { data, error } = await admin
      .from("guest_jobs")
      .update({
        status: "accepted",
        assigned_courier: meta.pi_username,
        assigned_courier_whatsapp: accepterWhatsapp ?? null,
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
    return NextResponse.json({ ok: true, job: data })
  } catch (err) {
    console.error("[gyema] guest accept route error:", err)
    return NextResponse.json({ ok: false, reason: "server_error" }, { status: 500 })
  }
}