import { describe, it, expect, vi, beforeEach } from "vitest"
import { AdminMock, adminModule, postJson } from "../helpers/admin-mock"

// The three status transitions that used to be client side UPDATEs.
//
// What these tests are really asserting is that the party rule is now the
// server's, not the UI's. The old markInTransitAsync carried a comment saying
// it was "traveller-only in practice (the UI gates the action)", which is a
// gate a REST client walks past. Every case below sends a well formed request
// from the wrong party and expects a refusal.

const mock = new AdminMock()
vi.mock("@/lib/supabase-admin", () => adminModule(mock))

const cancelOpen = await import("@/app/api/listings/cancel-open/route")
const cancelMatched = await import("@/app/api/listings/cancel-matched/route")
const markInTransit = await import("@/app/api/listings/mark-in-transit/route")

beforeEach(() => {
  mock.calls = []
  mock.results = []
  mock.rpcResults = []
  mock.asAnonymousFailure()
})

describe("POST /api/listings/cancel-open", () => {
  it("rejects a request with no token or listing id", async () => {
    const res = await cancelOpen.POST(postJson("http://localhost/x", {}) as never)
    expect(res.status).toBe(400)
  })

  it("rejects a token the admin client cannot resolve", async () => {
    const res = await cancelOpen.POST(
      postJson("http://localhost/x", { accessToken: "bad", listingId: "l1" }) as never
    )
    expect(res.status).toBe(401)
  })

  it("guards the update to the caller's own open listing", async () => {
    mock.asPioneer("pi-poster", "poster_one")
    mock.queue({ data: { id: "l1", status: "expired" }, error: null })
    const res = await cancelOpen.POST(
      postJson("http://localhost/x", { accessToken: "good", listingId: "l1" }) as never
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, status: "expired" })
    const trace = mock.trace()
    expect(trace).toContain('eq("status", "open")')
    expect(trace).toContain('eq("posted_by_id", "pi-poster")')
    expect(mock.calls.find((c) => c.method === "update")?.args[0]).toEqual({
      status: "expired",
    })
  })

  it("answers a zero row update with one reason, whoever the caller was", async () => {
    // Somebody else's listing and an already accepted listing both land here.
    // Same status, same reason: this cannot be used to probe who posted what.
    mock.asPioneer("pi-stranger", "stranger")
    mock.queue({ data: null, error: null })
    const res = await cancelOpen.POST(
      postJson("http://localhost/x", { accessToken: "good", listingId: "l1" }) as never
    )
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ reason: "not_cancellable" })
  })

  it("never takes the poster identity from the body", async () => {
    mock.asPioneer("pi-poster", "poster_one")
    mock.queue({ data: { id: "l1", status: "expired" }, error: null })
    await cancelOpen.POST(
      postJson("http://localhost/x", {
        accessToken: "good",
        listingId: "l1",
        posted_by_id: "pi-someone-else",
      }) as never
    )
    expect(mock.trace().join(" ")).not.toContain("pi-someone-else")
  })
})

describe("POST /api/listings/cancel-matched", () => {
  it("rejects an unresolvable token", async () => {
    const res = await cancelMatched.POST(
      postJson("http://localhost/x", { accessToken: "bad", listingId: "l1" }) as never
    )
    expect(res.status).toBe(401)
  })

  it("admits either party and only from matched or in_transit", async () => {
    mock.asPioneer("pi-matched", "courier_one")
    mock.queue({ data: { id: "l1", status: "expired" }, error: null })
    const res = await cancelMatched.POST(
      postJson("http://localhost/x", { accessToken: "good", listingId: "l1" }) as never
    )
    expect(res.status).toBe(200)
    const trace = mock.trace()
    expect(trace).toContain('in("status", ["matched","in_transit"])')
    expect(trace).toContain(
      'or("posted_by_id.eq.pi-matched,matched_with_user_id.eq.pi-matched")'
    )
  })

  it("refuses a uid that could reshape the PostgREST filter", async () => {
    // The uid comes from a verified session, so this should be unreachable.
    // It is checked anyway because the value is interpolated into a filter
    // string, and a comma or paren there changes the structure of the query
    // rather than the value being compared.
    mock.asPioneer("pi-bad,matched_with_user_id.eq.anything", "sneaky")
    const res = await cancelMatched.POST(
      postJson("http://localhost/x", { accessToken: "good", listingId: "l1" }) as never
    )
    expect(res.status).toBe(401)
    // Nothing was asked of the database.
    expect(mock.calls.some((c) => c.method === "update")).toBe(false)
  })

  it("reports a zero row update as a conflict", async () => {
    mock.asPioneer("pi-stranger", "stranger")
    mock.queue({ data: null, error: null })
    const res = await cancelMatched.POST(
      postJson("http://localhost/x", { accessToken: "good", listingId: "l1" }) as never
    )
    expect(res.status).toBe(409)
  })
})

