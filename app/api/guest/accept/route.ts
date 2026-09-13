import { NextRequest, NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase-admin"
import { callerRefusalResponse, resolveCaller } from "@/lib/route-auth"
import { GuestAcceptBody, parseJsonBody } from "@/lib/schemas"
import { mintDeliveryCode, hashDeliveryCode } from "@/lib/delivery-code"

// Server-side guest job claim, mirroring /api/listings/accept. Verify the
// accepter from their Supabase session token, never a client-supplied uid,
// then claim atomically, guarded to verified, posted, unassigned rows.
// No Pi fee fires here: a guest job is a dispatch job, not a connection.
// Contact fields reveal ONLY in the response to the successful accepter.
//
// The claim also mints the one-time delivery code. It rides the same atomic
// update as the claim itself, so a job is never assigned without a code and
// a code is never minted for a job the courier failed to win. Only the hash
// is kept, and the plaintext is discarded here: it is not returned to the
// courier, who is the one party it exists as evidence against.
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
    const parsed = await parseJsonBody(request, GuestAcceptBody)
    if (!parsed.ok) return parsed.response
    const { accessToken, trackingId, accepterWhatsapp } = parsed.data
    const admin = createAdminClient()
    // resolveCaller now says WHY it refused. A 401 means the caller is not who
    // they need to be; a 503 means we could not ask Supabase Auth, which is a
    // different thing and used to be reported as the first one.
    const verdict = await resolveCaller(admin, accessToken)
    if (!verdict.ok) return callerRefusalResponse(verdict)
    const caller = verdict.caller
    const deliveryCode = mintDeliveryCode()
    const { data, error } = await admin
      .from("guest_jobs")
      .update({
        status: "accepted",
        assigned_courier: caller.pi_username,
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
    // THE PLAINTEXT CODE IS NOT IN THIS RESPONSE. It used to be, and the
    // reasoning was that the client mapper dropped it rather than showing it
    // in the accept sheet. That is a UI decision, not a control: the value was
    // in the HTTP response, one glance at a network tab away (finding S-4).
    //
    // The code is the courier's proof that they reached the door and the
    // recipient spoke it aloud. A courier who has it at claim time, hours
    // before they collect anything, can stamp a delivery they never made. So
    // it is minted here, hashed into the row here, and leaves the server only
    // through /api/guest/delivery-code, to the sender, behind the last-4
    // guard, for the sender to carry to the recipient.
    return NextResponse.json({ ok: true, job: data })
  } catch (err) {
    console.error("[gyema] guest accept route error:", err)
    return NextResponse.json({ ok: false, reason: "server_error" }, { status: 500 })
  }
}