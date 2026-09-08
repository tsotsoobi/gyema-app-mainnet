import { describe, it, expect, beforeEach, vi } from "vitest"

// S-9. The Supabase session tokens were carefully kept in memory only, and the
// Pi accessToken was written to localStorage. That token is a live credential
// which /api/auth/verify exchanges for a full Supabase session, so the thing
// that mints the session was sitting in the place the session was kept out of.

const store = new Map<string, string>()
const localStorageMock = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
}

vi.stubGlobal("localStorage", localStorageMock)
vi.stubGlobal("window", { localStorage: localStorageMock, location: { hostname: "localhost" } })

const { setStoredUser, getStoredUser, clearStoredAuth, getSupabaseSession, setSupabaseSession } =
  await import("@/lib/pi-network")

beforeEach(() => {
  store.clear()
  setSupabaseSession(null)
})

describe("what reaches localStorage", () => {
  it("stores a uid and a username and nothing else", () => {
    setStoredUser({
      uid: "pi-uid-1",
      username: "pioneer_one",
      accessToken: "pi-access-token-value",
      supabaseAccessToken: "supabase-access-token-value",
      supabaseRefreshToken: "supabase-refresh-token-value",
      supabaseUserId: "sb-user-1",
    })
    const raw = store.get("gyema-user") ?? ""
    expect(JSON.parse(raw)).toEqual({ uid: "pi-uid-1", username: "pioneer_one" })
  })

  it("no token of any kind appears in the stored value", () => {
    setStoredUser({
      uid: "pi-uid-1",
      username: "pioneer_one",
      accessToken: "pi-access-token-value",
      supabaseAccessToken: "supabase-access-token-value",
      supabaseRefreshToken: "supabase-refresh-token-value",
    })
    const raw = store.get("gyema-user") ?? ""
    expect(raw).not.toContain("pi-access-token-value")
    expect(raw).not.toContain("supabase-access-token-value")
    expect(raw).not.toContain("supabase-refresh-token-value")
    expect(raw).not.toContain("accessToken")
  })

  it("a token left by an older version is dropped on read, not returned", () => {
    // What the previous version wrote.
    store.set(
      "gyema-user",
      JSON.stringify({
        uid: "pi-uid-1",
        username: "pioneer_one",
        accessToken: "pi-access-token-left-behind",
      })
    )
    const user = getStoredUser()
    expect(user?.uid).toBe("pi-uid-1")
    expect(user?.accessToken).toBe("")
  })

  it("the Supabase session lives in memory and is cleared on sign out", () => {
    setSupabaseSession({ accessToken: "at", refreshToken: "rt" })
    expect(getSupabaseSession()?.accessToken).toBe("at")
    clearStoredAuth()
    expect(getSupabaseSession()).toBeNull()
    expect(store.get("gyema-user")).toBeUndefined()
  })
})

describe("the module's source", () => {
  it("persists no token anywhere", async () => {
    const { readFileSync } = await import("node:fs")
    const source = readFileSync("lib/pi-network.ts", "utf8")
      .split(/\r?\n/)
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .join("\n")
    // The only setItem calls left are the role and the user object above.
    const setItems = source.match(/localStorage\.setItem\(([^,]+),/g) ?? []
    expect(setItems.every((c) => c.includes("ROLE_KEY") || c.includes("USER_KEY"))).toBe(true)
    expect(source).not.toContain("accessToken: user.accessToken")
  })
})
