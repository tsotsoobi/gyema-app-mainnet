import { NextRequest, NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase-admin"
import { resolveCaller } from "@/lib/route-auth"
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

// Stellar transaction hashes are 64 hex characters. Checked for shape so an
// arbitrary string is refused before it reaches Pi, not to validate the chain.
const TXID = /^[0-9a-fA-F]{64}$/

export async function POST(request: NextRequest) {
  try {
    const { accessToken, paymentId, txid } = await request.json()

    if (!paymentId || typeof paymentId !== "string" || !txid || typeof txid !== "string") {
      return NextResponse.json({ ok: false, reason: "bad_request" }, { status: 400 })
    }
    if (!TXID.test(txid)) {
      return NextResponse.json({ ok: false, reason: "bad_txid" }, { status: 400 })
    }

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
