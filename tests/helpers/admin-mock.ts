import { vi } from "vitest"

// A stand-in for the Supabase service_role client that lib/supabase-admin
// hands to every route.
//
// The real client is a chainable query builder: .from(t).select(c).eq(a, b)
// and so on, ending either in .single() / .maybeSingle() or in awaiting the
// builder itself. This mock keeps that shape, records every call so a test can
// assert what a route asked the database for, and returns results a test
// queues up in advance.
//
// Deliberately dumb: it does not simulate Postgres, RLS, or grants, and no
// test here should be read as evidence about either live database. It exists
// so route logic (guards, status codes, what a payload does and does not
// contain) can be tested at all. The database side is verified separately,
// against catalog state, with docs/catalog-checks.sql.

export type QueryResult = { data: unknown; error: unknown }

export type ChainCall = { method: string; args: unknown[] }

export class AdminMock {
  /** Results returned, in order, by terminal calls (.single, .maybeSingle, await). */
  results: QueryResult[] = []
  /** Every builder call made since the mock was created, in order. */
  calls: ChainCall[] = []
  /** What admin.auth.getUser resolves to. */
  user: QueryResult = { data: null, error: { message: "no user configured" } }
  /** Results returned, in order, by .rpc(). */
  rpcResults: QueryResult[] = []

  queue(...results: QueryResult[]) {
    this.results.push(...results)
    return this
  }

  queueRpc(...results: QueryResult[]) {
    this.rpcResults.push(...results)
    return this
  }

  /**
   * Sign in as a Pioneer.
   *
   * The identity goes in app_metadata, which is where it lives now: only the
   * service_role key can write it, so a route reading it is reading something
   * the caller could not choose.
   *
   * user_metadata is populated too, with a DIFFERENT and deliberately
   * attacker-shaped uid, because user_metadata is writable by the user with
   * supabase.auth.updateUser. Any route that still reads it will act as
   * "pi-forged-by-the-user" and the assertions will say so by name. Do not
   * "fix" a test by making these two agree.
   */
  asPioneer(pi_uid = "pi-uid-1", pi_username = "pioneer_one") {
    this.user = {
      data: {
        user: {
          id: "sb-user-1",
          app_metadata: { pi_uid, pi_username },
          user_metadata: {
            pi_uid: "pi-forged-by-the-user",
            pi_username: "forged_by_the_user",
          },
        },
      },
      error: null,
    }
    return this
  }

  /**
   * A user who has written a Pi identity into their own user_metadata and has
   * nothing in app_metadata: an account that predates the backfill, or someone
   * who called updateUser and hoped. Every route must refuse this.
   */
  asForgedMetadataOnly(pi_uid = "pi-victim", pi_username = "victim_one") {
    this.user = {
      data: {
        user: {
          id: "sb-user-9",
          app_metadata: {},
          user_metadata: { pi_uid, pi_username },
        },
      },
      error: null,
    }
    return this
  }

  asAnonymousFailure() {
    this.user = { data: null, error: { message: "invalid token" } }
    return this
  }

  /** The chain call log as "method(arg, arg)" strings, for readable asserts. */
  trace(): string[] {
    return this.calls.map((c) => `${c.method}(${c.args.map((a) => JSON.stringify(a)).join(", ")})`)
  }

  /** Every column string passed to .select(), joined. Used to assert payload shape. */
  selectedColumns(): string {
    return this.calls
      .filter((c) => c.method === "select")
      .map((c) => String(c.args[0] ?? ""))
      .join(" ")
  }

  private nextResult(): QueryResult {
    return this.results.shift() ?? { data: null, error: null }
  }

  client() {
    const self = this
    const builder: Record<string, unknown> = {}

    const record = (method: string) =>
      (...args: unknown[]) => {
        self.calls.push({ method, args })
        return builder
      }

    for (const method of [
      "from", "select", "insert", "update", "delete", "upsert",
      "eq", "neq", "is", "in", "lt", "gt", "lte", "gte", "or", "order", "limit",
    ]) {
      builder[method] = record(method)
    }

    const terminal = (method: string) =>
      (...args: unknown[]) => {
        self.calls.push({ method, args })
        return Promise.resolve(self.nextResult())
      }

    builder.single = terminal("single")
    builder.maybeSingle = terminal("maybeSingle")

    // Awaiting the builder itself is a terminal too: `await admin.from(x)
    // .select(y).eq(...)` with no .single() is how the list reads are written.
    builder.then = (resolve: (v: QueryResult) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(self.nextResult()).then(resolve, reject)

    return {
      from: (table: string) => {
        self.calls.push({ method: "from", args: [table] })
        return builder
      },
      rpc: (name: string, params?: unknown) => {
        self.calls.push({ method: "rpc", args: [name, params] })
        return Promise.resolve(self.rpcResults.shift() ?? { data: null, error: null })
      },
      auth: {
        getUser: vi.fn(async (_token?: string) => self.user),
        admin: {
          listUsers: vi.fn(async () => ({ data: { users: [] }, error: null })),
          createUser: vi.fn(async () => ({ data: { user: { id: "sb-user-new" } }, error: null })),
        },
        signInWithPassword: vi.fn(async () => ({
          data: { session: { access_token: "at", refresh_token: "rt" } },
          error: null,
        })),
      },
    }
  }
}

/**
 * Build the module factory a test passes to vi.mock("@/lib/supabase-admin").
 * Every route imports createAdminClient from there and nothing else touches
 * the network.
 */
export function adminModule(mock: AdminMock) {
  return {
    createAdminClient: () => mock.client(),
    piUidToSyntheticEmail: (uid: string) => `pi-${uid}@gyema.local`,
    findOrCreatePioneerUser: vi.fn(async () => ({
      supabase_user_id: "sb-user-1",
      canonical_pi_uid: "pi-uid-1",
      created: false,
    })),
    generatePioneerSession: vi.fn(async () => ({
      access_token: "access-token-value",
      refresh_token: "refresh-token-value",
    })),
    // Records the app_metadata stamp so a test can assert it happened, and
    // happened before the session was minted.
    setPioneerAppMetadata: vi.fn(async (params: unknown) => {
      mock.calls.push({ method: "setPioneerAppMetadata", args: [params] })
    }),
    logAuthEvent: vi.fn(async () => undefined),
  }
}

/** A JSON POST Request for a route handler. */
export function postJson(url: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

/** A GET Request for a route handler. */
export function get(url: string): Request {
  return new Request(url, { method: "GET" })
}
