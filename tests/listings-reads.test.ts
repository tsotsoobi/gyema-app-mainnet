import { describe, it, expect, vi, beforeEach } from "vitest"
import { readFileSync } from "node:fs"

// The Pioneer rail's data access. These tests are about one thing: after
// db/migrations/2026-09-07_grant_baseline.sql, neither anon nor authenticated
// can read listings.whatsapp or listings.matched_with_whatsapp, so any query
// that asks for them is answered with 42501 rather than with a phone number.
//
// A select("*") is exactly such a query. That is what finding S-1 was, and it
// is why these assert the column list rather than the returned payload: the
// payload was never the problem, the request was.

type Call = { method: string; args: unknown[] }
const calls: Call[] = []
let result: { data: unknown; error: unknown } = { data: [], error: null }
let rpcResult: { data: unknown; error: unknown } = { data: null, error: null }

function builder() {
  const b: Record<string, unknown> = {}
  for (const m of ["from", "select", "eq", "or", "order", "insert", "update", "limit", "is", "neq"]) {
    b[m] = (...args: unknown[]) => {
      calls.push({ method: m, args })
      return b
    }
  }
  b.single = () => Promise.resolve(result)
  b.maybeSingle = () => Promise.resolve(result)
  b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(res, rej)
  return b
}

const client = {
  from: (t: string) => {
    calls.push({ method: "from", args: [t] })
    return builder()
  },
  rpc: (name: string, params?: unknown) => {
    calls.push({ method: "rpc", args: [name, params] })
    return Promise.resolve(rpcResult)
  },
}

vi.mock("@/lib/supabase", () => ({
  getAnonClient: () => client,
  getAuthedClient: () => client,
  supabase: client,
  createAuthedSupabase: () => client,
}))
vi.mock("@/lib/pi-network", () => ({
  getSupabaseSession: () => ({ accessToken: "at", refreshToken: "rt" }),
}))

const listings = await import("@/lib/listings-async")

const PHONE_COLUMNS = ["whatsapp", "matched_with_whatsapp"]

/** Every column string this test run passed to .select(). */
function selects(): string[] {
  return calls.filter((c) => c.method === "select").map((c) => String(c.args[0] ?? ""))
}

beforeEach(() => {
  calls.length = 0
  result = { data: [], error: null }
  rpcResult = { data: null, error: null }
})

