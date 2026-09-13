import { NextRequest, NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase-admin"
import { callerRefusalResponse, resolveCaller } from "@/lib/route-auth"
import { PaymentCompleteBody, parseJsonBody } from "@/lib/schemas"
import {
  authorizePayment,
  fetchPiPayment,
  PI_PLATFORM_BASE_URL,
} from "@/lib/payments-policy"

// Pi Platform's payment completion callback.
//
// Pi's SDK calls this once the blockchain transaction is broadcast, and we
// call Pi's /v2/payments/{id}/complete with the txid to settle it.
//
// Same three bindings as the approve route, checked the same way and for the
// same reason: a session, the payment read back from Pi rather than described
// by the caller, and a listing that is actually claimed by that caller. See
// app/api/payments/approve/route.ts for the full account, and
// lib/payments-policy.ts for the rules.
//
// The txid is validated for shape but is otherwise Pi's business: it is what
// we pass on, and Pi decides whether it settles the payment.
//
// UPSTREAM ERRORS ARE NOT ECHOED. Pi's response body goes to the server log,
// never to the caller.

export const runtime = "nodejs"

// The txid shape (64 hex characters) is checked by PaymentCompleteBody in
// lib/schemas.ts, so an arbitrary string is refused before it reaches Pi. That
// is a shape check, not a claim about the chain.

export async function POST(request: NextRequest) {
  try {
    const parsed = await parseJsonBody(request, PaymentCompleteBody)
    if (!parsed.ok) return parsed.response
    const { accessToken, paymentId, txid } = parsed.data

    const apiKey = process.env.PI_API_KEY
    if (!apiKey) {
      console.error("[gyema] PI_API_KEY not set in environment")
      return NextResponse.json({ ok: false, reason: "server_misconfigured" }, { status: 500 })
    }

    const admin = createAdminClient()
    // resolveCaller now says WHY it refused. A 401 means the caller is not who
    // they need to be; a 503 means we could not ask Supabase Auth, which is a
    // different thing and used to be reported as the first one.
    // callerVerdict, not verdict: this route already has a `verdict` for the
    // payment policy check below, and the two decide different things.
    const callerVerdict = await resolveCaller(admin, accessToken)
    if (!callerVerdict.ok) return callerRefusalResponse(callerVerdict)
    const caller = callerVerdict.caller

    const payment = await fetchPiPayment(paymentId, apiKey)
    if (!payment) {
      return NextResponse.json({ ok: false, reason: "payment_not_found" }, { status: 404 })
    }

    const verdict = await authorizePayment({ admin, caller, payment, paymentId })
    if (!verdict.ok) {
      console.warn("[gyema] complete refused:", verdict.reason)
      return NextResponse.json({ ok: false, reason: "not_authorized" }, { status: 403 })
    }

    const piResponse = await fetch(
      `${PI_PLATFORM_BASE_URL}/v2/payments/${paymentId}/complete`,
      {
        method: "POST",
        headers: {
          Authorization: `Key ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ txid }),
      }
    )

    if (!piResponse.ok) {
      const errorText = await piResponse.text()
      console.error("[gyema] Pi complete failed:", piResponse.status, errorText)
      return NextResponse.json({ ok: false, reason: "pi_complete_failed" }, { status: 502 })
    }

    // The txid is logged: it is a public blockchain identifier, not a secret,
    // and it is what makes a payment traceable afterwards.
    console.log("[gyema] Payment completed:", paymentId, "txid:", txid, "kind:", verdict.kind)
    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error("[gyema] Complete route error:", error)
    return NextResponse.json({ ok: false, reason: "server_error" }, { status: 500 })
  }
}
