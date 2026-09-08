import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { AdminMock, adminModule, postJson, get } from "../helpers/admin-mock"

const mock = new AdminMock()
vi.mock("@/lib/supabase-admin", () => adminModule(mock))

const approve = await import("@/app/api/payments/approve/route")
const complete = await import("@/app/api/payments/complete/route")
const cron = await import("@/app/api/cron/expire-stale-listings/route")

beforeEach(() => {
  mock.calls = []
  mock.results = []
  vi.unstubAllEnvs()
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe("POST /api/payments/approve", () => {
  it("rejects a missing paymentId before any Pi call", async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal("fetch", fetchSpy)
    const res = await approve.POST(postJson("http://localhost/x", {}) as never)
    expect(res.status).toBe(400)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("refuses to call Pi when PI_API_KEY is unset", async () => {
    vi.stubEnv("PI_API_KEY", "")
    const fetchSpy = vi.fn()
    vi.stubGlobal("fetch", fetchSpy)
    const res = await approve.POST(postJson("http://localhost/x", { paymentId: "p1" }) as never)
    expect(res.status).toBe(500)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  // Documents current behaviour, and is the regression net for the fix.
  // S-3 in docs/security-inventory.md: this route takes no session, so any
  // caller can spend PI_API_KEY. Ground rule 4 puts the fix behind an explicit
  // decision, so the test records the gap rather than asserting it is closed.
  it("KNOWN GAP S-3: accepts a caller with no session at all", async () => {
    vi.stubEnv("PI_API_KEY", "test-key-not-a-real-key")
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ identifier: "p1" }), { status: 200 }))
    )
    const res = await approve.POST(postJson("http://localhost/x", { paymentId: "p1" }) as never)
    expect(res.status).toBe(200)
  })
})

describe("POST /api/payments/complete", () => {
  it("rejects a missing txid", async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal("fetch", fetchSpy)
    const res = await complete.POST(postJson("http://localhost/x", { paymentId: "p1" }) as never)
    expect(res.status).toBe(400)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  // S-11: Pi's raw response body is echoed to the caller on failure.
  it("KNOWN GAP S-11: echoes the upstream Pi error body", async () => {
    vi.stubEnv("PI_API_KEY", "test-key-not-a-real-key")
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("pi internal detail", { status: 502 }))
    )
    const res = await complete.POST(
      postJson("http://localhost/x", { paymentId: "p1", txid: "tx1" }) as never
    )
    expect(res.status).toBe(502)
    expect(await res.json()).toMatchObject({ details: "pi internal detail" })
  })
})

describe("GET /api/cron/expire-stale-listings", () => {
  it("rejects a caller with no bearer token when running on Vercel", async () => {
    vi.stubEnv("VERCEL", "1")
    vi.stubEnv("CRON_SECRET", "cron-secret-for-tests")
    const res = await cron.GET(get("http://localhost/api/cron/expire-stale-listings"))
    expect(res.status).toBe(401)
  })

  it("fails closed when CRON_SECRET is unset on Vercel", async () => {
    vi.stubEnv("VERCEL", "1")
    vi.stubEnv("CRON_SECRET", "")
    const req = new Request("http://localhost/api/cron/expire-stale-listings", {
      headers: { authorization: "Bearer anything" },
    })
    const res = await cron.GET(req)
    expect(res.status).toBe(401)
  })

  it("sweeps both kinds for the correct bearer token", async () => {
    vi.stubEnv("VERCEL", "1")
    vi.stubEnv("CRON_SECRET", "cron-secret-for-tests")
    mock.queue(
      { data: [{ id: "p1" }], error: null },
      { data: [{ id: "t1" }, { id: "t2" }], error: null }
    )
    const req = new Request("http://localhost/api/cron/expire-stale-listings", {
      headers: { authorization: "Bearer cron-secret-for-tests" },
    })
    const res = await cron.GET(req)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      ok: true,
      packagesExpired: 1,
      tripsExpired: 2,
      expiredCount: 3,
    })
  })
})
