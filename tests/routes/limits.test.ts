import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"
import { AdminMock, adminModule, get, postJson } from "../helpers/admin-mock"

// What the routes DO with a limiter verdict, as opposed to how the limiter
// reaches one. The arithmetic is tested in tests/rate-limit.test.ts; here
// lib/rate-limit is replaced so a test can hand a route any verdict it likes
// and assert what the caller is told and what work was skipped.
//
// Ground rule 7 of the hardening brief is the spine of this file: every limit
// needs a test proving the NORMAL path still passes. A limit nobody can hit is
// easy to write and useless, and a limit a real sender hits is worse than
// none, so both directions are asserted for every bucket.

const mock = new AdminMock()
vi.mock("@/lib/supabase-admin", () => adminModule(mock))

vi.mock("@vercel/functions", () => ({
  waitUntil: (p: Promise<unknown>) => p,
  ipAddress: (input: Request | { headers: Headers }) =>
    ("headers" in input ? input.headers : input).get("x-real-ip") ?? undefined,
}))

vi.mock("@/lib/pi-platform", () => ({
  verifyPiAccessToken: vi.fn(async (token: string) =>
    token === "good-pi-token" ? { uid: "pi-uid-1", username: "pioneer_one" } : null
  ),
}))

// Every bucket allows by default. A test that wants a refusal names the bucket
// it is refusing, which keeps it obvious WHICH limit a given assertion is about.
//
// Typed from the real exports rather than inferred, so an assertion about the
// arguments a route passed is checked against the real signature. An inferred
// zero-argument mock would make checkLimit.mock.calls an empty tuple and any
// claim about what a route keyed on would be unverifiable.
type CheckLimit = typeof import("@/lib/rate-limit").checkLimit
type IsTurnstileConfigured = typeof import("@/lib/turnstile").isTurnstileConfigured
type VerifyTurnstileToken = typeof import("@/lib/turnstile").verifyTurnstileToken

const checkLimit = vi.fn<CheckLimit>(async () => ({ ok: true as const }))

vi.mock("@/lib/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rate-limit")>()
  return { ...actual, checkLimit }
})

const turnstileConfigured = vi.fn<IsTurnstileConfigured>(() => false)
const verifyTurnstile = vi.fn<VerifyTurnstileToken>(async () => ({ ok: true as const }))

vi.mock("@/lib/turnstile", () => ({
  isTurnstileConfigured: turnstileConfigured,
  verifyTurnstileToken: verifyTurnstile,
}))

const create = await import("@/app/api/guest/create/route")
const track = await import("@/app/api/guest/track/route")
const open = await import("@/app/api/guest/open/route")
const deliveryCode = await import("@/app/api/guest/delivery-code/route")
const confirmPickup = await import("@/app/api/guest/confirm-pickup/route")
const confirmDelivery = await import("@/app/api/guest/confirm-delivery/route")
const authVerify = await import("@/app/api/auth/verify/route")
const piPlatform = await import("@/lib/pi-platform")

const JOB = "GYM-A1B2C3"

/** Refuse exactly one bucket, allow the rest. */
function refuse(bucket: string, reason: "rate_limited" | "limiter_unavailable" = "rate_limited") {
  checkLimit.mockImplementation(async (name) =>
    name === bucket
      ? { ok: false as const, reason, retryAfterSeconds: 90 }
      : { ok: true as const }
  )
}

const GOOD_JOB = {
  pickupArea: "Anywhere",
  dropoffArea: "Anywhere else",
  packageSize: "small",
  senderPhone: "0244123456",
  offList: true,
}

beforeEach(() => {
  mock.calls = []
  mock.results = []
  mock.rpcResults = []
  mock.asAnonymousFailure()
  vi.unstubAllEnvs()
  vi.stubEnv("NEXT_PUBLIC_GUEST_SEND_ENABLED", "true")
  checkLimit.mockReset()
  checkLimit.mockImplementation(async () => ({ ok: true as const }))
  turnstileConfigured.mockReturnValue(false)
  verifyTurnstile.mockReset()
  verifyTurnstile.mockResolvedValue({ ok: true })
})