describe("Pioneer reads name their columns", () => {
  it("the open listings feed asks for no phone column and never for *", async () => {
    await listings.getOpenListingsAsync()
    const s = selects()
    expect(s).toHaveLength(1)
    expect(s[0]).not.toBe("*")
    expect(s[0]).toContain("tracking_id")
    for (const c of PHONE_COLUMNS) expect(s[0]).not.toContain(c)
  })

  it("the public track lookup asks for no phone column and never for *", async () => {
    result = { data: null, error: null }
    await listings.getListingByTrackingIdAsync("GYM-A1B2C3")
    const s = selects()
    expect(s).toHaveLength(1)
    expect(s[0]).not.toBe("*")
    for (const c of PHONE_COLUMNS) expect(s[0]).not.toContain(c)
  })

  it("My Activity asks for no phone column either, though it is authenticated", async () => {
    // Worth its own test: this read is not public, and the temptation is to
    // treat "signed in" as "allowed". The grant does not work that way. It is
    // column level for authenticated too, so a select("*") here fails at the
    // database just as it does for anon, and a Pioneer cannot read their own
    // stored number back either.
    await listings.getListingsByUserAsync("pi-uid-1")
    const s = selects()
    expect(s).toHaveLength(1)
    expect(s[0]).not.toBe("*")
    for (const c of PHONE_COLUMNS) expect(s[0]).not.toContain(c)
  })

  it("no read or write path anywhere in the module uses select(*) or a bare select()", () => {
    // Comment lines are stripped first: the header above LISTING_COLUMNS
    // explains why supabase-js needs a string literal and writes ".select()"
    // in prose, which is not a call.
    const source = readFileSync("lib/listings-async.ts", "utf8")
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
      .join("\n")
    expect(source).not.toContain('.select("*")')
    // A bare .select() after an insert or update returns every column, which is
    // the same request in a different shape.
    expect(source).not.toMatch(/\.select\(\s*\)/)
  })

  // This test used to assert the column list on the insert that createTripAsync
  // ran through the authed client. There is no such insert any more: creation
  // moved to app/api/listings/create so the server could own posted_by_id,
  // posted_by_username, status, tracking_id and created_at (finding S-15).
  // The column-list property moved with it and is asserted against the route in
  // tests/routes/listings-create.test.ts. What belongs HERE is the boundary
  // itself: this module must not write listings at all.
  it("creation no longer touches the database from the client", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, listing: { id: "l1", kind: "trip" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    )
    const originalFetch = globalThis.fetch
    globalThis.fetch = fetchMock as unknown as typeof fetch
    try {
      await listings.createTripAsync({
        whatsapp: "0244123456",
        fromCity: "Accra",
        toCity: "Kumasi",
        travelDate: "2026-10-01",
        capacity: "small",
        pricePi: 5,
        notes: "",
      })
    } finally {
      globalThis.fetch = originalFetch
    }

    // No insert, no select, nothing asked of Supabase from the browser.
    expect(calls.find((c) => c.method === "insert")).toBeUndefined()
    expect(selects()).toHaveLength(0)

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe("/api/listings/create")
    const sent = JSON.parse(String(init.body)) as Record<string, unknown>
    // The number still goes in: a poster writes their own.
    expect(sent.whatsapp).toBe("0244123456")
    // Identity is not the client's to send. The route derives both from the
    // session token and its schema is strict, so these would be a 400.
    expect(sent).not.toHaveProperty("postedById")
    expect(sent).not.toHaveProperty("postedByUsername")
    expect(sent).not.toHaveProperty("status")
    expect(sent).not.toHaveProperty("trackingId")
    expect(sent).not.toHaveProperty("createdAt")
  })

  it("a mapped Listing carries no phone field at all", async () => {
    result = {
      data: [
        {
          id: "l1",
          kind: "trip",
          from_city: "Accra",
          to_city: "Kumasi",
          posted_by_id: "pi-uid-1",
          posted_by_username: "poster_one",
          status: "open",
          tracking_id: "GYM-A1B2C3",
          created_at: "2026-09-01T00:00:00Z",
          travel_date: "2026-10-01",
          capacity: "small",
          price_pi: 5,
          notes: "",
          matched_with_user_id: null,
          matched_with_username: null,
          matched_at: null,
          sender_confirmed: false,
          traveller_confirmed: false,
          completed_at: null,
          archived_at: null,
          archived_by_matched_at: null,
        },
      ],
      error: null,
    }
    const rows = await listings.getOpenListingsAsync()
    expect(rows).toHaveLength(1)
    expect(Object.keys(rows[0])).not.toContain("whatsapp")
    expect(Object.keys(rows[0])).not.toContain("matchedWithWhatsapp")
  })
})

describe("getCounterpartContactAsync", () => {
  it("goes through the RPC, not the table", async () => {
    rpcResult = {
      data: [
        {
          counterparty_role: "matched",
          counterparty_username: "courier_one",
          whatsapp: "0244000002",
        },
      ],
      error: null,
    }
    const contact = await listings.getCounterpartContactAsync("l-matched")
    const rpc = calls.find((c) => c.method === "rpc")
    expect(rpc?.args[0]).toBe("listing_counterpart_contact")
    expect(rpc?.args[1]).toEqual({ p_listing_id: "l-matched" })
    expect(contact).toEqual({
      counterpartyRole: "matched",
      counterpartyUsername: "courier_one",
      whatsapp: "0244000002",
    })
    // It must never fall back to reading the column itself.
    expect(selects()).toHaveLength(0)
  })

  it("returns null when the function returns no row, whatever the reason", async () => {
    // Not a party, no such listing, and not matched yet all look like this,
    // and the caller cannot tell them apart. That is deliberate.
    rpcResult = { data: [], error: null }
    expect(await listings.getCounterpartContactAsync("l-other")).toBeNull()
    rpcResult = { data: null, error: null }
    expect(await listings.getCounterpartContactAsync("l-other")).toBeNull()
  })

  it("returns null and does not throw when the call is refused", async () => {
    rpcResult = { data: null, error: { message: "permission denied for function" } }
    expect(await listings.getCounterpartContactAsync("l-matched")).toBeNull()
  })
})

describe("the detail sheet reads contact from the RPC", () => {
  const source = readFileSync("components/listing-detail-sheet.tsx", "utf8")

  it("no longer reads a phone number off the listing row", () => {
    expect(source).not.toContain("listing.matchedWithWhatsapp")
    expect(source).not.toContain("listing.whatsapp")
  })

  it("calls the RPC accessor instead", () => {
    expect(source).toContain("getCounterpartContactAsync")
  })

  it("only asks when the viewer is a party and the listing is matched", () => {
    // The guard that keeps a pointless refused call off every open listing.
    expect(source).toContain("if (!isPartyToListing || !listing.matchedWithUserId)")
  })
})
