import { describe, it, expect, vi, beforeEach } from "vitest"
import { AdminMock, adminModule, postJson } from "../helpers/admin-mock"
import { MAX_LAST4_ATTEMPTS } from "@/lib/last4-guard"

// S-2, now closed. Three public routes are guarded by a tracking ID and the
// last four digits of the sender's phone, which is ten thousand values, and
// none of them counted a wrong answer. A few minutes of scripted requests won
// the delivery code, a pickup confirmation and a delivery sign off.
//
// The ceiling is per job and does not reset on success, so these tests drive
// the counter the way the database would: the route reads last4_attempts off
// the row, and the RPC returns the incremented value.

const mock = new AdminMock()
vi.mock("@/lib/supabase-admin", () => adminModule(mock))

const deliveryCode = await import("@/app/api/guest/delivery-code/route")
const confirmPickup = await import("@/app/api/guest/confirm-pickup/route")
const confirmDelivery = await import("@/app/api/guest/confirm-delivery/route")

const JOB = "GYM-A1B2C3"
const PHONE = "0244123456" // last four: 3456

beforeEach(() => {
  mock.calls = []
  mock.results = []
  mock.rpcResults = []
  mock.asAnonymousFailure()
})

/** The row each route reads first, with a given attempt count. */
function jobRow(attempts: number, extra: Record<string, unknown> = {}) {
  return {
    data: {
      tracking_id: JOB,
      status: "accepted",
      sender_phone: PHONE,
      pickup_confirmed_at: null,
      delivery_code_hash: "hash",
      last4_attempts: attempts,
      ...extra,
    },
    error: null,
  }
}

describe("the last-4 guard counts wrong answers", () => {
  it("a wrong answer is counted, and the caller is told what is left", async () => {
    mock.queue(jobRow(0))
    mock.queueRpc({ data: 1, error: null })
    const res = await deliveryCode.POST(
      postJson("http://localhost/x", { trackingId: JOB, last4: "0000" }) as never
    )
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({
      reason: "guard_failed",
      attemptsLeft: MAX_LAST4_ATTEMPTS - 1,
    })
    // Counted through the RPC, not a read-modify-write.
    expect(mock.calls.find((c) => c.method === "rpc")?.args[0]).toBe(
      "guest_bump_last4_attempts"
    )
  })

  it("the last attempt reports the guard as locked, not merely wrong", async () => {
    mock.queue(jobRow(MAX_LAST4_ATTEMPTS - 1))
    mock.queueRpc({ data: MAX_LAST4_ATTEMPTS, error: null })
    const res = await deliveryCode.POST(
      postJson("http://localhost/x", { trackingId: JOB, last4: "0000" }) as never
    )
    expect(await res.json()).toMatchObject({ reason: "guard_locked", attemptsLeft: 0 })
  })

  it("an exhausted job refuses before comparing, so it cannot be ground down", async () => {
    mock.queue(jobRow(MAX_LAST4_ATTEMPTS))
    const res = await deliveryCode.POST(
      postJson("http://localhost/x", { trackingId: JOB, last4: "0000" }) as never
    )
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ reason: "guard_locked" })
    // No bump: the budget was already spent, and an exhausted job must not
    // keep costing writes for every further guess.
    expect(mock.calls.some((c) => c.method === "rpc")).toBe(false)
  })

  it("refuses the RIGHT answer once locked, which is the point of a ceiling", async () => {
    mock.queue(jobRow(MAX_LAST4_ATTEMPTS))
    const res = await deliveryCode.POST(
      postJson("http://localhost/x", { trackingId: JOB, last4: "3456" }) as never
    )
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ reason: "guard_locked" })
  })

  it("refuses rather than allowing an uncounted guess if the counter fails", async () => {
    // Failing open here would restore the unlimited guessing the ceiling
    // exists to stop.
    mock.queue(jobRow(0))
    mock.queueRpc({ data: null, error: { message: "rpc unavailable" } })
    const res = await deliveryCode.POST(
      postJson("http://localhost/x", { trackingId: JOB, last4: "0000" }) as never
    )
    expect(res.status).toBe(403)
  })

  it("a correct answer within budget still works and reveals the code", async () => {
    // codeFromHash exhausts the 4 digit space against the stored hash, so give
    // it the real hash of 0000 to recover.
    const { hashDeliveryCode } = await import("@/lib/delivery-code")
    mock.queue({
      data: {
        tracking_id: JOB,
        sender_phone: PHONE,
        delivery_code_hash: hashDeliveryCode("0000"),
        last4_attempts: 3,
      },
      error: null,
    })
    const res = await deliveryCode.POST(
      postJson("http://localhost/x", { trackingId: JOB, last4: "3456" }) as never
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, code: "0000" })
    // A success is not counted.
    expect(mock.calls.some((c) => c.method === "rpc")).toBe(false)
  })
})

describe("the ceiling applies to all three sender side routes", () => {
  it("confirm-pickup counts and locks", async () => {
    mock.queue(jobRow(MAX_LAST4_ATTEMPTS))
    const locked = await confirmPickup.POST(
      postJson("http://localhost/x", { trackingId: JOB, last4: "3456" }) as never
    )
    expect(await locked.json()).toMatchObject({ reason: "guard_locked" })

    mock.calls = []
    mock.results = []
    mock.rpcResults = []
    mock.queue(jobRow(2))
    mock.queueRpc({ data: 3, error: null })
    const wrong = await confirmPickup.POST(
      postJson("http://localhost/x", { trackingId: JOB, last4: "9999" }) as never
    )
    expect(await wrong.json()).toMatchObject({
      reason: "guard_failed",
      attemptsLeft: MAX_LAST4_ATTEMPTS - 3,
    })
  })

  it("confirm-delivery on the sender path counts and locks", async () => {
    mock.queue(jobRow(MAX_LAST4_ATTEMPTS, { status: "in_transit", delivery_confirmed_by: null }))
    const locked = await confirmDelivery.POST(
      postJson("http://localhost/x", { trackingId: JOB, via: "sender", last4: "3456" }) as never
    )
    expect(await locked.json()).toMatchObject({ reason: "guard_locked" })
  })

  it("the courier code budget and the sender budget are separate counters", async () => {
    // A sender who has burnt every last-4 attempt must not have spent the
    // courier's five, and the other way round.
    mock.asPioneer("pi-courier", "courier_one")
    mock.queue(
      jobRow(MAX_LAST4_ATTEMPTS, {
        status: "in_transit",
        assigned_courier: "courier_one",
        delivery_confirmed_by: null,
        delivery_code_attempts: 0,
      })
    )
    mock.queueRpc({ data: 1, error: null })
    const res = await confirmDelivery.POST(
      postJson("http://localhost/x", {
        trackingId: JOB,
        via: "courier_code",
        code: "1234",
        accessToken: "good",
      }) as never
    )
    const body = await res.json()
    // Refused because the code is wrong, not because the sender's guard is
    // locked, and it bumped the courier's counter.
    expect(body.reason).toBe("wrong_code")
    expect(mock.calls.find((c) => c.method === "rpc")?.args[0]).toBe(
      "guest_bump_delivery_code_attempts"
    )
  })
})
