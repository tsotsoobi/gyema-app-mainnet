import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// findAuthUserByEmail, which replaced a single page of 1000 users.
//
// The old lookup was correct until the project passed 1000 users and silently
// wrong afterwards: a Pioneer outside the first page was invisible, so the
// caller concluded they did not exist, called createUser for an email already
// taken, and answered the sign in with PROVISIONING_ERROR. Testnet was at 2689
// users when this was found, so the bug was live.

vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project.supabase.co")
vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-key-for-tests")

const { findAuthUserByEmail } = await import("@/lib/supabase-admin")

const EMAIL = "pi-abc@gyema.local"

/** A listUsers stub over a fixed set of users, paging at `perPage`. */
function pagedAdmin(emails: string[], opts: { pageSize?: number } = {}) {
  const calls: Array<{ page: number; perPage: number }> = []
  const admin = {
    auth: {
      admin: {
        listUsers: vi.fn(async ({ page, perPage }: { page: number; perPage: number }) => {
          calls.push({ page, perPage })
          const start = (page - 1) * perPage
          const slice = emails.slice(start, start + perPage)
          return {
            data: { users: slice.map((email, i) => ({ id: `id-${start + i}`, email })) },
            error: null,
          }
        }),
      },
    },
  }
  return { admin: admin as never, calls, pageSize: opts.pageSize }
}

/** A fetch stub for GoTrue's filtered admin lookup. */
function filterFetch(users: Array<{ id: string; email: string }>, status = 200) {
  return vi.fn(async (url: string | URL) => {
    void url
    return new Response(JSON.stringify({ users }), { status })
  })
}

beforeEach(() => {
  vi.unstubAllGlobals()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe("the direct lookup", () => {
  it("asks GoTrue for the address and does not scan when it answers", async () => {
    const fetchSpy = filterFetch([{ id: "id-exact", email: EMAIL }])
    vi.stubGlobal("fetch", fetchSpy)
    const { admin, calls } = pagedAdmin([])

    const found = await findAuthUserByEmail(admin, EMAIL)

    expect(found).toEqual({ id: "id-exact" })
    expect(calls).toHaveLength(0)
    const url = String(fetchSpy.mock.calls[0][0])
    expect(url).toContain("/auth/v1/admin/users")
    expect(url).toContain(encodeURIComponent(EMAIL))
  })

  it("does not accept a partial match, because filter is a partial match", async () => {
    // A filter for pi-abc@gyema.local matches pi-abcd@gyema.local too. Taking
    // that would sign one Pioneer in as another.
    const fetchSpy = filterFetch([
      { id: "id-wrong", email: "pi-abcd@gyema.local" },
      { id: "id-also-wrong", email: "pi-abcde@gyema.local" },
    ])
    vi.stubGlobal("fetch", fetchSpy)
    const { admin } = pagedAdmin(["pi-abcd@gyema.local"])

    // Nothing exact in the filter result, nothing exact in the scan either.
    expect(await findAuthUserByEmail(admin, EMAIL)).toBeNull()
  })

  it("matches regardless of case", async () => {
    vi.stubGlobal("fetch", filterFetch([{ id: "id-exact", email: "PI-ABC@GYEMA.LOCAL" }]))
    const { admin } = pagedAdmin([])
    expect(await findAuthUserByEmail(admin, EMAIL)).toEqual({ id: "id-exact" })
  })
})

describe("the paged fallback", () => {
  it("pages past the old 1000 user cliff", async () => {
    // 2689 users, the Testnet count on the day this was found, with the target
    // sitting where a single page of 1000 would never have looked.
    const emails = Array.from({ length: 2689 }, (_, i) => `pi-user${i}@gyema.local`)
    emails[2500] = EMAIL
    vi.stubGlobal("fetch", filterFetch([], 500)) // filtered lookup unavailable
    const { admin, calls } = pagedAdmin(emails)

    const found = await findAuthUserByEmail(admin, EMAIL)

    expect(found).toEqual({ id: "id-2500" })
    // It kept going past page 1, which is the whole point.
    expect(calls.length).toBeGreaterThan(1)
    expect(calls[0]).toEqual({ page: 1, perPage: 200 })
  })

  it("stops at a short page and reports absence", async () => {
    const emails = Array.from({ length: 450 }, (_, i) => `pi-user${i}@gyema.local`)
    vi.stubGlobal("fetch", filterFetch([], 500))
    const { admin, calls } = pagedAdmin(emails)

    expect(await findAuthUserByEmail(admin, EMAIL)).toBeNull()
    // 200, 200, 50: three pages, and it stopped on the short one.
    expect(calls.map((c) => c.page)).toEqual([1, 2, 3])
  })

  it("runs when the filtered lookup finds nothing, since an older GoTrue may ignore the parameter", async () => {
    const emails = Array.from({ length: 300 }, (_, i) => `pi-user${i}@gyema.local`)
    emails[250] = EMAIL
    vi.stubGlobal("fetch", filterFetch([])) // 200 OK, empty result
    const { admin, calls } = pagedAdmin(emails)

    expect(await findAuthUserByEmail(admin, EMAIL)).toEqual({ id: "id-250" })
    expect(calls.length).toBeGreaterThan(0)
  })

  it("throws rather than reporting absence when the scan itself fails", async () => {
    // "Cannot tell" and "not there" must not answer the same way: the caller's
    // next move on null is to create the user.
    vi.stubGlobal("fetch", filterFetch([], 500))
    const admin = {
      auth: {
        admin: {
          listUsers: vi.fn(async () => ({ data: null, error: { message: "upstream down" } })),
        },
      },
    }
    await expect(findAuthUserByEmail(admin as never, EMAIL)).rejects.toThrow(/listUsers failed/)
  })

  it("cannot loop forever", async () => {
    // A list that never returns a short page, which should not be possible and
    // must not spin on a sign in path if it ever is.
    vi.stubGlobal("fetch", filterFetch([], 500))
    let pages = 0
    const admin = {
      auth: {
        admin: {
          listUsers: vi.fn(async () => {
            pages += 1
            return {
              data: { users: Array.from({ length: 200 }, (_, i) => ({ id: `x${i}`, email: "other@x" })) },
              error: null,
            }
          }),
        },
      },
    }
    await expect(findAuthUserByEmail(admin as never, EMAIL)).rejects.toThrow(/page limit/)
    expect(pages).toBe(100)
  })
})

describe("the module", () => {
  it("has no single page scan left in it", async () => {
    const { readFileSync } = await import("node:fs")
    const source = readFileSync("lib/supabase-admin.ts", "utf8")
      .split(/\r?\n/)
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .join("\n")
    expect(source).not.toContain("perPage: 1000")
    expect(source).not.toContain("page: 1, perPage")
  })
})
