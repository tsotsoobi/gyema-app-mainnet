import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"
import { AdminMock, adminModule, get, postJson } from "../helpers/admin-mock"

const mock = new AdminMock()
vi.mock("@/lib/supabase-admin", () => adminModule(mock))

const create = await import("@/app/api/guest/create/route")
const track = await import("@/app/api/guest/track/route")
const open = await import("@/app/api/guest/open/route")
const accept = await import("@/app/api/guest/accept/route")
const mine = await import("@/app/api/guest/mine/route")
const deliveryCode = await import("@/app/api/guest/delivery-code/route")
const confirmPickup = await import("@/app/api/guest/confirm-pickup/route")
const confirmDelivery = await import("@/app/api/guest/confirm-delivery/route")

const JOB = "GYM-A1B2C3"

beforeEach(() => {
  mock.calls = []
  mock.results = []
  mock.rpcResults = []
  mock.asAnonymousFailure()
  vi.unstubAllEnvs()
  vi.stubEnv("NEXT_PUBLIC_GUEST_SEND_ENABLED", "true")
})

describe("POST /api/guest/create", () => {
  it("is closed when the flag is not exactly true", async () => {
    vi.stubEnv("NEXT_PUBLIC_GUEST_SEND_ENABLED", "")
    const res = await create.POST(postJson("http://localhost/x", {}) as never)
    expect(res.status).toBe(403)
  })

  it("rejects a missing required field", async () => {
    const res = await create.POST(
      postJson("http://localhost/x", { pickupArea: "Osu", packageSize: "small" }) as never
    )
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ reason: "bad_request" })
  })

  it("rejects an area outside the bounded list", async () => {
    const res = await create.POST(
      postJson("http://localhost/x", {
        pickupArea: "Atlantis",
        dropoffArea: "Osu",
        packageSize: "small",
        senderPhone: "0244123456",
      }) as never
    )
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ reason: "unbounded_city" })
  })

  it("rejects a package size outside the enum", async () => {
    const res = await create.POST(
      postJson("http://localhost/x", {
        pickupArea: "Anywhere",
        dropoffArea: "Anywhere else",
        packageSize: "enormous",
        senderPhone: "0244123456",
        offList: true,
      }) as never
    )
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ reason: "bad_size" })
  })

  it("writes an unverified draft and returns only the tracking id and status", async () => {
    mock.queue(
      { data: null, error: null },
      { data: null, error: null },
      { data: { tracking_id: JOB, status: "pending_quote" }, error: null }
    )
    const res = await create.POST(
      postJson("http://localhost/x", {
        pickupArea: "Anywhere",
        dropoffArea: "Anywhere else",
        packageSize: "small",
        senderPhone: "0244123456",
        contentsNote: "  a note  ",
        offList: true,
      }) as never
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Object.keys(body).sort()).toEqual(["ok", "status", "trackingId"])

    const insert = mock.calls.find((c) => c.method === "insert")
    const row = insert?.args[0] as Record<string, unknown>
    // phone_verified is false on every insert. Nothing in this codebase flips
    // it: the operator does that by hand in the Supabase dashboard.
    expect(row.phone_verified).toBe(false)
    // Free text is trimmed before it is stored, which is the fix for the
    // untrimmed area values found live on 21 August.
    expect(row.contents_note).toBe("a note")
    // Status is server derived, never taken from the body.
    expect(row.status).toBe("pending_quote")
  })
})

describe("GET /api/guest/track", () => {
  it("rejects a malformed tracking id", async () => {
    const req = new NextRequest("http://localhost/api/guest/track?trackingId=nope")
    const res = await track.GET(req)
    expect(res.status).toBe(400)
  })

  it("does not resolve an unverified draft", async () => {
    mock.queue({ data: null, error: null })
    const req = new NextRequest(`http://localhost/api/guest/track?trackingId=${JOB}`)
    const res = await track.GET(req)
    expect(res.status).toBe(404)
    expect(mock.trace()).toContain('eq("phone_verified", true)')
  })

  it("returns a sanitized payload and never a phone, name, landmark or code", async () => {
    mock.queue({
      data: {
        tracking_id: JOB,
        pickup_area: "Osu",
        dropoff_area: "Madina",
        status: "in_transit",
        created_at: "2026-09-01T00:00:00Z",
        assigned_courier: "courier_one",
        pickup_confirmed_at: null,
        delivery_confirmed_at: null,
        delivery_confirmed_by: null,
        delivery_code_hash: "abc123",
      },
      error: null,
    })
    const req = new NextRequest(`http://localhost/api/guest/track?trackingId=${JOB}`)
    const res = await track.GET(req)
    const text = await res.text()
    expect(res.status).toBe(200)
    expect(text).not.toContain("abc123")
    expect(JSON.parse(text).job.hasDeliveryCode).toBe(true)
    const selected = mock.selectedColumns()
    for (const forbidden of [
      "sender_phone",
      "recipient_phone",
      "recipient_name",
      "landmark",
      "quote_cedis",
    ]) {
      expect(selected).not.toContain(forbidden)
    }
  })
})

