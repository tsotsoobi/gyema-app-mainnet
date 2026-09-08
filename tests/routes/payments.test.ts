import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { AdminMock, adminModule, postJson } from "../helpers/admin-mock"

// S-3. These two routes used to take a paymentId from anybody and spend
// PI_API_KEY on it. Every test here is a caller who should not get that.

const mock = new AdminMock()
vi.mock("@/lib/supabase-admin", () => adminModule(mock))

const approve = await import("@/app/api/payments/approve/route")
const complete = await import("@/app/api/payments/complete/route")

const TXID = "a".repeat(64)

/** A fetch stub that answers the Pi payment lookup and the approve/complete. */
function piFetch(options: {
  payment?: unknown
  lookupStatus?: number
  actionStatus?: number
  actionBody?: string
}) {
  const {
    payment,
    lookupStatus = 200,
    actionStatus = 200,
    actionBody = JSON.stringify({ ok: true }),
  } = options
  return vi.fn(async (url: string, init?: { method?: string }) => {
    const isAction = (init?.method ?? "GET") === "POST"
    if (isAction) {
      return new Response(actionBody, { status: actionStatus })
    }
    return new Response(JSON.stringify(payment ?? {}), { status: lookupStatus })
  })
}

const CONNECTION_FEE = {
  identifier: "p1",
  amount: 1,
  memo: "Gyema connection fee",
  metadata: { type: "connection_fee", app: "gyema", listingId: "l1" },
}

