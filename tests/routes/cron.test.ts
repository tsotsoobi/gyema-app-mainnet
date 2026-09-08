import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { AdminMock, adminModule, get } from "../helpers/admin-mock"

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

// The payment routes moved to tests/routes/payments.test.ts when they gained
// a session, a listing binding and an amount check (S-3).

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
