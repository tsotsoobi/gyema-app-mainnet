import { NextRequest, NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase-admin"
import { GUEST_AREAS, quoteCedis as computeQuoteCedis } from "@/lib/guest-pricing"

// Guest create: the cedis dispatch rail. Writes an UNVERIFIED draft to
// guest_jobs (phone_verified = false). A separate verify step flips the flag;
// the dispatcher queue only reads phone_verified = true rows, so no courier is
// ever assigned to an unverified job. This route never touches `listings`,
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
  try {
    const body = await request.json()
    const {
      pickupArea: rawPickupArea, pickupLandmark: rawPickupLandmark,
      dropoffArea: rawDropoffArea, dropoffLandmark: rawDropoffLandmark,
      packageSize, contentsNote: rawContentsNote,
      recipientName: rawRecipientName, recipientPhone,
      senderPhone,
      whenPref, scheduledDate,
      paymentType,
      offList,
    } = body ?? {}

    // Normalized before any validation, so the required check, the bounded-list
    // check, the price computation and the insert all read one value.
    const pickupArea = cleanText(rawPickupArea)
    const dropoffArea = cleanText(rawDropoffArea)
    const pickupLandmark = cleanText(rawPickupLandmark)
    const dropoffLandmark = cleanText(rawDropoffLandmark)
    const contentsNote = cleanText(rawContentsNote)
    const recipientName = cleanText(rawRecipientName)

    // Required-field validation
    if (!pickupArea || !dropoffArea || !packageSize || !senderPhone) {
      return NextResponse.json({ ok: false, reason: "bad_request" }, { status: 400 })
    }
    // Bounded city list (same normalized set as the app)
    if (!offList && (!(pickupArea in GUEST_AREAS) || !(dropoffArea in GUEST_AREAS))) {
      return NextResponse.json({ ok: false, reason: "unbounded_city" }, { status: 400 })
    }
    if (!["small", "medium", "large"].includes(packageSize)) {
      return NextResponse.json({ ok: false, reason: "bad_size" }, { status: 400 })
    }
    if (paymentType && !["cash", "momo"].includes(paymentType)) {
      return NextResponse.json({ ok: false, reason: "bad_payment" }, { status: 400 })
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

    // Return only the tracking ID and status. The draft is inert until a
    // separate verify step sets phone_verified = true.
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