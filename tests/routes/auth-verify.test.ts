import { describe, it, expect, vi, beforeEach } from "vitest"
import { AdminMock, adminModule, postJson, get } from "../helpers/admin-mock"

const mock = new AdminMock()

vi.mock("@/lib/supabase-admin", () => adminModule(mock))
// waitUntil only exists inside a Vercel function context. In tests it is a
// pass-through so the observability writes neither run nor throw.
vi.mock("@vercel/functions", () => ({ waitUntil: (p: Promise<unknown>) => p }))
vi.mock("@/lib/pi-platform", () => ({
  verifyPiAccessToken: vi.fn(async (token: string) =>
    token === "good-pi-token" ? { uid: "pi-uid-1", username: "pioneer_one" } : null
  ),
}))

const { POST, GET } = await import("@/app/api/auth/verify/route")

describe("POST /api/auth/verify", () => {
  beforeEach(() => {
    mock.calls = []
    mock.results = []
  })

  it("rejects a body that is not JSON", async () => {
    const req = new Request("http://localhost/api/auth/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    })
    const res = await POST(req as never)
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ ok: false, reason: "MALFORMED_REQUEST" })
  })

  it("rejects a missing access token", async () => {
    const res = await POST(postJson("http://localhost/api/auth/verify", {}) as never)
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ ok: false, reason: "MISSING_TOKEN" })
  })

  it("rejects a token Pi Platform does not recognise", async () => {
    const res = await POST(
      postJson("http://localhost/api/auth/verify", { accessToken: "bad" }) as never
    )
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ ok: false, reason: "INVALID_TOKEN" })
  })

  it("issues a session for a verified Pi token", async () => {
    const res = await POST(
      postJson("http://localhost/api/auth/verify", { accessToken: "good-pi-token" }) as never
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.pioneer).toMatchObject({ pi_username: "pioneer_one" })
    expect(body.session.access_token).toBe("access-token-value")
  })

  it("answers GET with 405", async () => {
    const res = await GET()
    expect(res.status).toBe(405)
  })
})