describe("GET /api/guest/open", () => {
  it("lists only verified, posted, unassigned jobs and no contact data", async () => {
    mock.queue({
      data: [{ tracking_id: JOB, pickup_area: "Osu", dropoff_area: "Madina" }],
      error: null,
    })
    const res = await open.GET(get("http://localhost/api/guest/open") as never)
    expect(res.status).toBe(200)
    const trace = mock.trace()
    expect(trace).toContain('eq("phone_verified", true)')
    expect(trace).toContain('eq("status", "posted")')
    expect(trace).toContain('is("assigned_courier", null)')
    const selected = mock.selectedColumns()
    expect(selected).not.toContain("sender_phone")
    expect(selected).not.toContain("delivery_code_hash")
  })
})

describe("POST /api/guest/accept", () => {
  it("rejects an unresolvable session token", async () => {
    const res = await accept.POST(
      postJson("http://localhost/x", { accessToken: "bad", trackingId: JOB }) as never
    )
    expect(res.status).toBe(401)
  })

  it("claims only a verified, posted, unassigned job and never selects sender_phone", async () => {
    mock.asPioneer("pi-uid-1", "courier_one")
    mock.queue({ data: { tracking_id: JOB, recipient_name: "Ama" }, error: null })
    const res = await accept.POST(
      postJson("http://localhost/x", { accessToken: "good", trackingId: JOB }) as never
    )
    expect(res.status).toBe(200)
    const trace = mock.trace()
    expect(trace).toContain('eq("status", "posted")')
    expect(trace).toContain('eq("phone_verified", true)')
    expect(trace).toContain('is("assigned_courier", null)')
    expect(mock.selectedColumns()).not.toContain("sender_phone")
    expect(mock.selectedColumns()).not.toContain("delivery_code_hash")
  })

  // S-4, now closed. The plaintext code used to be in this response, on the
  // reasoning that the client mapper dropped it. That is a UI decision, not a
  // control: it was one glance at a network tab away, hours before the courier
  // reached any door.
  it("never returns the delivery code to the accepter", async () => {
    mock.asPioneer("pi-uid-1", "courier_one")
    mock.queue({ data: { tracking_id: JOB }, error: null })
    const res = await accept.POST(
      postJson("http://localhost/x", { accessToken: "good", trackingId: JOB }) as never
    )
    const text = await res.text()
    const body = JSON.parse(text)
    expect(body.ok).toBe(true)
    expect(body.deliveryCode).toBeUndefined()
    // Not under another name either: no bare four digit string anywhere in it.
    expect(text).not.toMatch(/[0-9]{4}/)
  })

  it("still stores the hash, so the sender can be shown the code later", async () => {
    mock.asPioneer("pi-uid-1", "courier_one")
    mock.queue({ data: { tracking_id: JOB }, error: null })
    await accept.POST(
      postJson("http://localhost/x", { accessToken: "good", trackingId: JOB }) as never
    )
    const update = mock.calls.find((c) => c.method === "update")
    const row = update?.args[0] as Record<string, unknown>
    expect(typeof row.delivery_code_hash).toBe("string")
    expect((row.delivery_code_hash as string).length).toBe(64)
  })
})

describe("POST /api/guest/mine", () => {
  it("rejects a request with no token", async () => {
    const res = await mine.POST(postJson("http://localhost/x", {}) as never)
    expect(res.status).toBe(400)
  })

  it("matches on the session username and emits code nullity, never the hash", async () => {
    mock.asPioneer("pi-uid-1", "courier_one")
    mock.queue({
      data: [{ tracking_id: JOB, status: "accepted", delivery_code_hash: "abc123" }],
      error: null,
    })
    const res = await mine.POST(
      postJson("http://localhost/x", {
        accessToken: "good",
        pi_username: "someone_else",
      }) as never
    )
    const text = await res.text()
    expect(res.status).toBe(200)
    expect(text).not.toContain("abc123")
    expect(JSON.parse(text).jobs[0].hasDeliveryCode).toBe(true)
    // Identity comes from the token, not from the body.
    expect(mock.trace()).toContain('eq("assigned_courier", "courier_one")')
    expect(mock.trace().join(" ")).not.toContain("someone_else")
  })
})

