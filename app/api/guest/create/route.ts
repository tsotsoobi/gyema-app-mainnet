import { NextRequest, NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase-admin"
import { GUEST_AREAS, quoteCedis as computeQuoteCedis } from "@/lib/guest-pricing"
import { GuestCreateBody, parseJsonBody } from "@/lib/schemas"
import { checkLimit, ipIdentifier, phoneIdentifier, retryAfterHeaders } from "@/lib/rate-limit"
import { isTurnstileConfigured, verifyTurnstileToken } from "@/lib/turnstile"

// Guest create: the cedis dispatch rail. Writes an UNVERIFIED draft to
// guest_jobs (phone_verified = false). Nothing in this codebase flips that
// flag: the operator matches the sender's WhatsApp message to the row and
// sets phone_verified = true by hand in the Supabase dashboard. There is no
// OTP send or verify route, on either network. The dispatcher queue only
// reads phone_verified = true rows, so no courier is ever assigned to a job
// the operator has not matched. This route never touches `listings`,
// never fires a 1 Pi connection-fee event: two rails, never blended.
//
// Runs with the service_role admin client because guest_jobs has RLS enabled
// with no public policy (the public anon key cannot read/write it). service_role
// must hold INSERT/SELECT on public.guest_jobs or this surfaces as Postgres
// 42501 and a silent failure, same caveat as the accept route.
//
// Admin SDK uses Node crypto, which the Edge runtime does not expose.
export const runtime = "nodejs"

// Area validation and server-side pricing come from lib/guest-pricing.

// Free-text normalizer for hand-typed strings. Trims, and collapses a
// whitespace-only value to null so an optional field left blank stores NULL
// rather than " ". A non-string, including a missing field, returns null:
// the required-field check below rejects the two that matter, and the
// optional ones were already inserting null for a missing field.
//
// Untrimmed values reached guest_jobs exactly as typed, so "Kutunse " and
// "Kutunse" were two different areas to every exact-match comparison,
// including operator SQL. Found live 21 August on three rows across both
// networks. Phones are deliberately not normalized here: both last-4 guards
// strip non-digits before comparing (app/api/guest/delivery-code/route.ts,
// app/api/guest/confirm-delivery/route.ts), so whitespace cannot reach them.
function cleanText(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed === "" ? null : trimmed
}

function mintGymCode(): string {
  return `GYM-${Math.random().toString(16).slice(2, 8).toUpperCase()}`
}

// Collision-safe: the guest rail is the only new entrant to the shared GYM
// space, so verifying absence from BOTH tables here guarantees one-ID-one-row
// across guest and Pioneer rails. Retries on the rare hit.
async function generateUniqueTrackingId(
  admin: ReturnType<typeof createAdminClient>,
): Promise<string | null> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = mintGymCode()
    const [{ data: l }, { data: g }] = await Promise.all([
      admin.from("listings").select("tracking_id").eq("tracking_id", code).maybeSingle(),
      admin.from("guest_jobs").select("tracking_id").eq("tracking_id", code).maybeSingle(),
    ])
    if (!l && !g) return code
  }
  return null
}

