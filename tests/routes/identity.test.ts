import { describe, it, expect, vi, beforeEach } from "vitest"
import { readFileSync } from "node:fs"
import { AdminMock, adminModule, postJson } from "../helpers/admin-mock"

// One question, asked of every route that acts on behalf of a Pioneer: where
// does the pi_uid come from?
//
// It used to come from user_metadata, which a signed in client writes itself
// with supabase.auth.updateUser({ data: { ... } }) holding nothing but the anon
// key and their own session. pi_uid is what decides who owns a listing, who may
// cancel a delivery and whose phone number the counterpart RPC returns, so a
// Pioneer could set theirs to somebody else's and become them everywhere that
// value was read.
//
// It now comes from app_metadata, which only the service_role key can write.
//
// AdminMock.asPioneer puts the real identity in app_metadata and a different,
// attacker-shaped one in user_metadata, so a route that reads the wrong field
// does not merely fail: it acts as "pi-forged-by-the-user" and says so.

const mock = new AdminMock()
vi.mock("@/lib/supabase-admin", () => adminModule(mock))

const accept = await import("@/app/api/listings/accept/route")
const release = await import("@/app/api/listings/release/route")
const confirm = await import("@/app/api/listings/confirm-completion/route")
const cancelOpen = await import("@/app/api/listings/cancel-open/route")
const cancelMatched = await import("@/app/api/listings/cancel-matched/route")
const markInTransit = await import("@/app/api/listings/mark-in-transit/route")
const guestAccept = await import("@/app/api/guest/accept/route")
const guestMine = await import("@/app/api/guest/mine/route")
const guestConfirmDelivery = await import("@/app/api/guest/confirm-delivery/route")

const FORGED = "pi-forged-by-the-user"

beforeEach(() => {
  mock.calls = []
  mock.results = []
  mock.rpcResults = []
})

describe("every route reads app_metadata, never user_metadata", () => {
  it("listings/accept claims as the app_metadata uid", async () => {
    mock.asPioneer("pi-real", "real_one")
    mock.queue({ data: { id: "l1" }, error: null })
    await accept.POST(
      postJson("http://localhost/x", { accessToken: "good", listingId: "l1" }) as never
    )
    const trace = mock.trace().join(" ")
    expect(trace).toContain("pi-real")
    expect(trace).not.toContain(FORGED)
  })

  it("listings/release reverts the app_metadata uid's own claim", async () => {
    mock.asPioneer("pi-real", "real_one")
    mock.queue({ data: { id: "l1" }, error: null })
    await release.POST(
      postJson("http://localhost/x", { accessToken: "good", listingId: "l1" }) as never
    )
    const trace = mock.trace().join(" ")
    expect(trace).toContain('eq("matched_with_user_id", "pi-real")')
    expect(trace).not.toContain(FORGED)
  })

  it("listings/confirm-completion hands the RPC the app_metadata uid", async () => {
    mock.asPioneer("pi-real", "real_one")
    mock.queueRpc({ data: [{ id: "l1" }], error: null })
    await confirm.POST(
      postJson("http://localhost/x", { accessToken: "good", listingId: "l1" }) as never
    )
    const rpc = mock.calls.find((c) => c.method === "rpc")
    expect(JSON.stringify(rpc?.args[1])).toContain("pi-real")
    expect(JSON.stringify(rpc?.args[1])).not.toContain(FORGED)
  })

  it("listings/cancel-open guards on the app_metadata uid", async () => {
    mock.asPioneer("pi-real", "real_one")
    mock.queue({ data: { id: "l1", status: "expired" }, error: null })
    await cancelOpen.POST(
      postJson("http://localhost/x", { accessToken: "good", listingId: "l1" }) as never
    )
    expect(mock.trace()).toContain('eq("posted_by_id", "pi-real")')
    expect(mock.trace().join(" ")).not.toContain(FORGED)
  })

  it("listings/cancel-matched filters on the app_metadata uid", async () => {
    mock.asPioneer("pi-real", "real_one")
    mock.queue({ data: { id: "l1", status: "expired" }, error: null })
    await cancelMatched.POST(
      postJson("http://localhost/x", { accessToken: "good", listingId: "l1" }) as never
    )
    expect(mock.trace().join(" ")).toContain("posted_by_id.eq.pi-real")
    expect(mock.trace().join(" ")).not.toContain(FORGED)
  })

  it("listings/mark-in-transit compares the app_metadata uid to the traveller", async () => {
    mock.asPioneer("pi-real", "real_one")
    mock.queue({
      data: {
        id: "l1",
        kind: "trip",
        status: "matched",
        posted_by_id: FORGED,
        matched_with_user_id: "pi-other",
      },
      error: null,
    })
    // The listing's traveller is the forged uid. A route reading user_metadata
    // would let this through; reading app_metadata it is a stranger.
    const res = await markInTransit.POST(
      postJson("http://localhost/x", { accessToken: "good", listingId: "l1" }) as never
    )
    expect(res.status).toBe(403)
  })

  it("guest/accept assigns the app_metadata username as courier", async () => {
    mock.asPioneer("pi-real", "real_courier")
    mock.queue({ data: { tracking_id: "GYM-A1B2C3" }, error: null })
    await guestAccept.POST(
      postJson("http://localhost/x", {
        accessToken: "good",
        trackingId: "GYM-A1B2C3",
      }) as never
    )
    const update = mock.calls.find((c) => c.method === "update")
    expect((update?.args[0] as Record<string, unknown>).assigned_courier).toBe("real_courier")
    expect(JSON.stringify(update?.args[0])).not.toContain("forged_by_the_user")
  })

  it("guest/mine matches on the app_metadata username", async () => {
    mock.asPioneer("pi-real", "real_courier")
    mock.queue({ data: [], error: null })
    await guestMine.POST(postJson("http://localhost/x", { accessToken: "good" }) as never)
    expect(mock.trace()).toContain('eq("assigned_courier", "real_courier")')
    expect(mock.trace().join(" ")).not.toContain("forged_by_the_user")
  })

  it("guest/confirm-delivery checks the app_metadata username against the assignment", async () => {
    mock.asPioneer("pi-real", "real_courier")
    mock.queue({
      data: {
        tracking_id: "GYM-A1B2C3",
        status: "in_transit",
        sender_phone: "0244123456",
        // The job is assigned to the courier the ATTACKER named in their own
        // user_metadata. Reading app_metadata, the caller is not that courier.
        assigned_courier: "forged_by_the_user",
        delivery_confirmed_by: null,
        delivery_code_hash: "hash",
        delivery_code_attempts: 0,
      },
      error: null,
    })
    const res = await guestConfirmDelivery.POST(
      postJson("http://localhost/x", {
        trackingId: "GYM-A1B2C3",
        via: "courier_code",
        code: "1234",
        accessToken: "good",
      }) as never
    )
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ reason: "not_assigned" })
  })
})