/** Queue the two collision lookups plus the insert a successful create needs. */
function queueSuccessfulCreate() {
  mock.queue(
    { data: null, error: null },
    { data: null, error: null },
    { data: { tracking_id: JOB, status: "pending_quote" }, error: null }
  )
}

describe("POST /api/guest/create", () => {
  it("still posts a delivery when both windows are open", async () => {
    queueSuccessfulCreate()
    const res = await create.POST(postJson("http://localhost/x", GOOD_JOB) as never)
    expect(res.status).toBe(200)
    expect(checkLimit).toHaveBeenCalledWith("guest_create_ip", expect.any(String))
    expect(checkLimit).toHaveBeenCalledWith("guest_create_phone", expect.any(String))
  })

  it("refuses on the address window before it reads the body", async () => {
    refuse("guest_create_ip")
    const res = await create.POST(postJson("http://localhost/x", GOOD_JOB) as never)
    expect(res.status).toBe(429)
    expect(await res.json()).toMatchObject({ ok: false, reason: "rate_limited" })
    expect(res.headers.get("Retry-After")).toBe("90")
    // Nothing was asked of the database, and the phone bucket was never
    // reached, because the body was never parsed.
    expect(mock.calls).toHaveLength(0)
    expect(checkLimit).not.toHaveBeenCalledWith("guest_create_phone", expect.any(String))
  })

  it("refuses on the sender phone window without writing a row", async () => {
    refuse("guest_create_phone")
    const res = await create.POST(postJson("http://localhost/x", GOOD_JOB) as never)
    expect(res.status).toBe(429)
    expect(mock.calls.find((c) => c.method === "insert")).toBeUndefined()
  })

  it("keys the phone window on something that is not the phone number", async () => {
    queueSuccessfulCreate()
    await create.POST(postJson("http://localhost/x", GOOD_JOB) as never)
    const call = checkLimit.mock.calls.find((c) => c[0] === "guest_create_phone")
    expect(call?.[1]).not.toContain("244123456")
  })

  // The founder's fail-closed instruction for the guest write path, seen from
  // the route rather than from the limiter.
  it("refuses rather than writing when the limiter itself is unavailable", async () => {
    refuse("guest_create_ip", "limiter_unavailable")
    const res = await create.POST(postJson("http://localhost/x", GOOD_JOB) as never)
    expect(res.status).toBe(429)
    expect(await res.json()).toMatchObject({ reason: "limiter_unavailable" })
    expect(mock.calls).toHaveLength(0)
  })

  it("does not call Turnstile at all when it is not configured", async () => {
    queueSuccessfulCreate()
    const res = await create.POST(postJson("http://localhost/x", GOOD_JOB) as never)
    expect(res.status).toBe(200)
    expect(verifyTurnstile).not.toHaveBeenCalled()
  })

  it("requires a token once Turnstile is configured, and writes nothing without one", async () => {
    turnstileConfigured.mockReturnValue(true)
    verifyTurnstile.mockResolvedValue({ ok: false, reason: "missing_token" })
    const res = await create.POST(postJson("http://localhost/x", GOOD_JOB) as never)
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ ok: false, reason: "bot_check_failed" })
    expect(mock.calls).toHaveLength(0)
  })

  it("gives one reason for every Turnstile failure, so an outage is not distinguishable", async () => {
    turnstileConfigured.mockReturnValue(true)
    const reasons: string[] = []
    for (const reason of ["missing_token", "rejected", "unavailable"] as const) {
      mock.calls = []
      verifyTurnstile.mockResolvedValue({ ok: false, reason })
      const res = await create.POST(
        postJson("http://localhost/x", { ...GOOD_JOB, turnstileToken: "t" }) as never
      )
      expect(res.status).toBe(403)
      reasons.push((await res.json()).reason)
    }
    expect(new Set(reasons).size).toBe(1)
  })

  it("posts the delivery when the challenge is solved", async () => {
    turnstileConfigured.mockReturnValue(true)
    queueSuccessfulCreate()
    const res = await create.POST(
      postJson("http://localhost/x", { ...GOOD_JOB, turnstileToken: "a-solved-token" }) as never
    )
    expect(res.status).toBe(200)
    expect(verifyTurnstile).toHaveBeenCalledWith("a-solved-token", expect.any(String))
  })

  it("rejects a token longer than Turnstile ever issues", async () => {
    turnstileConfigured.mockReturnValue(true)
    const res = await create.POST(
      postJson("http://localhost/x", { ...GOOD_JOB, turnstileToken: "x".repeat(2049) }) as never
    )
    expect(res.status).toBe(400)
    expect(verifyTurnstile).not.toHaveBeenCalled()
  })
})

