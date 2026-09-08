import { describe, it, expect, vi, beforeEach } from "vitest"
import { AdminMock, adminModule, postJson } from "../helpers/admin-mock"

const mock = new AdminMock()
vi.mock("@/lib/supabase-admin", () => adminModule(mock))

const accept = await import("@/app/api/listings/accept/route")
const release = await import("@/app/api/listings/release/route")
const confirm = await import("@/app/api/listings/confirm-completion/route")

beforeEach(() => {
  mock.calls = []
  mock.results = []
  mock.rpcResults = []
  mock.asAnonymousFailure()
})

describe("POST /api/listings/accept", () => {
  it("rejects a request with no token or listing id", async () => {
    const res = await accept.POST(postJson("http://localhost/x", {}) as never)
    expect(res.status).toBe(400)
  })

  it("rejects a token the admin client cannot resolve", async () => {
    const res = await accept.POST(
      postJson("http://localhost/x", { accessToken: "bad", listingId: "l1" }) as never
    )
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ reason: "unauthorized" })
  })

  it("claims only an open listing that the caller does not own", async () => {
    mock.asPioneer("pi-uid-1", "pioneer_one")
    mock.queue({ data: { id: "l1", status: "matched" }, error: null })
    const res = await accept.POST(
      postJson("http://localhost/x", { accessToken: "good", listingId: "l1" }) as never
    )
    expect(res.status).toBe(200)
    const trace = mock.trace()
    // The guards that make the claim safe, asserted as the route's contract.
    expect(trace).toContain('eq("status", "open")')
    expect(trace).toContain('neq("posted_by_id", "pi-uid-1")')
  })

  it("never takes the accepter identity from the body", async () => {
    mock.asPioneer("pi-uid-1", "pioneer_one")
    mock.queue({ data: { id: "l1" }, error: null })
    await accept.POST(
      postJson("http://localhost/x", {
        accessToken: "good",
        listingId: "l1",
        pi_uid: "someone-else",
      }) as never
    )
    expect(mock.trace().join(" ")).not.toContain("someone-else")
  })
})

describe("POST /api/listings/release", () => {
  it("rejects an unresolvable token", async () => {
    const res = await release.POST(
      postJson("http://localhost/x", { accessToken: "bad", listingId: "l1" }) as never
    )
    expect(res.status).toBe(401)
  })

  it("reverts only the caller's own still-matched claim", async () => {
    mock.asPioneer("pi-uid-1")
    mock.queue({ data: { id: "l1", status: "open" }, error: null })
    const res = await release.POST(
      postJson("http://localhost/x", { accessToken: "good", listingId: "l1" }) as never
    )
    expect(res.status).toBe(200)
    const trace = mock.trace()
    expect(trace).toContain('eq("status", "matched")')
    expect(trace).toContain('eq("matched_with_user_id", "pi-uid-1")')
  })
})

describe("POST /api/listings/confirm-completion", () => {
  it("rejects a request with no token", async () => {
    const res = await confirm.POST(postJson("http://localhost/x", { listingId: "l1" }) as never)
    expect(res.status).toBe(400)
  })

  it("sends no role, party or side to the RPC (invariant 1, the F17 rule)", async () => {
    mock.asPioneer("pi-uid-1")
    mock.queueRpc({ data: [{ id: "l1", status: "completed" }], error: null })
    await confirm.POST(
      postJson("http://localhost/x", {
        accessToken: "good",
        listingId: "l1",
        // A client trying the old shape. It must not reach the RPC.
        role: "sender",
      }) as never
    )
    const rpcCall = mock.calls.find((c) => c.method === "rpc")
    expect(rpcCall).toBeDefined()
    const params = JSON.stringify(rpcCall?.args[1] ?? {})
    expect(params).not.toContain("sender")
    expect(params).not.toContain("role")
  })
})
