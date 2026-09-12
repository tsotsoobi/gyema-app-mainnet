import { describe, it, expect, vi, beforeEach } from "vitest"

// The limiter, tested without Upstash.
//
// @upstash/ratelimit is replaced with a class that records the options it was
// constructed with and answers limit() from whatever the test queued. That
// makes two things assertable that matter more than the arithmetic of a
// sliding window, which is Upstash's code and not ours: the key PREFIX each
// bucket is built with, and what happens when Redis does not answer.
//
// The prefix is the one that has to be right. One Upstash database serves both
// networks, so a prefix that did not separate them would let a Testnet flood
// exhaust a window a Mainnet sender needs, and nothing would look wrong from
// either side.

const limitMock = vi.fn()
const constructed: { prefix: string; limiter: unknown }[] = []

vi.mock("@upstash/redis", () => ({
  Redis: { fromEnv: () => ({ marker: "fake-redis" }) },
}))

vi.mock("@upstash/ratelimit", () => {
  class Ratelimit {
    static slidingWindow = (limit: number, window: string) => ({ kind: "sliding", limit, window })
    constructor(opts: { prefix: string; limiter: unknown }) {
      constructed.push({ prefix: opts.prefix, limiter: opts.limiter })
    }
    limit(identifier: string) {
      return limitMock(identifier)
    }
  }
  return { Ratelimit }
})

// x-real-ip is what Vercel Proxy sets and what the real helper reads.
vi.mock("@vercel/functions", () => ({
  ipAddress: (input: Request | { headers: Headers }) =>
    ("headers" in input ? input.headers : input).get("x-real-ip") ?? undefined,
}))

/** A fresh copy of the module, so the cached limiters do not outlive the env. */
async function freshModule() {
  vi.resetModules()
  constructed.length = 0
  return import("@/lib/rate-limit")
}

function configured() {
  vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://fake.upstash.io")
  vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "fake-token")
}

beforeEach(() => {
  vi.unstubAllEnvs()
  limitMock.mockReset()
})

describe("limiterConfigured", () => {
  it("is off when neither credential is set", async () => {
    const { limiterConfigured } = await freshModule()
    expect(limiterConfigured()).toBe(false)
  })

  it("is off when only one credential is set", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://fake.upstash.io")
    const { limiterConfigured } = await freshModule()
    expect(limiterConfigured()).toBe(false)
  })

  it("treats whitespace as unset, so a blank Vercel variable does not half-enable it", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "   ")
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "   ")
    const { limiterConfigured } = await freshModule()
    expect(limiterConfigured()).toBe(false)
  })

  it("is on with both", async () => {
    configured()
    const { limiterConfigured } = await freshModule()
    expect(limiterConfigured()).toBe(true)
  })
})

describe("networkNamespace", () => {
  it("names the network for a human and the Supabase ref for the guarantee", async () => {
    vi.stubEnv("NEXT_PUBLIC_IS_TESTNET", "true")
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://tttttttttttttttttttt.supabase.co")
    const { networkNamespace } = await freshModule()
    expect(networkNamespace()).toBe("gyema:testnet:tttttttttttttttttttt")
  })

  it("reads anything other than an exact \"true\" as mainnet", async () => {
    vi.stubEnv("NEXT_PUBLIC_IS_TESTNET", "TRUE")
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://mmmmmmmmmmmmmmmmmmmm.supabase.co")
    const { networkNamespace } = await freshModule()
    expect(networkNamespace()).toBe("gyema:mainnet:mmmmmmmmmmmmmmmmmmmm")
  })

  // The point of the whole file. Two deployments that BOTH forgot to set the
  // network flag still get different namespaces, because they cannot be
  // pointing at the same Supabase project.
  it("separates the networks even when the network flag is unset on both", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://tttttttttttttttttttt.supabase.co")
    const testnet = (await freshModule()).networkNamespace()

    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://mmmmmmmmmmmmmmmmmmmm.supabase.co")
    const mainnet = (await freshModule()).networkNamespace()

    expect(testnet).not.toBe(mainnet)
  })

  it("does not throw on a missing or unparseable Supabase URL", async () => {
    const { networkNamespace } = await freshModule()
    expect(networkNamespace()).toBe("gyema:mainnet:unconfigured")

    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "not a url")
    const again = await freshModule()
    expect(again.networkNamespace()).toBe("gyema:mainnet:unconfigured")
  })
})

