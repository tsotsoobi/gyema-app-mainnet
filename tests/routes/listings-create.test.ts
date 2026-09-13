import { describe, it, expect, vi, beforeEach } from "vitest"
import { AdminMock, adminModule, postJson } from "../helpers/admin-mock"

// Listing creation, and the five things a Pioneer could set before it moved
// here (finding S-15).
//
// The database policy listings_insert_own already pinned posted_by_id to the
// session claim. These are about everything it did not pin, because the grant
// behind it was table-wide: the policy filtered one column and the browser
// composed the rest of the row.
//
// Each attack gets a test that asserts TWO things, and the second is the one
// that matters: the request is refused, and NO ROW IS WRITTEN. A route that
// refuses the response but inserts anyway has not closed anything.

const mock = new AdminMock()
vi.mock("@/lib/supabase-admin", () => adminModule(mock))

const create = await import("@/app/api/listings/create/route")

/** A well-formed trip, with nothing the server owns. */
const GOOD_TRIP = {
  accessToken: "good",
  kind: "trip",
  fromCity: "Accra",
  toCity: "Kumasi",
  travelDate: "2026-10-01",
  capacity: "small",
  pricePi: 5,
  notes: "Small parcels only",
}

const GOOD_PACKAGE = {
  accessToken: "good",
  kind: "package",
  fromCity: "Accra",
  toCity: "Tamale",
  deliverBy: "2026-10-05",
  size: "medium",
  description: "Documents",
  offerPi: 12,
  whatsapp: "0244123456",
}

/** The two collision lookups plus the insert a successful create needs. */
function queueSuccess(row: Record<string, unknown> = {}) {
  mock.queue(
    { data: null, error: null },
    { data: null, error: null },
    { data: { id: "l1", kind: "trip", tracking_id: "GYM-ABC123", ...row }, error: null }
  )
}

/** The row the route actually asked the database to insert. */
function insertedRow(): Record<string, unknown> | undefined {
  const call = mock.calls.find((c) => c.method === "insert")
  return call?.args[0] as Record<string, unknown> | undefined
}

beforeEach(() => {
  mock.calls = []
  mock.results = []
  mock.rpcResults = []
  mock.asPioneer("pi-uid-1", "poster_one")
})

describe("POST /api/listings/create, the happy path", () => {
  it("creates a trip and derives everything the server owns", async () => {
    queueSuccess()
    const res = await create.POST(
      postJson("http://localhost/x", { ...GOOD_TRIP, whatsapp: "0244123456" }) as never
    )
    expect(res.status).toBe(200)

    const row = insertedRow()
    expect(row).toBeDefined()
    // Identity from the session, never from the body.
    expect(row?.posted_by_id).toBe("pi-uid-1")
    expect(row?.posted_by_username).toBe("poster_one")
    // Status, tracking ID and timestamp all minted here.
    expect(row?.status).toBe("open")
    expect(String(row?.tracking_id)).toMatch(/^GYM-[0-9A-F]{6}$/)
    expect(typeof row?.created_at).toBe("string")
    // A row is never born matched or confirmed. These take database defaults
    // rather than being written as null, so the accept route stays the only
    // thing that touches them.
    for (const column of [
      "matched_with_user_id",
      "matched_with_username",
      "matched_with_whatsapp",
      "matched_at",
      "sender_confirmed",
      "traveller_confirmed",
      "completed_at",
    ]) {
      expect(row).not.toHaveProperty(column)
    }
    // The poster's own contents did survive.
    expect(row?.from_city).toBe("Accra")
    expect(row?.price_pi).toBe(5)
  })

  it("creates a package with the package column set and no trip columns", async () => {
    queueSuccess({ kind: "package" })
    const res = await create.POST(postJson("http://localhost/x", GOOD_PACKAGE) as never)
    expect(res.status).toBe(200)

    const row = insertedRow()
    expect(row?.kind).toBe("package")
    expect(row?.deliver_by).toBe("2026-10-05")
    expect(row).not.toHaveProperty("travel_date")
    expect(row).not.toHaveProperty("price_pi")
  })

  it("refuses a caller with no usable session before writing anything", async () => {
    mock.asAnonymousFailure()
    const res = await create.POST(
      postJson("http://localhost/x", { ...GOOD_TRIP, whatsapp: "0244123456" }) as never
    )
    expect(res.status).toBe(401)
    expect(insertedRow()).toBeUndefined()
  })

  // The forged-metadata user from the shared harness: a Pi identity written
  // into user_metadata, which a client can set itself, and nothing in
  // app_metadata. Every route must refuse it.
  it("refuses an identity forged in user_metadata", async () => {
    mock.asForgedMetadataOnly()
    const res = await create.POST(
      postJson("http://localhost/x", { ...GOOD_TRIP, whatsapp: "0244123456" }) as never
    )
    expect(res.status).toBe(401)
    expect(insertedRow()).toBeUndefined()
  })

  it("never selects a phone column back out of the insert", async () => {
    queueSuccess()
    await create.POST(
      postJson("http://localhost/x", { ...GOOD_TRIP, whatsapp: "0244123456" }) as never
    )
    const selected = mock.selectedColumns()
    expect(selected).not.toContain("whatsapp")
    expect(selected).not.toContain("matched_with_whatsapp")
    expect(selected).not.toBe("*")
  })
})

