import { NextRequest, NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase-admin"
import { resolveCaller } from "@/lib/route-auth"
import { PaymentApproveBody, parseJsonBody } from "@/lib/schemas"
import {
  authorizePayment,
  fetchPiPayment,
  PI_PLATFORM_BASE_URL,
} from "@/lib/payments-policy"

// Pi Platform's payment approval callback.
//
// Pi's SDK calls this when a Pioneer approves a payment in their wallet, and
// we call Pi's /v2/payments/{id}/approve to confirm it from the app side.
//
// WHAT CHANGED, AND WHY IT HAD TO
//
// This route used to take a paymentId and nothing else, from anybody. No
// session, no binding to a listing, no expected amount. Any caller on the
// internet could POST an identifier and make Gyema's server spend PI_API_KEY
// approving it (finding S-3).
//
// Now: a session is required, the payment is read back FROM PI rather than
// described by the caller, and it is checked against what this app actually
// creates. lib/payments-policy.ts holds those rules. A connection fee must
// name a listing currently claimed by the caller; a checklist test must be the
// checklist amount. Anything else is refused before Pi is called at all.
//
// This does change payment outcomes, which the hardening brief puts off limits
// by default. It is here on an explicit instruction, and the shape is
// deliberately conservative: nothing about amounts, fees or the escrow design
// moves, and every refusal is a payment this app would not have created.
//
// UPSTREAM ERRORS ARE NOT ECHOED. The old version returned Pi's raw response
// body and status to the caller, which with no authentication was an oracle
// against Pi's payment API. Pi's detail goes to the server log; the caller
// gets a reason and a status.

export const runtime = "nodejs"

export async function POST(request: NextRequest) {
  try {
    const parsed = await parseJsonBody(request, PaymentApproveBody)
    if (!parsed.ok) return parsed.response
    const { accessToken, paymentId } = parsed.data

    const apiKey = process.env.PI_API_KEY
    if (!apiKey) {
      console.error("[gyema] PI_API_KEY not set in environment")
      return NextResponse.json({ ok: false, reason: "server_misconfigured" }, { status: 500 })
    }

    const admin = createAdminClient()
    const caller = await resolveCaller(admin, accessToken)
    if (!caller) {
      return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 })
    }

    // Read the payment from Pi. Everything checked below comes from this
    // record, not from the request body.
    const payment = await fetchPiPayment(paymentId, apiKey)
    if (!payment) {
      return NextResponse.json({ ok: false, reason: "payment_not_found" }, { status: 404 })
    }

    const verdict = await authorizePayment({ admin, caller, payment, paymentId })
    if (!verdict.ok) {
      console.warn("[gyema] approve refused:", verdict.reason)
      return NextResponse.json({ ok: false, reason: "not_authorized" }, { status: 403 })
    }

    const piResponse = await fetch(
      `${PI_PLATFORM_BASE_URL}/v2/payments/${paymentId}/approve`,
      {
        method: "POST",
        headers: {
          Authorization: `Key ${apiKey}`,
          "Content-Type": "application/json",
        },
      }
    )

    if (!piResponse.ok) {
      // Logged in full here, where only we can read it. Never returned.
      const errorText = await piResponse.text()
      console.error("[gyema] Pi approve failed:", piResponse.status, errorText)
      return NextResponse.json({ ok: false, reason: "pi_approve_failed" }, { status: 502 })
    }

    console.log("[gyema] Payment approved:", paymentId, "kind:", verdict.kind)
    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error("[gyema] Approve route error:", error)
    return NextResponse.json({ ok: false, reason: "server_error" }, { status: 500 })
  }
}