describe("GET /api/guest/track", () => {
  it("still resolves a job when the window is open", async () => {
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
        delivery_code_hash: null,
      },
      error: null,
    })
    const res = await track.GET(new NextRequest(`http://localhost/api/guest/track?trackingId=${JOB}`))
    expect(res.status).toBe(200)
  })

  // The worst false positive this change could have introduced: a waiting
  // sender being told their delivery does not exist because a window was full.
  it("answers 429 and NEVER 404 when the window is full", async () => {
    refuse("guest_track")
    const res = await track.GET(new NextRequest(`http://localhost/api/guest/track?trackingId=${JOB}`))
    expect(res.status).toBe(429)
    expect(res.status).not.toBe(404)
    expect(await res.json()).toMatchObject({ reason: "rate_limited" })
    expect(res.headers.get("Retry-After")).toBe("90")
    expect(mock.calls).toHaveLength(0)
  })
})

describe("GET /api/guest/open", () => {
  it("still lists the board when the window is open", async () => {
    mock.queue({ data: [], error: null })
    const res = await open.GET(get("http://localhost/api/guest/open") as never)
    expect(res.status).toBe(200)
  })

  it("refuses with a retry hint when the window is full", async () => {
    refuse("guest_open")
    const res = await open.GET(get("http://localhost/api/guest/open") as never)
    expect(res.status).toBe(429)
    expect(res.headers.get("Retry-After")).toBe("90")
  })
})

describe("the three last-4 routes share one bucket", () => {
  const cases = [
    ["delivery-code", () => deliveryCode.POST(postJson("http://x/y", { trackingId: JOB, last4: "3456" }) as never)],
    ["confirm-pickup", () => confirmPickup.POST(postJson("http://x/y", { trackingId: JOB, last4: "3456" }) as never)],
    [
      "confirm-delivery",
      () =>
        confirmDelivery.POST(
          postJson("http://x/y", { trackingId: JOB, via: "sender", last4: "3456" }) as never
        ),
    ],
  ] as const

  for (const [name, call] of cases) {
    it(`${name} refuses on the shared bucket without touching the job`, async () => {
      refuse("guest_last4")
      const res = await call()
      expect(res.status).toBe(429)
      expect(await res.json()).toMatchObject({ ok: false, reason: "rate_limited" })
      expect(checkLimit).toHaveBeenCalledWith("guest_last4", expect.any(String))
      // The point of refusing before the lookup: a rate-limited attempt must
      // not spend one of the ten the job allows.
      expect(mock.calls).toHaveLength(0)
      expect(mock.rpcResults).toHaveLength(0)
    })

    it(`${name} still runs when the window is open`, async () => {
      mock.queue({ data: null, error: null })
      const res = await call()
      // 404, because no job was queued. What matters is that it reached the
      // lookup at all rather than being refused by the limiter.
      expect(res.status).toBe(404)
      expect(mock.calls.length).toBeGreaterThan(0)
    })
  }
})

describe("POST /api/auth/verify", () => {
  it("still signs a Pioneer in when the window is open", async () => {
    mock.asPioneer()
    const res = await authVerify.POST(
      postJson("http://localhost/api/auth/verify", { accessToken: "good-pi-token" }) as never
    )
    expect(res.status).toBe(200)
  })

  it("refuses before spending a Pi Platform round trip", async () => {
    refuse("auth_verify")
    const verify = vi.mocked(piPlatform.verifyPiAccessToken)
    verify.mockClear()

    const res = await authVerify.POST(
      postJson("http://localhost/api/auth/verify", { accessToken: "good-pi-token" }) as never
    )
    expect(res.status).toBe(429)
    expect(await res.json()).toMatchObject({ ok: false, reason: "RATE_LIMITED" })
    expect(res.headers.get("Retry-After")).toBe("90")
    // The whole reason the check is first: the expensive call never happened.
    expect(verify).not.toHaveBeenCalled()
  })
})