describe("a user with an identity only in user_metadata is refused", () => {
  // An account that predates the backfill, or somebody who called updateUser
  // and hoped. There is no fallback: the answer is 401 until they sign in
  // again, which stamps app_metadata.
  const cases: Array<[string, () => Promise<Response>]> = [
    ["listings/accept", () =>
      accept.POST(postJson("http://localhost/x", { accessToken: "good", listingId: "l1" }) as never)],
    ["listings/release", () =>
      release.POST(postJson("http://localhost/x", { accessToken: "good", listingId: "l1" }) as never)],
    ["listings/confirm-completion", () =>
      confirm.POST(postJson("http://localhost/x", { accessToken: "good", listingId: "l1" }) as never)],
    ["listings/cancel-open", () =>
      cancelOpen.POST(postJson("http://localhost/x", { accessToken: "good", listingId: "l1" }) as never)],
    ["listings/cancel-matched", () =>
      cancelMatched.POST(postJson("http://localhost/x", { accessToken: "good", listingId: "l1" }) as never)],
    ["listings/mark-in-transit", () =>
      markInTransit.POST(postJson("http://localhost/x", { accessToken: "good", listingId: "l1" }) as never)],
    ["guest/accept", () =>
      guestAccept.POST(postJson("http://localhost/x", { accessToken: "good", trackingId: "GYM-A1B2C3" }) as never)],
    ["guest/mine", () =>
      guestMine.POST(postJson("http://localhost/x", { accessToken: "good" }) as never)],
  ]

  for (const [name, call] of cases) {
    it(`${name} answers 401`, async () => {
      mock.asForgedMetadataOnly()
      mock.queue({ data: null, error: null })
      const res = await call()
      expect(res.status).toBe(401)
      // And nothing was written on the strength of it.
      expect(mock.calls.some((c) => c.method === "update")).toBe(false)
      expect(mock.calls.some((c) => c.method === "insert")).toBe(false)
      expect(mock.calls.some((c) => c.method === "rpc")).toBe(false)
    })
  }
})

describe("no route reads user_metadata at all any more", () => {
  const routes = [
    "app/api/listings/accept/route.ts",
    "app/api/listings/release/route.ts",
    "app/api/listings/confirm-completion/route.ts",
    "app/api/listings/cancel-open/route.ts",
    "app/api/listings/cancel-matched/route.ts",
    "app/api/listings/mark-in-transit/route.ts",
    "app/api/guest/accept/route.ts",
    "app/api/guest/mine/route.ts",
    "app/api/guest/confirm-delivery/route.ts",
    "app/api/guest/create/route.ts",
    "app/api/guest/track/route.ts",
    "app/api/guest/open/route.ts",
    "app/api/guest/delivery-code/route.ts",
    "app/api/guest/confirm-pickup/route.ts",
    "app/api/cron/expire-stale-listings/route.ts",
    "lib/route-auth.ts",
  ]

  for (const file of routes) {
    it(`${file} does not read user_metadata`, () => {
      const code = readFileSync(file, "utf8")
        .split(/\r?\n/)
        .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
        .join("\n")
      expect(code).not.toContain("user_metadata")
    })
  }

  it("lib/route-auth.ts is the only place that reads app_metadata off a user", () => {
    const readers = routes.filter((f) => {
      const code = readFileSync(f, "utf8")
        .split(/\r?\n/)
        .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
        .join("\n")
      return code.includes("app_metadata")
    })
    expect(readers).toEqual(["lib/route-auth.ts"])
  })
})
