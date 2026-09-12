import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { isTurnstileConfigured, verifyTurnstileToken } from "@/lib/turnstile"

// Turnstile, tested against a stubbed siteverify.
//
// The two halves behave in deliberately opposite directions and both are
// asserted here, because getting either backwards is a silent failure rather
// than a visible one:
//
//   CONFIGURATION fails open. No keys means no check, so a deployment that was
//   never given them keeps working instead of refusing every guest post.
//
//   VERIFICATION fails closed. Once an operator has set both keys they have
//   said the check must run, and an unreachable Cloudflare is not permission
//   to skip it.

const originalFetch = globalThis.fetch

function stubSiteverify(response: unknown, init?: { status?: number }) {
  const fetchMock = vi.fn(async () =>
    new Response(JSON.stringify(response), {
      status: init?.status ?? 200,
      headers: { "content-type": "application/json" },
    })
  )
  globalThis.fetch = fetchMock as unknown as typeof fetch
  return fetchMock
}

beforeEach(() => {
  vi.unstubAllEnvs()
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("isTurnstileConfigured", () => {
  it("is off with neither key", () => {
    expect(isTurnstileConfigured()).toBe(false)
  })

  // A site key with no secret renders a widget whose token nothing checks,
  // which looks like a control and is not one. A secret with no site key
  // refuses every post, because no client can produce a token.
  it("is off with only the site key", () => {
    vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "site")
    expect(isTurnstileConfigured()).toBe(false)
  })

  it("is off with only the secret", () => {
    vi.stubEnv("TURNSTILE_SECRET_KEY", "secret")
    expect(isTurnstileConfigured()).toBe(false)
  })

  it("treats a blank Vercel variable as unset", () => {
    vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "  ")
    vi.stubEnv("TURNSTILE_SECRET_KEY", "  ")
    expect(isTurnstileConfigured()).toBe(false)
  })

  it("is on with both", () => {
    vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "site")
    vi.stubEnv("TURNSTILE_SECRET_KEY", "secret")
    expect(isTurnstileConfigured()).toBe(true)
  })
})

describe("verifyTurnstileToken", () => {
  beforeEach(() => {
    vi.stubEnv("TURNSTILE_SECRET_KEY", "secret")
  })

  it("accepts a token Cloudflare says is good", async () => {
    stubSiteverify({ success: true })
    await expect(verifyTurnstileToken("a-token")).resolves.toEqual({ ok: true })
  })

  it("refuses a missing or blank token without calling out", async () => {
    const fetchMock = stubSiteverify({ success: true })
    await expect(verifyTurnstileToken(null)).resolves.toMatchObject({ reason: "missing_token" })
    await expect(verifyTurnstileToken("   ")).resolves.toMatchObject({ reason: "missing_token" })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("refuses a token Cloudflare rejects, which is what stops a replay", async () => {
    stubSiteverify({ success: false, "error-codes": ["timeout-or-duplicate"] })
    await expect(verifyTurnstileToken("a-replayed-token")).resolves.toMatchObject({
      reason: "rejected",
    })
  })

  it("FAILS CLOSED when siteverify errors", async () => {
    stubSiteverify({}, { status: 502 })
    await expect(verifyTurnstileToken("a-token")).resolves.toMatchObject({
      reason: "unavailable",
    })
  })

  it("FAILS CLOSED when siteverify cannot be reached at all", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("network down")
    }) as unknown as typeof fetch
    await expect(verifyTurnstileToken("a-token")).resolves.toMatchObject({
      reason: "unavailable",
    })
  })

  it("refuses rather than allowing when the secret is missing", async () => {
    vi.stubEnv("TURNSTILE_SECRET_KEY", "")
    const fetchMock = stubSiteverify({ success: true })
    await expect(verifyTurnstileToken("a-token")).resolves.toMatchObject({
      reason: "unavailable",
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("sends the secret and the token as a form post, and never in the URL", async () => {
    const fetchMock = stubSiteverify({ success: true })
    await verifyTurnstileToken("a-token", "41.66.1.9")

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify")
    expect(url).not.toContain("secret")
    expect(init.method).toBe("POST")

    const body = init.body as URLSearchParams
    expect(body.get("secret")).toBe("secret")
    expect(body.get("response")).toBe("a-token")
    expect(body.get("remoteip")).toBe("41.66.1.9")
  })

  it("omits remoteip rather than sending the no-address placeholder", async () => {
    const fetchMock = stubSiteverify({ success: true })
    await verifyTurnstileToken("a-token", "noip")

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect((init.body as URLSearchParams).has("remoteip")).toBe(false)
  })
})