describe("POST /api/listings/mark-in-transit", () => {
  const tripListing = {
    id: "l1",
    kind: "trip",
    status: "matched",
    posted_by_id: "pi-traveller",
    matched_with_user_id: "pi-sender",
  }
  const packageListing = {
    id: "l2",
    kind: "package",
    status: "matched",
    posted_by_id: "pi-sender",
    matched_with_user_id: "pi-traveller",
  }

  it("rejects an unresolvable token", async () => {
    const res = await markInTransit.POST(
      postJson("http://localhost/x", { accessToken: "bad", listingId: "l1" }) as never
    )
    expect(res.status).toBe(401)
  })

  it("on a trip, the poster is the traveller and may mark it", async () => {
    mock.asPioneer("pi-traveller", "traveller_one")
    mock.queue(
      { data: tripListing, error: null },
      { data: { id: "l1", status: "in_transit" }, error: null }
    )
    const res = await markInTransit.POST(
      postJson("http://localhost/x", { accessToken: "good", listingId: "l1" }) as never
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, status: "in_transit" })
    expect(mock.trace()).toContain('eq("status", "matched")')
  })

  it("on a trip, the matched party is the sender and may not", async () => {
    mock.asPioneer("pi-sender", "sender_one")
    mock.queue({ data: tripListing, error: null })
    const res = await markInTransit.POST(
      postJson("http://localhost/x", { accessToken: "good", listingId: "l1" }) as never
    )
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ reason: "not_traveller" })
    // Refused before any write.
    expect(mock.calls.some((c) => c.method === "update")).toBe(false)
  })

  it("on a package, the matched party is the traveller and may mark it", async () => {
    mock.asPioneer("pi-traveller", "traveller_one")
    mock.queue(
      { data: packageListing, error: null },
      { data: { id: "l2", status: "in_transit" }, error: null }
    )
    const res = await markInTransit.POST(
      postJson("http://localhost/x", { accessToken: "good", listingId: "l2" }) as never
    )
    expect(res.status).toBe(200)
  })

  it("on a package, the poster is the sender and may not", async () => {
    mock.asPioneer("pi-sender", "sender_one")
    mock.queue({ data: packageListing, error: null })
    const res = await markInTransit.POST(
      postJson("http://localhost/x", { accessToken: "good", listingId: "l2" }) as never
    )
    expect(res.status).toBe(403)
  })

  it("refuses a stranger with the same answer as the sender", async () => {
    mock.asPioneer("pi-stranger", "stranger")
    mock.queue({ data: tripListing, error: null })
    const res = await markInTransit.POST(
      postJson("http://localhost/x", { accessToken: "good", listingId: "l1" }) as never
    )
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ reason: "not_traveller" })
  })

  it("takes no role, party or side from the body", async () => {
    mock.asPioneer("pi-sender", "sender_one")
    mock.queue({ data: tripListing, error: null })
    const res = await markInTransit.POST(
      postJson("http://localhost/x", {
        accessToken: "good",
        listingId: "l1",
        role: "traveller",
        party: "traveller",
        side: "traveller",
      }) as never
    )
    // The sender said they were the traveller. The row says otherwise.
    expect(res.status).toBe(403)
  })

  it("reports a state change between the read and the write honestly", async () => {
    mock.asPioneer("pi-traveller", "traveller_one")
    mock.queue({ data: tripListing, error: null }, { data: null, error: null })
    const res = await markInTransit.POST(
      postJson("http://localhost/x", { accessToken: "good", listingId: "l1" }) as never
    )
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ reason: "not_transitionable" })
  })
})

describe("the client no longer writes status directly", () => {
  it("lib/listings-async.ts contains no status UPDATE through the authed client", async () => {
    const { readFileSync } = await import("node:fs")
    const source = readFileSync("lib/listings-async.ts", "utf8")
      .split(/\r?\n/)
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .join("\n")
    expect(source).not.toContain('.update({ status:')
    expect(source).not.toContain('status: "expired"')
    expect(source).not.toContain('status: "in_transit"')
  })
})
