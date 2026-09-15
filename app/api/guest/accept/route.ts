import { NextRequest, NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase-admin"
import { callerRefusalResponse, resolveCaller } from "@/lib/route-auth"
import { GuestAcceptBody, parseJsonBody } from "@/lib/schemas"
import { mintDeliveryCode, hashDeliveryCode } from "@/lib/delivery-code"
import { courierSplit, recordedSplit } from "@/lib/guest-commission"

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
//
// The claim also records what the courier owes Gyema. remit_cedis is computed
// by lib/guest-commission.ts from the quote on the row, and written in the same
// UPDATE that assigns the courier, guarded on that same quote. A job repriced
// between the read and the write matches zero rows and is refused, so the
// commission always belongs to the quote it was written against, and a later
// ladder or rate change cannot move what the courier agreed to. A job with no
// usable quote, such as an off-list job posted before it was priced, cannot be
// claimed.
export const runtime = "nodejs"

// Explicit column list, same convention as /api/guest/mine. NEVER select()
// or select("*"): guest_jobs holds sender_phone and the remit_* settlement
// columns. Of those, remit_cedis alone reaches a client, and only this one:
// the courier who has just claimed the job, who is the person who owes it.
// remit_pi, remit_rate, remit_method, remit_paid_at and remit_ref never do.
// Declared as an array so each column sits on its own line and the list stays
// verifiable at a glance.
//
// 10 columns. sender_phone is not one of them and must never be added here:
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
  "remit_cedis",
].join(", ")

// The row those 10 columns produce, declared for the same reason as in
// /api/guest/mine: supabase-js cannot infer a row shape from a joined constant.
type AcceptedJobRow = {
  tracking_id: string
  pickup_area: string
  pickup_landmark: string | null
  dropoff_area: string
  dropoff_landmark: string | null
  recipient_name: string | null
  recipient_phone: string | null
  quote_cedis: number | null
  payment_type: string | null
  remit_cedis: number | null
}

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

    // The quote the commission is computed from, read under the same guards the
    // claim uses. Nothing is written for a job that is not claimable or has no
    // usable quote.
    const { data: claimable, error: readError } = await admin
      .from("guest_jobs")
      .select("quote_cedis")
      .eq("tracking_id", trackingId)
      .eq("status", "posted")
      .eq("phone_verified", true)
      .is("assigned_courier", null)
      .maybeSingle()
    if (readError) console.error("[gyema] guest accept read error:", readError)
    const split = claimable ? courierSplit(claimable.quote_cedis) : null
    if (!claimable || !split) {
      return NextResponse.json({ ok: false, reason: "not_open" })
    }

    const deliveryCode = mintDeliveryCode()
    const { data, error } = await admin
      .from("guest_jobs")
      .update({
        status: "accepted",
        assigned_courier: caller.pi_username,
        assigned_courier_whatsapp: accepterWhatsapp ?? null,
        delivery_code_hash: hashDeliveryCode(deliveryCode),
        remit_cedis: split.commissionCedis,
        updated_at: new Date().toISOString(),
      })
      .eq("tracking_id", trackingId)
      .eq("status", "posted")
      .eq("phone_verified", true)
      .is("assigned_courier", null)
      // The commission above was computed from this exact quote. If the quote
      // changed since the read, this matches nothing and the claim is refused.
      .eq("quote_cedis", claimable.quote_cedis)
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

    // The figures the courier is shown come from what was written, not from
    // the preview: remit_cedis as stored, and what they keep derived from it.
    const row = data as unknown as AcceptedJobRow
    const recorded = recordedSplit(row.quote_cedis, row.remit_cedis)
    return NextResponse.json({
      ok: true,
      job: {
        ...row,
        keeps_cedis: recorded?.keepsCedis ?? null,
        commission_rate_label: recorded?.rateLabel ?? null,
      },
    })
  } catch (err) {
    console.error("[gyema] guest accept route error:", err)
    return NextResponse.json({ ok: false, reason: "server_error" }, { status: 500 })
  }
}