describe("the five things a Pioneer could set before this route existed", () => {
  /**
   * Each case sends one server-owned field alongside an otherwise valid body.
   * The schema is strict, so every one of them is a 400 with reason
   * forbidden_field, and nothing reaches the database.
   */
  const attacks: [string, Record<string, unknown>][] = [
    // 1. The sharpest: a tracking ID colliding with a real guest job shadows
    //    that delivery on the public tracker, because both trackers resolve
    //    listings before guest jobs. Invariant 3 from the Pioneer side.
    ["a tracking id, to shadow a guest delivery", { trackingId: "GYM-A1B2C3" }],
    ["a tracking id under its column name", { tracking_id: "GYM-A1B2C3" }],

    // 2. A row born matched to somebody else lands in their My Activity.
    ["a matched party, to plant a job on a victim", { matched_with_user_id: "pi-victim" }],
    ["a matched username", { matched_with_username: "victim_one" }],
    ["a matched phone, which the author would choose", { matched_with_whatsapp: "0244000000" }],

    // 3. The policy pins the id and says nothing about the display name.
    ["another Pioneer's username", { postedByUsername: "someone_else" }],
    ["another Pioneer's username under its column name", { posted_by_username: "someone_else" }],

    // 4. A listing born completed bypasses every transition guard.
    ["a status, to fabricate a completed delivery", { status: "completed" }],
    ["a status of in_transit", { status: "in_transit" }],

    // 5. The open feed orders by created_at descending.
    ["a future created_at, to pin itself to the top of the feed", { createdAt: "2099-01-01T00:00:00Z" }],
    ["a created_at under its column name", { created_at: "2099-01-01T00:00:00Z" }],

    // And the one the database policy already covered, refused here too so the
    // route does not depend on the policy to be correct.
    ["another Pioneer's uid", { postedById: "pi-victim" }],
    ["another Pioneer's uid under its column name", { posted_by_id: "pi-victim" }],

    // Anything else the server owns, including a column nobody has added yet.
    ["a completion attestation", { sender_confirmed: true }],
    ["its own primary key", { id: "listing_chosen_by_me" }],
  ]

  for (const [name, field] of attacks) {
    it(`refuses ${name}, and writes nothing`, async () => {
      queueSuccess()
      const res = await create.POST(
        postJson("http://localhost/x", {
          ...GOOD_TRIP,
          whatsapp: "0244123456",
          ...field,
        }) as never
      )
      expect(res.status).toBe(400)
      expect(await res.json()).toMatchObject({ ok: false, reason: "forbidden_field" })
      // The part that matters. A refusal that still inserts has closed nothing.
      expect(insertedRow()).toBeUndefined()
      expect(mock.calls).toHaveLength(0)
    })
  }

  // Refused, not ignored. The hardening brief asks for exactly this
  // distinction, and it is worth its own assertion: a route that dropped the
  // field silently would pass every test above except this one, because the
  // caller would be told their post succeeded while the field they sent
  // vanished.
  it("refuses rather than silently dropping, so a client learns it was wrong", async () => {
    queueSuccess()
    const res = await create.POST(
      postJson("http://localhost/x", {
        ...GOOD_TRIP,
        whatsapp: "0244123456",
        status: "completed",
      }) as never
    )
    expect(res.status).not.toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(body.reason).toBe("forbidden_field")
  })
})

