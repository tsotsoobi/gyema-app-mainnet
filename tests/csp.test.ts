import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { NextRequest } from "next/server"
import { readFileSync } from "node:fs"
import { buildCsp, cspHeaderName, cspIsEnforcing } from "@/lib/csp"
import { middleware } from "@/middleware"

// Phase 4, the risky half. A CSP that is wrong about the Pi SDK does not
// degrade the app, it stops sign-in and payment.

const NONCE = "dGVzdC1ub25jZS12YWx1ZQ=="

function directives(policy: string): Map<string, string> {
  return new Map(
    policy.split(";").map((part) => {
      const [name, ...rest] = part.trim().split(/\s+/)
      return [name, rest.join(" ")]
    })
  )
}

describe("what the policy allows", () => {
  const d = directives(buildCsp(NONCE))

  it("lets the Pi SDK load, connect and open its own frame", () => {
    // Each of these is a thing that stops sign-in or payment if it is missing,
    // rather than a thing that makes the page look wrong.
    expect(d.get("script-src")).toContain("https://sdk.minepi.com")
    expect(d.get("connect-src")).toContain("https://api.minepi.com")
    expect(d.get("frame-src")).toContain("https://sdk.minepi.com")
  })

  it("lets the app reach Supabase over https and websockets", () => {
    // The realtime client opens a socket even where the app does not use it.
    expect(d.get("connect-src")).toContain("https://*.supabase.co")
    expect(d.get("connect-src")).toContain("wss://*.supabase.co")
  })

  it("keeps the Pi Browser proxy as a framing ancestor", () => {
    expect(d.get("frame-ancestors")).toContain("https://*.pinet.com")
    expect(d.get("frame-ancestors")).toContain("'self'")
  })

  it("carries the nonce and neither unsafe-inline nor unsafe-eval for scripts", () => {
    const scriptSrc = d.get("script-src") ?? ""
    expect(scriptSrc).toContain(`'nonce-${NONCE}'`)
    expect(scriptSrc).not.toContain("'unsafe-inline'")
    expect(scriptSrc).not.toContain("'unsafe-eval'")
  })

  it("locks the cheap half: no plugins, no base rewrite, no cross-origin form post", () => {
    expect(d.get("object-src")).toBe("'none'")
    expect(d.get("base-uri")).toBe("'self'")
    expect(d.get("form-action")).toBe("'self'")
    expect(d.get("default-src")).toBe("'self'")
  })

  it("allows inline style deliberately, and says so", () => {
    // The layout injects a style block for the font variables and Tailwind
    // writes inline styles at runtime. Inline style is a defacement risk, not
    // a code execution one, and frame-ancestors and base-uri close the routes
    // that would turn it into one.
    expect(d.get("style-src")).toContain("'unsafe-inline'")
    expect(readFileSync("lib/csp.ts", "utf8")).toContain("is not an oversight")
  })
})

describe("report-only by default", () => {
  it("reports rather than blocks unless CSP_ENFORCE is exactly true", () => {
    for (const value of [undefined, "", "false", "1", "yes", "TRUE"]) {
      expect(cspHeaderName(value), String(value)).toBe("Content-Security-Policy-Report-Only")
      expect(cspIsEnforcing(value)).toBe(false)
    }
  })

  it("blocks when CSP_ENFORCE is true", () => {
    expect(cspHeaderName("true")).toBe("Content-Security-Policy")
    expect(cspIsEnforcing("true")).toBe(true)
  })
})

describe("the middleware", () => {
  function request(url = "https://gyema3681.pinet.com/") {
    return new NextRequest(
      new Request(url, { headers: { "x-forwarded-proto": "https", host: "gyema3681.pinet.com" } })
    )
  }

  beforeEach(() => {
    vi.unstubAllEnvs()
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("sends the report-only header when the flag is unset", () => {
    const res = middleware(request())
    expect(res.headers.get("Content-Security-Policy-Report-Only")).toBeTruthy()
    expect(res.headers.get("Content-Security-Policy")).toBeNull()
  })

  it("sends the enforcing header when CSP_ENFORCE is true", () => {
    vi.stubEnv("CSP_ENFORCE", "true")
    const res = middleware(request())
    expect(res.headers.get("Content-Security-Policy")).toBeTruthy()
    expect(res.headers.get("Content-Security-Policy-Report-Only")).toBeNull()
  })

  it("mints a fresh nonce per request and puts the same one in both places", () => {
    const first = middleware(request())
    const second = middleware(request())
    const a = first.headers.get("x-nonce")
    const b = second.headers.get("x-nonce")
    expect(a).toBeTruthy()
    expect(a).not.toBe(b)
    // The policy names the nonce the page will carry.
    const policy = first.headers.get("Content-Security-Policy-Report-Only") ?? ""
    expect(policy).toContain(`'nonce-${a}'`)
  })

  it("sets no CSP on a redirect, which carries no page to protect", () => {
    const res = middleware(
      new NextRequest(
        new Request("http://gyema3681.pinet.com/", {
          headers: { "x-forwarded-proto": "http", host: "gyema3681.pinet.com" },
        })
      )
    )
    expect(res.status).toBe(308)
  })
})

describe("the prerender trap", () => {
  // A statically prerendered page cannot carry a per-request nonce: the header
  // names one, no tag on the page has it, and every script is blocked
  // including the Pi SDK. Three of the four pages that load the SDK were
  // prerendered before this commit.
  const layout = readFileSync("app/layout.tsx", "utf8")

  it("the layout that loads the Pi SDK renders per request", () => {
    expect(layout).toContain('export const dynamic = "force-dynamic"')
  })

  it("both script tags in it carry the nonce", () => {
    expect(layout).toContain("nonce={nonce}")
    // The SDK tag and the inline pi-init tag: two, not one.
    expect(layout.match(/nonce=\{nonce\}/g) ?? []).toHaveLength(2)
  })

  it("the nonce comes from the request headers middleware set", () => {
    expect(layout).toContain('headers()).get("x-nonce")')
  })

  it("says what removing the dynamic line would require", () => {
    // Removing it silently returns the app to prerendering, where the nonce
    // stops matching and the SDK stops loading.
    expect(layout).toContain("Do not remove it on its own")
  })
})
