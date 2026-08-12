import { NextRequest, NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase-admin"

// The courier's own accepted guest jobs. Before this route the accept sheet
// was the only view of a claimed job, so the job vanished when the sheet
// closed. This makes it durable: close the app, reopen it, the job is still
// there with everything needed to deliver it.
//
// READ ONLY, deliberately. No update, no insert, no status write, no
// confirmation. Pickup and delivery confirmations belong to the sender on the
// public tracker (/api/guest/confirm-pickup, /api/guest/confirm-delivery);
// this surface only reflects them.
//
// POST rather than GET because the Supabase session token travels in the
// body, keeping it out of URLs and access logs. It is still strictly a read.
//
// Runs with the service_role admin client because guest_jobs has RLS enabled
// with no public policy, same as every other guest route.
export const runtime = "nodejs"

// Explicit column list. NEVER select() or select("*"): guest_jobs holds
// sender_phone and the remit_* settlement economics (remit_cedis, remit_pi,
// remit_rate, remit_method, remit_paid_at, remit_ref), none of which may
// reach a client. Declared as an array so each column sits on its own line
// and the list stays verifiable at a glance.
//
// 17 columns. sender_phone is not one of them and must never be added here.
const COURIER_JOB_COLUMNS = [
  "tracking_id",
  "pickup_area",
  "pickup_landmark",
  "dropoff_area",
  "dropoff_landmark",
  "package_size",
  "recipient_name",
  "recipient_phone",
  "quote_cedis",
  "payment_type",
  "when_pref",
  "scheduled_date",
  "status",
  "pickup_confirmed_at",
  "pickup_confirmed_by",
  "delivery_confirmed_at",
  "delivery_confirmed_by",
].join(", ")

// The row those 17 columns produce. Declared explicitly because supabase-js
// can only infer a row shape from a string LITERAL passed to .select(); given
// a joined constant it falls back to GenericStringError and the mapper below
// stops typechecking. Keep this in sync with COURIER_JOB_COLUMNS.
type GuestJobRow = {
  tracking_id: string
  pickup_area: string
  pickup_landmark: string | null
  dropoff_area: string
  dropoff_landmark: string | null
  package_size: string
  recipient_name: string | null
  recipient_phone: string | null
  quote_cedis: number | null
  payment_type: string | null
  when_pref: string | null
  scheduled_date: string | null
  status: string
  pickup_confirmed_at: string | null
  pickup_confirmed_by: string | null
  delivery_confirmed_at: string | null
  delivery_confirmed_by: string | null
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => null)
    const accessToken = body?.accessToken
    if (!accessToken) {
      return NextResponse.json({ ok: false, reason: "bad_request" }, { status: 400 })
    }

    const admin = createAdminClient()

    // Identity is derived here, server-side, from the session token alone.
    // The request body carries nothing but the token: no username, no uid.
    const { data: userData, error: userErr } = await admin.auth.getUser(accessToken)
    if (userErr || !userData?.user) {
      return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 })
    }
    const meta = (userData.user.user_metadata ?? {}) as {
      pi_uid?: string
      pi_username?: string
    }
    // Only pi_username is required. /api/guest/accept also needs pi_uid
    // because it writes; this route just matches, so it has no use for it.
    //
    // pi_username is the right match key, not pi_uid: Pi's authenticate()
    // returns different pi_uids for the same Pioneer across sessions on
    // Testnet (see lib/supabase-admin.ts), so a uid match would lose a
    // courier their jobs on the next sign-in — exactly the case this
    // surface exists to survive.
    if (!meta.pi_username) {
      return NextResponse.json({ ok: false, reason: "no_identity" }, { status: 401 })
    }

    // Assignment is the ONLY filter. No status filter, so a job stays
    // findable through its whole life: accepted, in transit, delivered.
    const { data, error } = await admin
      .from("guest_jobs")
      .select(COURIER_JOB_COLUMNS)
      .eq("assigned_courier", meta.pi_username)
      .order("created_at", { ascending: false })
      .limit(20)

    if (error) {
      console.error("[gyema] guest courier jobs error:", error)
      return NextResponse.json({ ok: false }, { status: 500 })
    }

    // Zero rows is a successful read, not a 404: a courier who has accepted
    // nothing yet gets ok:true with an empty list, and the UI renders no
    // section at all.
    const rows = (data ?? []) as unknown as GuestJobRow[]
    return NextResponse.json({
      ok: true,
      jobs: rows.map((j) => ({
        kind: "guest",
        trackingId: j.tracking_id,
        pickupArea: j.pickup_area,
        pickupLandmark: j.pickup_landmark,
        dropoffArea: j.dropoff_area,
        dropoffLandmark: j.dropoff_landmark,
        packageSize: j.package_size,
        recipientName: j.recipient_name,
        recipientPhone: j.recipient_phone,
        quoteCedis: j.quote_cedis,
        paymentType: j.payment_type,
        whenPref: j.when_pref,
        scheduledDate: j.scheduled_date,
        status: j.status,
        pickupConfirmedAt: j.pickup_confirmed_at,
        pickupConfirmedBy: j.pickup_confirmed_by,
        deliveryConfirmedAt: j.delivery_confirmed_at,
        deliveryConfirmedBy: j.delivery_confirmed_by,
      })),
    })
  } catch (err) {
    console.error("[gyema] guest courier jobs route error:", err)
    return NextResponse.json({ ok: false, reason: "server_error" }, { status: 500 })
  }
}