describe("every refusal says why, server-side", () => {
  // On 13 September a Pioneer could not post a trip and the Vercel logs were
  // empty, because four of this route's refusals returned without logging: the
  // schema 400, the 401, id_generation_failed, and anything parseJsonBody
  // composed itself. An empty log read as "the request never arrived" when it
  // meant "refused, silently", and that cost a day of looking in the wrong
  // place.
  //
  // These assert the log line rather than the response, because the response
  // was never the part that was missing.

  function captureWarnings() {
    const lines: string[] = []
    const spy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "))
    })
    return { lines, restore: () => spy.mockRestore() }
  }

  it("logs a schema refusal, which is the one that was silent", async () => {
    const { lines, restore } = captureWarnings()
    try {
      // capacity out of range: the exact shape of the 13 September failure.
      const res = await create.POST(
        postJson("http://localhost/x", {
          ...GOOD_TRIP, whatsapp: "0244123456", capacity: "enormous",
        }) as never
      )
      expect(res.status).toBe(400)
      expect(await res.json()).toMatchObject({ reason: "bad_size" })
    } finally {
      restore()
    }
    expect(lines.join(" ")).toContain("bad_size")
  })

  it("logs an unauthorized refusal", async () => {
    mock.asAnonymousFailure()
    const { lines, restore } = captureWarnings()
    try {
      const res = await create.POST(
        postJson("http://localhost/x", { ...GOOD_TRIP, whatsapp: "0244123456" }) as never
      )
      expect(res.status).toBe(401)
    } finally {
      restore()
    }
    expect(lines.join(" ")).toContain("unauthorized")
  })

  it("logs an exhausted tracking id search, with how many attempts", async () => {
    for (let i = 0; i < 8; i++) {
      mock.queue({ data: { tracking_id: "GYM-TAKEN1" }, error: null }, { data: null, error: null })
    }
    const { lines, restore } = captureWarnings()
    try {
      const res = await create.POST(
        postJson("http://localhost/x", { ...GOOD_TRIP, whatsapp: "0244123456" }) as never
      )
      expect(res.status).toBe(500)
    } finally {
      restore()
    }
    expect(lines.join(" ")).toContain("id_generation_failed")
  })

  it("logs an insert failure with the database's own message", async () => {
    mock.queue(
      { data: null, error: null },
      { data: null, error: null },
      { data: null, error: { message: "permission denied for table listings" } }
    )
    const { lines, restore } = captureWarnings()
    try {
      const res = await create.POST(
        postJson("http://localhost/x", { ...GOOD_TRIP, whatsapp: "0244123456" }) as never
      )
      expect(res.status).toBe(500)
    } finally {
      restore()
    }
    const joined = lines.join(" ")
    expect(joined).toContain("insert_failed")
    // The Postgres message is the part that names a grant problem.
    expect(joined).toContain("permission denied")
  })

  it("accepts an envelope, which is what broke", async () => {
    queueSuccess()
    const res = await create.POST(
      postJson("http://localhost/x", {
        ...GOOD_TRIP, whatsapp: "0244123456", capacity: "envelope",
      }) as never
    )
    expect(res.status).toBe(200)
    const row = insertedRow()
    expect(row?.capacity).toBe("envelope")
  })
})

describe("the tracking id the server mints", () => {
  it("checks both rails before using one", async () => {
    queueSuccess()
    await create.POST(
      postJson("http://localhost/x", { ...GOOD_TRIP, whatsapp: "0244123456" }) as never
    )
    const tables = mock.calls.filter((c) => c.method === "from").map((c) => String(c.args[0]))
    // listings and guest_jobs both consulted before the insert. No database
    // constraint can span the two tables, so this check is the only thing that
    // keeps one ID pointing at one row across the rail boundary.
    expect(tables).toContain("listings")
    expect(tables).toContain("guest_jobs")
  })

  it("takes a different id when the first one is already taken on either rail", async () => {
    // First attempt: free on listings, TAKEN on guest_jobs. Second: free on both.
    mock.queue(
      { data: null, error: null },
      { data: { tracking_id: "GYM-TAKEN1" }, error: null },
      { data: null, error: null },
      { data: null, error: null },
      { data: { id: "l1", tracking_id: "GYM-FREE12" }, error: null }
    )
    const res = await create.POST(
      postJson("http://localhost/x", { ...GOOD_TRIP, whatsapp: "0244123456" }) as never
    )
    expect(res.status).toBe(200)
    // Four lookups, two per attempt, then the insert.
    const lookups = mock.calls.filter((c) => c.method === "maybeSingle")
    expect(lookups).toHaveLength(4)
  })

  it("gives up honestly rather than inserting a colliding id", async () => {
    // Every attempt collides on listings. Eight attempts, two lookups each.
    for (let i = 0; i < 8; i++) {
      mock.queue(
        { data: { tracking_id: "GYM-TAKEN1" }, error: null },
        { data: null, error: null }
      )
    }
    const res = await create.POST(
      postJson("http://localhost/x", { ...GOOD_TRIP, whatsapp: "0244123456" }) as never
    )
    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ reason: "id_generation_failed" })
    expect(insertedRow()).toBeUndefined()
  })
})

describe("the fields a Pioneer does own", () => {
  it("bounds the free text rather than storing whatever arrives", async () => {
    const res = await create.POST(
      postJson("http://localhost/x", {
        ...GOOD_TRIP,
        whatsapp: "0244123456",
        notes: "x".repeat(501),
      }) as never
    )
    expect(res.status).toBe(400)
    expect(insertedRow()).toBeUndefined()
  })

  it("refuses a price that is not a number a person typed", async () => {
    for (const pricePi of [-1, 10_001]) {
      mock.calls = []
      const res = await create.POST(
        postJson("http://localhost/x", { ...GOOD_TRIP, whatsapp: "0244123456", pricePi }) as never
      )
      expect(res.status, String(pricePi)).toBe(400)
      expect(insertedRow()).toBeUndefined()
    }
  })

  it("refuses a trip carrying package fields, and the other way round", async () => {
    const mixed = await create.POST(
      postJson("http://localhost/x", {
        ...GOOD_TRIP,
        whatsapp: "0244123456",
        deliverBy: "2026-10-05",
      }) as never
    )
    expect(mixed.status).toBe(400)
    expect(insertedRow()).toBeUndefined()
  })

  it("requires a usable phone number, since the poster's own is the contact", async () => {
    const res = await create.POST(
      postJson("http://localhost/x", { ...GOOD_TRIP, whatsapp: "123" }) as never
    )
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ reason: "invalid_phone" })
  })
})