export async function POST(request: NextRequest) {
  if (process.env.NEXT_PUBLIC_GUEST_SEND_ENABLED !== "true") {
    return NextResponse.json({ ok: false, reason: "disabled" }, { status: 403 })
  }

  // Two rate-limit keys guard this route and they are checked at different
  // points, which is the whole design rather than an accident of ordering.
  //
  // The ADDRESS key is checked here, before the body is read, so a flood of
  // malformed payloads is refused without being parsed. It is deliberately
  // loose (twenty an hour) because Ghanaian mobile data is heavily NAT-shared
  // and this is the one page reached from an ordinary browser rather than from
  // Pi Browser: a tight number here would refuse a real sender because a
  // stranger on the same carrier posted first.
  //
  // The SENDER PHONE key is checked further down, once the body has been
  // validated, and it is the tight one (four an hour). It is per person rather
  // than per network path, so NAT does not blunt it.
  //
  // Both FAIL CLOSED on a Redis error. This is the only route in the app where
  // an unauthenticated stranger writes a row, so a limiter that cannot count
  // means the flood control is simply gone. The cost is stated plainly: while
  // Upstash is unreachable, guest posting is refused, and a sender is told to
  // try again shortly rather than being quietly let through unlimited. A
  // deployment with no Upstash credentials at all is a different case and runs
  // unlimited, exactly as it did before (lib/rate-limit.ts, limiterConfigured).
  const ip = ipIdentifier(request)
  const ipLimit = await checkLimit("guest_create_ip", ip)
  if (!ipLimit.ok) {
    return NextResponse.json(
      { ok: false, reason: ipLimit.reason },
      { status: 429, headers: retryAfterHeaders(ipLimit.retryAfterSeconds) }
    )
  }

  try {
    // GuestCreateBody does the trimming, the required fields, the enums, the
    // length caps and the phone shape. This is the only route in the app an
    // unauthenticated stranger can write a row with, so every field it accepts
    // is bounded: see lib/schemas.ts for what each cap is and why.
    //
    // cleanText still runs below on the optional free text, because zod's trim
    // leaves an empty string where this table wants a NULL.
    const parsed = await parseJsonBody(request, GuestCreateBody)
    if (!parsed.ok) return parsed.response
    const {
      pickupArea,
      dropoffArea,
      packageSize,
      senderPhone,
      recipientPhone,
      whenPref,
      scheduledDate,
      paymentType,
      offList,
    } = parsed.data

    const pickupLandmark = cleanText(parsed.data.pickupLandmark)
    const dropoffLandmark = cleanText(parsed.data.dropoffLandmark)
    const contentsNote = cleanText(parsed.data.contentsNote)
    const recipientName = cleanText(parsed.data.recipientName)

    // The bounded area list stays here rather than in the schema: it is a
    // product decision that changes as corridors open, and off-list jobs
    // deliberately bypass it and route to a human quote.
    if (!offList && (!(pickupArea in GUEST_AREAS) || !(dropoffArea in GUEST_AREAS))) {
      return NextResponse.json({ ok: false, reason: "unbounded_city" }, { status: 400 })
    }

    // The bot check, and it runs ONLY when both Turnstile keys are set on this
    // deployment. Either one missing and this block is skipped entirely, so a
    // half-configured environment behaves exactly as it did before Turnstile
    // existed rather than refusing every post. The reasoning for that default
    // is written out in lib/turnstile.ts.
    //
    // Placed after validation and before the tracking-ID generation, which is
    // where the expensive work starts: a challenge is checked before up to
    // eight pairs of collision lookups are spent on the caller.
    if (isTurnstileConfigured()) {
      const verdict = await verifyTurnstileToken(parsed.data.turnstileToken, ip)
      if (!verdict.ok) {
        // One reason for all three failure modes. A caller does not need to
        // know whether their token was missing, replayed, or whether
        // Cloudflare was unreachable, and telling them which would let a
        // script tell a rejected challenge apart from an outage and wait for
        // the outage.
        console.warn("[gyema] guest create turnstile refusal:", verdict.reason)
        return NextResponse.json({ ok: false, reason: "bot_check_failed" }, { status: 403 })
      }
    }

    // The tight, per-person half of the rate limit. Checked here rather than
    // at the top because the phone number is not known until the body has been
    // validated, and checked before the insert so a burst costs no rows.
    //
    // The identifier is a truncated hash of the national digits, never the
    // number itself: a rate-limit key ends up in an Upstash console and in
    // support screenshots. See phoneIdentifier for why that is hygiene rather
    // than protection.
    const phoneLimit = await checkLimit("guest_create_phone", phoneIdentifier(senderPhone))
    if (!phoneLimit.ok) {
      return NextResponse.json(
        { ok: false, reason: phoneLimit.reason },
        { status: 429, headers: retryAfterHeaders(phoneLimit.retryAfterSeconds) }
      )
    }

    const admin = createAdminClient()

    const trackingId = await generateUniqueTrackingId(admin)
    if (!trackingId) {
      return NextResponse.json({ ok: false, reason: "id_generation_failed" }, { status: 500 })
    }

    const { data, error } = await admin
      .from("guest_jobs")
      .insert({
        tracking_id: trackingId,
        pickup_area: pickupArea,
        pickup_landmark: pickupLandmark ?? null,
        dropoff_area: dropoffArea,
        dropoff_landmark: dropoffLandmark ?? null,
        package_size: packageSize,
        contents_note: contentsNote ?? null,
        recipient_name: recipientName ?? null,
        recipient_phone: recipientPhone ?? null,
        sender_phone: senderPhone,
        phone_verified: false,
        when_pref: whenPref ?? null,
        scheduled_date: scheduledDate ?? null,
        payment_type: paymentType ?? null,
        quote_cedis: offList ? null : computeQuoteCedis(pickupArea, dropoffArea),
        status: offList ? "pending_quote" : "posted",
      })
      .select()
      .single()

    if (error || !data) {
      console.error("[gyema] guest create error:", error)
      return NextResponse.json({ ok: false, reason: "insert_failed" }, { status: 500 })
    }

    // Return only the tracking ID and status. The draft is inert until the
    // operator sets phone_verified = true by hand in the dashboard.
    return NextResponse.json({
      ok: true,
      trackingId: data.tracking_id,
      status: data.status,
    })
  } catch (err) {
    console.error("[gyema] guest create route error:", err)
    return NextResponse.json({ ok: false, reason: "server_error" }, { status: 500 })
  }
}