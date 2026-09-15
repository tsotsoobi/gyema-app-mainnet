import { describe, it, expect, vi, beforeEach } from "vitest"
import { readFileSync } from "node:fs"
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

  // Off-list option (a): accept refuses a job with no quote, so the board
  // never shows one.
  it("leaves a posted job with no quote off the board", async () => {
    mock.queue({ data: [], error: null })
    await open.GET(get("http://localhost/api/guest/open") as never)
    expect(mock.trace()).toContain('gt("quote_cedis", 0)')
  })

  it("previews the courier's split from the server function, never a remit column", async () => {
    mock.queue({
      data: [
        { tracking_id: JOB, quote_cedis: 50 },
        { tracking_id: "GYM-D4E5F6", quote_cedis: 25 },
      ],
      error: null,
    })
    const res = await open.GET(get("http://localhost/api/guest/open") as never)
    const { jobs } = await res.json()
    expect(jobs[0]).toMatchObject({ quoteCedis: 50, commissionCedis: 4, keepsCedis: 46, commissionRateLabel: "7.5%" })
    expect(jobs[1]).toMatchObject({ quoteCedis: 25, commissionCedis: 2, keepsCedis: 23, commissionRateLabel: "7.5%" })
    expect(mock.selectedColumns()).not.toContain("remit_")
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
    mock.queue({ data: { quote_cedis: 40 }, error: null })
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
    mock.queue({ data: { quote_cedis: 40 }, error: null })
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
    mock.queue({ data: { quote_cedis: 40 }, error: null })
    mock.queue({ data: { tracking_id: JOB }, error: null })
    await accept.POST(
      postJson("http://localhost/x", { accessToken: "good", trackingId: JOB }) as never
    )
    const update = mock.calls.find((c) => c.method === "update")
    const row = update?.args[0] as Record<string, unknown>
    expect(typeof row.delivery_code_hash).toBe("string")
    expect((row.delivery_code_hash as string).length).toBe(64)
  })

  // The commission is computed on the server from the quote on the row, and
  // written in the same UPDATE that assigns the courier.
  it("writes remit_cedis from the quote it read, in the claim itself, guarded on that quote", async () => {
    mock.asPioneer("pi-uid-1", "courier_one")
    mock.queue(
      { data: { quote_cedis: 70 }, error: null },
      { data: { tracking_id: JOB, quote_cedis: 70, remit_cedis: 5.5, payment_type: "momo" }, error: null }
    )
    const res = await accept.POST(
      postJson("http://localhost/x", { accessToken: "good", trackingId: JOB }) as never
    )
    const updates = mock.calls.filter((c) => c.method === "update")
    expect(updates).toHaveLength(1)
    const row = updates[0].args[0] as Record<string, unknown>
    expect(row.remit_cedis).toBe(5.5)
    expect(row.assigned_courier).toBe("courier_one")
    // The guard on the quote comes after the update, on the same statement.
    const trace = mock.trace()
    const updateAt = trace.findIndex((t) => t.startsWith("update("))
    expect(trace.indexOf('eq("quote_cedis", 70)')).toBeGreaterThan(updateAt)
    // The figures returned are the ones written, not a recomputation.
    const { job } = await res.json()
    expect(job).toMatchObject({ quote_cedis: 70, remit_cedis: 5.5, keeps_cedis: 64.5, commission_rate_label: "7.5%" })
  })

  it("takes no commission figure from the request body", async () => {
    mock.asPioneer("pi-uid-1", "courier_one")
    mock.queue({ data: { quote_cedis: 40 }, error: null }, { data: { tracking_id: JOB }, error: null })
    await accept.POST(
      postJson("http://localhost/x", {
        accessToken: "good",
        trackingId: JOB,
        remitCedis: 0,
        remit_cedis: 0,
        quoteCedis: 1000,
      }) as never
    )
    // GuestAcceptBody is not strict, so the extra fields are stripped and the
    // claim runs. The write carries the server's figure for the quote it read.
    const row = mock.calls.find((c) => c.method === "update")?.args[0] as Record<string, unknown>
    expect(row.remit_cedis).toBe(3)
    expect(mock.trace().join(" ")).not.toContain("1000")
  })

  it("refuses a job with no quote and writes nothing", async () => {
    mock.asPioneer("pi-uid-1", "courier_one")
    mock.queue({ data: { quote_cedis: null }, error: null })
    const res = await accept.POST(
      postJson("http://localhost/x", { accessToken: "good", trackingId: JOB }) as never
    )
    expect(await res.json()).toMatchObject({ ok: false, reason: "not_open" })
    expect(mock.calls.some((c) => c.method === "update")).toBe(false)
  })

  it("refuses a job that is not claimable and writes nothing", async () => {
    mock.asPioneer("pi-uid-1", "courier_one")
    mock.queue({ data: null, error: null })
    const res = await accept.POST(
      postJson("http://localhost/x", { accessToken: "good", trackingId: JOB }) as never
    )
    expect(await res.json()).toMatchObject({ ok: false, reason: "not_open" })
    expect(mock.calls.some((c) => c.method === "update")).toBe(false)
  })

  it("refuses when the quote changed between the read and the claim", async () => {
    mock.asPioneer("pi-uid-1", "courier_one")
    // The read sees 40. The guarded update then matches nothing, which is what
    // PostgREST reports as an error on .single().
    mock.queue(
      { data: { quote_cedis: 40 }, error: null },
      { data: null, error: { code: "PGRST116", message: "no rows" } }
    )
    const res = await accept.POST(
      postJson("http://localhost/x", { accessToken: "good", trackingId: JOB }) as never
    )
    expect(await res.json()).toMatchObject({ ok: false, reason: "not_open" })
    expect(mock.trace()).toContain('eq("quote_cedis", 40)')
  })

  it("returns remit_cedis but no other remit column", async () => {
    mock.asPioneer("pi-uid-1", "courier_one")
    mock.queue({ data: { quote_cedis: 40 }, error: null }, { data: { tracking_id: JOB }, error: null })
    await accept.POST(
      postJson("http://localhost/x", { accessToken: "good", trackingId: JOB }) as never
    )
    const selected = mock.selectedColumns()
    expect(selected).toContain("remit_cedis")
    for (const hidden of ["remit_pi", "remit_rate", "remit_method", "remit_paid_at", "remit_ref"]) {
      expect(selected).not.toContain(hidden)
    }
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

  it("returns the commission as recorded, never recomputed at the current rate", async () => {
    mock.asPioneer("pi-uid-1", "courier_one")
    mock.queue({
      data: [
        { tracking_id: JOB, status: "accepted", quote_cedis: 40, remit_cedis: 3, delivery_code_hash: null },
        // A 5% remit recorded before this rate. It stays 2.00, with no rate label.
        { tracking_id: "GYM-D4E5F6", status: "delivered", quote_cedis: 40, remit_cedis: 2, delivery_code_hash: null },
        // Nothing recorded: no split is shown at all.
        { tracking_id: "GYM-G7H8J9", status: "delivered", quote_cedis: 40, remit_cedis: null, delivery_code_hash: null },
      ],
      error: null,
    })
    const res = await mine.POST(postJson("http://localhost/x", { accessToken: "good" }) as never)
    const { jobs } = await res.json()
    expect(jobs[0]).toMatchObject({ remitCedis: 3, keepsCedis: 37, commissionRateLabel: "7.5%" })
    expect(jobs[1]).toMatchObject({ remitCedis: 2, keepsCedis: 38, commissionRateLabel: null })
    expect(jobs[2]).toMatchObject({ remitCedis: null, keepsCedis: null, commissionRateLabel: null })
    const selected = mock.selectedColumns()
    for (const hidden of ["remit_pi", "remit_rate", "remit_method", "remit_paid_at", "remit_ref"]) {
      expect(selected).not.toContain(hidden)
    }
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

// Finding S-17, the guest half. The Pioneer rail moved to randomBytes when
// creation became a server route; this rail always minted server side and was
// simply missed. A GYM- ID is the entry ticket to every public guest route, so
// a predictable one is the front half of an attack on the sender-side guards.
describe("the tracking id the guest rail mints", () => {
  it("keeps the GYM- plus six hex shape, so nothing downstream moves", async () => {
    mock.queue(
      { data: null, error: null },
      { data: null, error: null },
      { data: { tracking_id: JOB, status: "pending_quote" }, error: null }
    )
    await create.POST(
      postJson("http://localhost/x", {
        pickupArea: "Anywhere",
        dropoffArea: "Anywhere else",
        packageSize: "small",
        senderPhone: "0244123456",
        offList: true,
      }) as never
    )
    const insert = mock.calls.find((c) => c.method === "insert")
    const minted = String((insert?.args[0] as Record<string, unknown>).tracking_id)
    // The same shape lib/schemas.ts accepts and every stored ID already has.
    expect(minted).toMatch(/^GYM-[0-9A-F]{6}$/)
  })

  it("does not repeat itself across many mints", async () => {
    // Not a randomness test, which a unit test cannot do. This catches the
    // failure that would actually matter: a mint that is constant, or seeded
    // per call from something like a truncated timestamp.
    const seen = new Set<string>()
    for (let i = 0; i < 40; i++) {
      mock.calls = []
      mock.results = []
      mock.queue(
        { data: null, error: null },
        { data: null, error: null },
        { data: { tracking_id: JOB, status: "pending_quote" }, error: null }
      )
      await create.POST(
        postJson("http://localhost/x", {
          pickupArea: "Anywhere",
          dropoffArea: "Anywhere else",
          packageSize: "small",
          senderPhone: "0244123456",
          offList: true,
        }) as never
      )
      const insert = mock.calls.find((c) => c.method === "insert")
      seen.add(String((insert?.args[0] as Record<string, unknown>).tracking_id))
    }
    expect(seen.size).toBe(40)
  })

  it("mints from the CSPRNG, not from Math.random", () => {
    // Asserted against the source because the property is about WHERE the
    // bytes come from, and no black-box test on 40 samples can tell a CSPRNG
    // from Math.random. The same reasoning tests/csp.test.ts uses when it
    // asserts a comment is present.
    const source = readFileSync("app/api/guest/create/route.ts", "utf8")
    const code = source
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
      .join("\n")
    expect(code).toContain("randomBytes")
    expect(code).not.toContain("Math.random")
  })
})