describe("checkLimit", () => {
  it("allows everything when the limiter is not configured, without touching Redis", async () => {
    const { checkLimit } = await freshModule()
    const verdict = await checkLimit("guest_create_ip", "1.2.3.4")
    expect(verdict.ok).toBe(true)
    expect(limitMock).not.toHaveBeenCalled()
    expect(constructed).toHaveLength(0)
  })

  it("builds each bucket with the network namespace and the bucket name", async () => {
    configured()
    vi.stubEnv("NEXT_PUBLIC_IS_TESTNET", "true")
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://tttttttttttttttttttt.supabase.co")
    limitMock.mockResolvedValue({ success: true, reset: Date.now() + 1000 })

    const { checkLimit } = await freshModule()
    await checkLimit("guest_last4", "1.2.3.4")

    expect(constructed[0].prefix).toBe("gyema:testnet:tttttttttttttttttttt:guest_last4")
  })

  it("builds a bucket once and reuses it", async () => {
    configured()
    limitMock.mockResolvedValue({ success: true, reset: Date.now() + 1000 })
    const { checkLimit } = await freshModule()

    await checkLimit("guest_track", "1.2.3.4")
    await checkLimit("guest_track", "5.6.7.8")

    expect(constructed).toHaveLength(1)
    expect(limitMock).toHaveBeenCalledTimes(2)
  })

  it("refuses when the window is full and says how long to wait", async () => {
    configured()
    limitMock.mockResolvedValue({ success: false, reset: Date.now() + 42_000 })
    const { checkLimit } = await freshModule()

    const verdict = await checkLimit("guest_create_ip", "1.2.3.4")
    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.reason).toBe("rate_limited")
    expect(verdict.retryAfterSeconds).toBeGreaterThan(40)
    expect(verdict.retryAfterSeconds).toBeLessThanOrEqual(42)
  })

  it("never reports a retry of zero seconds, which would invite an instant retry", async () => {
    configured()
    limitMock.mockResolvedValue({ success: false, reset: Date.now() - 5000 })
    const { checkLimit } = await freshModule()

    const verdict = await checkLimit("guest_create_ip", "1.2.3.4")
    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.retryAfterSeconds).toBe(1)
  })

  // The two halves of the founder's question: which paths close and which open.
  it("FAILS CLOSED on a Redis error for the guest write path", async () => {
    configured()
    limitMock.mockRejectedValue(new Error("upstash unreachable"))
    const { checkLimit } = await freshModule()

    for (const bucket of ["guest_create_ip", "guest_create_phone"] as const) {
      const verdict = await checkLimit(bucket, "someone")
      expect(verdict.ok).toBe(false)
      if (verdict.ok) return
      expect(verdict.reason).toBe("limiter_unavailable")
    }
  })

  it("FAILS OPEN on a Redis error for sign-in, the tracker, the board and the last-4 handshake", async () => {
    configured()
    limitMock.mockRejectedValue(new Error("upstash unreachable"))
    const { checkLimit } = await freshModule()

    for (const bucket of ["auth_verify", "guest_track", "guest_open", "guest_last4"] as const) {
      const verdict = await checkLimit(bucket, "someone")
      expect(verdict.ok).toBe(true)
    }
  })

  it("treats a hung Redis as an error rather than waiting on it", async () => {
    configured()
    // Never settles. The module's own timeout has to be what ends this.
    limitMock.mockImplementation(() => new Promise(() => {}))
    const { checkLimit } = await freshModule()

    const started = Date.now()
    const verdict = await checkLimit("auth_verify", "1.2.3.4")
    expect(verdict.ok).toBe(true)
    expect(Date.now() - started).toBeLessThan(2000)
  })
})

describe("ipIdentifier", () => {
  it("reads the address Vercel Proxy set", async () => {
    const { ipIdentifier } = await freshModule()
    const req = new Request("http://localhost/x", { headers: { "x-real-ip": "41.66.1.9" } })
    expect(ipIdentifier(req)).toBe("41.66.1.9")
  })

  it("prefers the proxy header over a forwarded list a caller can write", async () => {
    const { ipIdentifier } = await freshModule()
    const req = new Request("http://localhost/x", {
      headers: { "x-real-ip": "41.66.1.9", "x-forwarded-for": "9.9.9.9, 41.66.1.9" },
    })
    expect(ipIdentifier(req)).toBe("41.66.1.9")
  })

  it("falls back to the first forwarded entry when nothing set the proxy header", async () => {
    const { ipIdentifier } = await freshModule()
    const req = new Request("http://localhost/x", {
      headers: { "x-forwarded-for": " 41.66.1.9 , 10.0.0.1" },
    })
    expect(ipIdentifier(req)).toBe("41.66.1.9")
  })

  it("puts everything with no address in one shared bucket rather than an unlimited one", async () => {
    const { ipIdentifier } = await freshModule()
    expect(ipIdentifier(new Request("http://localhost/x"))).toBe("noip")
  })
})

describe("phoneIdentifier", () => {
  it("is not the phone number", async () => {
    const { phoneIdentifier } = await freshModule()
    const id = phoneIdentifier("0244123456")
    expect(id).not.toContain("244123456")
    expect(id).toMatch(/^[0-9a-f]{16}$/)
  })

  it("gives one budget to one person however they typed their number", async () => {
    const { phoneIdentifier } = await freshModule()
    const forms = ["0244123456", "+233244123456", "233 244 123 456", "(024) 412-3456"]
    const ids = new Set(forms.map(phoneIdentifier))
    expect(ids.size).toBe(1)
  })

  it("gives different people different budgets", async () => {
    const { phoneIdentifier } = await freshModule()
    expect(phoneIdentifier("0244123456")).not.toBe(phoneIdentifier("0244123457"))
  })
})

describe("LIMITS", () => {
  it("has a window and a failure mode on every bucket, and only the guest write closes", async () => {
    const { LIMITS } = await freshModule()
    const closed = Object.entries(LIMITS)
      .filter(([, spec]) => spec.onError === "closed")
      .map(([name]) => name)
      .sort()
    expect(closed).toEqual(["guest_create_ip", "guest_create_phone"])

    for (const spec of Object.values(LIMITS)) {
      expect(spec.limit).toBeGreaterThan(0)
      expect(spec.window).toMatch(/^\d+ [smhd]$/)
    }
  })

  // Not arithmetic for its own sake: the per-person key is the one that has to
  // bite, and the per-address key is the one that must not, because a shared
  // carrier address in Accra stands for many senders.
  it("keeps the per-address guest limit looser than the per-person one", async () => {
    const { LIMITS } = await freshModule()
    expect(LIMITS.guest_create_ip.limit).toBeGreaterThan(LIMITS.guest_create_phone.limit)
  })
})