beforeEach(() => {
  mock.calls = []
  mock.results = []
  mock.asAnonymousFailure()
  vi.stubEnv("PI_API_KEY", "test-key-not-a-real-key")
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe("POST /api/payments/approve", () => {
  it("refuses a caller with no session, and calls Pi not at all", async () => {
    const fetchSpy = piFetch({ payment: CONNECTION_FEE })
    vi.stubGlobal("fetch", fetchSpy)
    const res = await approve.POST(
      postJson("http://localhost/x", { paymentId: "p1" }) as never
    )
    expect(res.status).toBe(401)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("approves a connection fee for a listing the caller has claimed", async () => {
    mock.asPioneer("pi-real", "real_one")
    mock.queue({ data: { id: "l1", matched_with_user_id: "pi-real" }, error: null })
    const fetchSpy = piFetch({ payment: CONNECTION_FEE })
    vi.stubGlobal("fetch", fetchSpy)
    const res = await approve.POST(
      postJson("http://localhost/x", { accessToken: "good", paymentId: "p1" }) as never
    )
    expect(res.status).toBe(200)
    // Looked the payment up first, then approved it.
    expect(fetchSpy.mock.calls[0][0]).toContain("/v2/payments/p1")
    expect(fetchSpy.mock.calls[1][0]).toContain("/v2/payments/p1/approve")
  })

  it("refuses a connection fee for a listing claimed by somebody else", async () => {
    mock.asPioneer("pi-real", "real_one")
    mock.queue({ data: { id: "l1", matched_with_user_id: "pi-someone-else" }, error: null })
    const fetchSpy = piFetch({ payment: CONNECTION_FEE })
    vi.stubGlobal("fetch", fetchSpy)
    const res = await approve.POST(
      postJson("http://localhost/x", { accessToken: "good", paymentId: "p1" }) as never
    )
    expect(res.status).toBe(403)
    // The lookup happened; the approve did not.
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it("refuses an amount that is not the fee, in either direction", async () => {
    for (const amount of [0.5, 2, 1000]) {
      mock.calls = []
      mock.results = []
      mock.asPioneer("pi-real", "real_one")
      mock.queue({ data: { id: "l1", matched_with_user_id: "pi-real" }, error: null })
      const fetchSpy = piFetch({ payment: { ...CONNECTION_FEE, amount } })
      vi.stubGlobal("fetch", fetchSpy)
      const res = await approve.POST(
        postJson("http://localhost/x", { accessToken: "good", paymentId: "p1" }) as never
      )
      expect(res.status).toBe(403)
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    }
  })

  it("refuses a payment type this app does not create", async () => {
    mock.asPioneer("pi-real", "real_one")
    const fetchSpy = piFetch({
      payment: { identifier: "p1", amount: 1, metadata: { type: "something_else" } },
    })
    vi.stubGlobal("fetch", fetchSpy)
    const res = await approve.POST(
      postJson("http://localhost/x", { accessToken: "good", paymentId: "p1" }) as never
    )
    expect(res.status).toBe(403)
  })

  it("refuses a connection fee that names no listing", async () => {
    mock.asPioneer("pi-real", "real_one")
    const fetchSpy = piFetch({
      payment: { identifier: "p1", amount: 1, metadata: { type: "connection_fee" } },
    })
    vi.stubGlobal("fetch", fetchSpy)
    const res = await approve.POST(
      postJson("http://localhost/x", { accessToken: "good", paymentId: "p1" }) as never
    )
    expect(res.status).toBe(403)
  })

  it("allows the checklist test payment at its own amount only", async () => {
    mock.asPioneer("pi-real", "real_one")
    vi.stubGlobal(
      "fetch",
      piFetch({ payment: { identifier: "p1", amount: 0.001, metadata: { type: "checklist_test" } } })
    )
    const ok = await approve.POST(
      postJson("http://localhost/x", { accessToken: "good", paymentId: "p1" }) as never
    )
    expect(ok.status).toBe(200)

    mock.asPioneer("pi-real", "real_one")
    vi.stubGlobal(
      "fetch",
      piFetch({ payment: { identifier: "p1", amount: 5, metadata: { type: "checklist_test" } } })
    )
    const refused = await approve.POST(
      postJson("http://localhost/x", { accessToken: "good", paymentId: "p1" }) as never
    )
    expect(refused.status).toBe(403)
  })

  it("refuses a payment Pi does not recognise", async () => {
    mock.asPioneer("pi-real", "real_one")
    vi.stubGlobal("fetch", piFetch({ lookupStatus: 404 }))
    const res = await approve.POST(
      postJson("http://localhost/x", { accessToken: "good", paymentId: "p1" }) as never
    )
    expect(res.status).toBe(404)
  })

  it("does not echo Pi's error body when the approve fails", async () => {
    mock.asPioneer("pi-real", "real_one")
    mock.queue({ data: { id: "l1", matched_with_user_id: "pi-real" }, error: null })
    vi.stubGlobal(
      "fetch",
      piFetch({
        payment: CONNECTION_FEE,
        actionStatus: 500,
        actionBody: "pi internal detail nobody outside should read",
      })
    )
    const res = await approve.POST(
      postJson("http://localhost/x", { accessToken: "good", paymentId: "p1" }) as never
    )
    expect(res.status).toBe(502)
    const text = await res.text()
    expect(text).not.toContain("pi internal detail")
    expect(JSON.parse(text)).toEqual({ ok: false, reason: "pi_approve_failed" })
  })
})

describe("POST /api/payments/complete", () => {
  it("refuses a caller with no session", async () => {
    const fetchSpy = piFetch({ payment: CONNECTION_FEE })
    vi.stubGlobal("fetch", fetchSpy)
    const res = await complete.POST(
      postJson("http://localhost/x", { paymentId: "p1", txid: TXID }) as never
    )
    expect(res.status).toBe(401)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("refuses a txid that is not a transaction hash", async () => {
    mock.asPioneer("pi-real", "real_one")
    const fetchSpy = piFetch({ payment: CONNECTION_FEE })
    vi.stubGlobal("fetch", fetchSpy)
    const res = await complete.POST(
      postJson("http://localhost/x", {
        accessToken: "good",
        paymentId: "p1",
        txid: "not-a-txid",
      }) as never
    )
    expect(res.status).toBe(400)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("completes a bound payment", async () => {
    mock.asPioneer("pi-real", "real_one")
    mock.queue({ data: { id: "l1", matched_with_user_id: "pi-real" }, error: null })
    const fetchSpy = piFetch({ payment: CONNECTION_FEE })
    vi.stubGlobal("fetch", fetchSpy)
    const res = await complete.POST(
      postJson("http://localhost/x", { accessToken: "good", paymentId: "p1", txid: TXID }) as never
    )
    expect(res.status).toBe(200)
    expect(fetchSpy.mock.calls[1][0]).toContain("/v2/payments/p1/complete")
  })

  it("refuses a payment bound to another Pioneer's listing", async () => {
    mock.asPioneer("pi-real", "real_one")
    mock.queue({ data: { id: "l1", matched_with_user_id: "pi-other" }, error: null })
    vi.stubGlobal("fetch", piFetch({ payment: CONNECTION_FEE }))
    const res = await complete.POST(
      postJson("http://localhost/x", { accessToken: "good", paymentId: "p1", txid: TXID }) as never
    )
    expect(res.status).toBe(403)
  })

  it("does not echo Pi's error body when the complete fails", async () => {
    mock.asPioneer("pi-real", "real_one")
    mock.queue({ data: { id: "l1", matched_with_user_id: "pi-real" }, error: null })
    vi.stubGlobal(
      "fetch",
      piFetch({
        payment: CONNECTION_FEE,
        actionStatus: 502,
        actionBody: "pi internal detail nobody outside should read",
      })
    )
    const res = await complete.POST(
      postJson("http://localhost/x", { accessToken: "good", paymentId: "p1", txid: TXID }) as never
    )
    const text = await res.text()
    expect(res.status).toBe(502)
    expect(text).not.toContain("pi internal detail")
  })
})