describe("POST /api/guest/delivery-code", () => {
  it("rejects a malformed last4", async () => {
    const res = await deliveryCode.POST(
      postJson("http://localhost/x", { trackingId: JOB, last4: "12" }) as never
    )
    expect(res.status).toBe(400)
  })

  it("refuses a wrong last4", async () => {
    mock.queue({
      data: { tracking_id: JOB, sender_phone: "0244123456", delivery_code_hash: "x" },
      error: null,
    })
    const res = await deliveryCode.POST(
      postJson("http://localhost/x", { trackingId: JOB, last4: "0000" }) as never
    )
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ reason: "guard_failed" })
  })

  // The attempt ceiling on this guard has its own file:
  // tests/routes/last4-guard.test.ts (S-2).
})

describe("POST /api/guest/confirm-pickup", () => {
  it("rejects a malformed tracking id", async () => {
    const res = await confirmPickup.POST(
      postJson("http://localhost/x", { trackingId: "bad", last4: "3456" }) as never
    )
    expect(res.status).toBe(400)
  })

  it("refuses a wrong last4 and never reveals the phone", async () => {
    mock.queue({
      data: {
        tracking_id: JOB,
        status: "accepted",
        sender_phone: "0244123456",
        pickup_confirmed_at: null,
      },
      error: null,
    })
    const res = await confirmPickup.POST(
      postJson("http://localhost/x", { trackingId: JOB, last4: "9999" }) as never
    )
    expect(res.status).toBe(403)
    expect(await res.text()).not.toContain("0244123456")
  })

  it("is idempotent once confirmed", async () => {
    mock.queue({
      data: {
        tracking_id: JOB,
        status: "accepted",
        sender_phone: "0244123456",
        pickup_confirmed_at: "2026-09-01T10:00:00Z",
      },
      error: null,
    })
    const res = await confirmPickup.POST(
      postJson("http://localhost/x", { trackingId: JOB, last4: "3456" }) as never
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, already: true })
  })
})

describe("POST /api/guest/confirm-delivery", () => {
  it("refuses a request with no via discriminator", async () => {
    const res = await confirmDelivery.POST(
      postJson("http://localhost/x", { trackingId: JOB, last4: "3456" }) as never
    )
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ reason: "invalid_via" })
  })

  it("requires a session on the courier code path", async () => {
    mock.queue({
      data: {
        tracking_id: JOB,
        status: "in_transit",
        sender_phone: "0244123456",
        assigned_courier: "courier_one",
        delivery_confirmed_by: null,
        delivery_code_hash: "hash",
        delivery_code_attempts: 0,
      },
      error: null,
    })
    const res = await confirmDelivery.POST(
      postJson("http://localhost/x", {
        trackingId: JOB,
        via: "courier_code",
        code: "1234",
      }) as never
    )
    expect(res.status).toBe(401)
  })

  it("refuses a courier who is not the assigned one", async () => {
    mock.asPioneer("pi-uid-2", "courier_two")
    mock.queue({
      data: {
        tracking_id: JOB,
        status: "in_transit",
        sender_phone: "0244123456",
        assigned_courier: "courier_one",
        delivery_confirmed_by: null,
        delivery_code_hash: "hash",
        delivery_code_attempts: 0,
      },
      error: null,
    })
    const res = await confirmDelivery.POST(
      postJson("http://localhost/x", {
        trackingId: JOB,
        via: "courier_code",
        code: "1234",
        accessToken: "good",
      }) as never
    )
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ reason: "not_assigned" })
  })

  it("locks the code path once the attempt budget is spent", async () => {
    mock.asPioneer("pi-uid-1", "courier_one")
    mock.queue({
      data: {
        tracking_id: JOB,
        status: "in_transit",
        sender_phone: "0244123456",
        assigned_courier: "courier_one",
        delivery_confirmed_by: null,
        delivery_code_hash: "hash",
        delivery_code_attempts: 5,
      },
      error: null,
    })
    const res = await confirmDelivery.POST(
      postJson("http://localhost/x", {
        trackingId: JOB,
        via: "courier_code",
        code: "1234",
        accessToken: "good",
      }) as never
    )
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ reason: "code_locked", attemptsLeft: 0 })
  })

  it("bumps the counter through the RPC on a wrong code", async () => {
    mock.asPioneer("pi-uid-1", "courier_one")
    mock.queue({
      data: {
        tracking_id: JOB,
        status: "in_transit",
        sender_phone: "0244123456",
        assigned_courier: "courier_one",
        delivery_confirmed_by: null,
        delivery_code_hash: "not-the-hash-of-1234",
        delivery_code_attempts: 1,
      },
      error: null,
    })
    mock.queueRpc({ data: 2, error: null })
    const res = await confirmDelivery.POST(
      postJson("http://localhost/x", {
        trackingId: JOB,
        via: "courier_code",
        code: "1234",
        accessToken: "good",
      }) as never
    )
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ reason: "wrong_code", attemptsLeft: 3 })
    expect(mock.calls.find((c) => c.method === "rpc")?.args[0]).toBe(
      "guest_bump_delivery_code_attempts"
    )
  })
})
