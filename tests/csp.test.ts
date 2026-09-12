import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { NextRequest } from "next/server"
import { readFileSync } from "node:fs"
import {
  buildCsp,
  cspHeaderName,
  cspIsEnforcing,
  PI_CONNECT_ORIGINS,
  PI_FRAME_ANCESTORS,
} from "@/lib/csp"
import { middleware } from "@/middleware"

// Phase 4, the risky half. A CSP that is wrong about the Pi SDK does not
// degrade the app, it stops sign-in: enforcing the first version on Testnet
// produced "Sign-in cancelled or failed", which is a rejected Pi.authenticate.
//
// The origins below are not guesses. They were read out of
// https://sdk.minepi.com/pi-sdk.js: app-cdn.minepi.com is the default host
// platform from getHostPlatformURL(), the two piappengine.com hosts are the
// App Studio alternatives, and rpc.testnet.minepi.com and sandbox.minepi.com
// appear as request targets. See lib/csp.ts for the full account.

const NONCE = "dGVzdC1ub25jZS12YWx1ZQ=="

function directives(policy: string): Map<string, string> {
  return new Map(
    policy.split(";").map((part) => {
      const [name, ...rest] = part.trim().split(/\s+/)
      return [name, rest.join(" ")]
    })
  )
}

const d = directives(buildCsp(NONCE))

/**
 * A CSP host source with a wildcard label matches a subdomain and NOT the
 * apex: https://*.minepi.com does not admit https://minepi.com. Anywhere the
 * apex matters it has to be listed too, and forgetting that is how a policy
 * blocks the origin somebody told you the auth flow was on.
 */
function admits(directive: string, origin: string): boolean {
  const sources = (d.get(directive) ?? "").split(/\s+/)
  if (sources.includes(origin)) return true
  const host = origin.replace(/^https?:\/\//, "")
  return sources.some((source) => {
    if (!source.startsWith("https://*.")) return false
    const suffix = source.slice("https://*.".length)
    // A wildcard matches a.b.suffix and b.suffix, never suffix itself.
    return host.endsWith(`.${suffix}`)
  })
}

describe("every origin the SDK names in its own source", () => {
  // Each of these was read out of the SDK bundle. If a later SDK adds one,
  // this list is where it goes, and the wildcard entries in lib/csp.ts are
  // there so a new subdomain is not a fresh outage.
  const sdkOrigins = [
    "https://sdk.minepi.com",
    "https://api.minepi.com",
    "https://app-cdn.minepi.com",
    "https://rpc.testnet.minepi.com",
    "https://sandbox.minepi.com",
    "https://appstudio-u7cm9zhmha0ruwv8.piappengine.com",
    "https://appstudio-pobr34hy4r0qmyuu.staging.piappengine.com",
  ]

  for (const origin of sdkOrigins) {
    it(`connect-src admits ${origin}`, () => {
      // This is the directive a desktop pass cannot exercise: the SDK only
      // calls these once a real Pi.authenticate is under way, and on desktop
      // window.Pi is missing so it throws first.
      expect(admits("connect-src", origin), origin).toBe(true)
    })
  }

  it("connect-src admits the minepi.com apex, which the wildcard does not", () => {
    expect((d.get("connect-src") ?? "")).toContain("https://minepi.com")
  })

  it("connect-src still admits Supabase over https and websockets", () => {
    expect(admits("connect-src", "https://abcdefgh.supabase.co")).toBe(true)
    expect((d.get("connect-src") ?? "")).toContain("wss://*.supabase.co")
  })

  it("script-src admits the SDK bundle and the host platform", () => {
    expect(admits("script-src", "https://sdk.minepi.com")).toBe(true)
    expect(admits("script-src", "https://app-cdn.minepi.com")).toBe(true)
  })
})

describe("who may frame this app", () => {
  // The other directive a desktop pass cannot exercise: frame-ancestors only
  // applies when the page IS framed, and on desktop it is not. In Pi Browser
  // it always is.
  const parents = [
    "https://gyema3681.pinet.com",
    "https://app-cdn.minepi.com",
    "https://appstudio-u7cm9zhmha0ruwv8.piappengine.com",
  ]

  for (const parent of parents) {
    it(`frame-ancestors admits ${parent}`, () => {
      expect(admits("frame-ancestors", parent), parent).toBe(true)
    })
  }

  it("names both apexes explicitly, since a wildcard does not reach them", () => {
    const fa = d.get("frame-ancestors") ?? ""
    expect(fa).toContain("https://minepi.com")
    expect(fa).toContain("https://pinet.com")
    expect(fa).toContain("'self'")
  })

  it("does not admit an unrelated origin", () => {
    expect(admits("frame-ancestors", "https://evil.example.com")).toBe(false)
    expect(admits("connect-src", "https://evil.example.com")).toBe(false)
  })

  it("does not admit a lookalike domain", () => {
    // minepi.com.evil.example and notminepi.com must both fail.
    expect(admits("frame-ancestors", "https://minepi.com.evil.example")).toBe(false)
    expect(admits("connect-src", "https://notminepi.com")).toBe(false)
  })
})

describe("the directives the SDK source ruled out as the cause", () => {
  it("frame-src and child-src agree, for engines that read only one", () => {
    // The SDK creates no iframe: the only "iframe" string in the bundle is a
    // key in a DOM attribute table, and it talks through
    // window.parent.postMessage, which no directive governs. These are here
    // for a future version rather than for today's flow.
    expect(d.get("frame-src")).toBe(d.get("child-src"))
    expect(admits("frame-src", "https://app-cdn.minepi.com")).toBe(true)
  })

  it("form-action is widened to the Pi origins rather than left at self", () => {
    // Nothing submits a cross-origin form today, but this is the third
    // directive a desktop pass cannot exercise, and narrow guesses are what
    // broke sign-in.
    expect(admits("form-action", "https://app-cdn.minepi.com")).toBe(true)
    expect((d.get("form-action") ?? "")).toContain("'self'")
  })
})

describe("Cloudflare Turnstile", () => {
  const TURNSTILE = "https://challenges.cloudflare.com"

  // One origin, four directives, and the widget silently never appears if any
  // one of them is missing. The loader is a script, the challenge renders in an
  // iframe from the same host, and the widget calls back to it.
  for (const directive of ["script-src", "frame-src", "child-src", "connect-src"]) {
    it(`${directive} admits the Turnstile origin`, () => {
      expect(admits(directive, TURNSTILE)).toBe(true)
    })
  }

  // The policy is built per request in middleware and the site key is a
  // build-time bake, so a conditional origin would mean a redeploy changed the
  // header and the widget in two steps rather than one.
  it("names the origin whether or not Turnstile is configured", () => {
    vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "")
    expect(buildCsp(NONCE)).toContain(TURNSTILE)
  })

  it("does not admit a lookalike of the Turnstile origin", () => {
    expect(admits("script-src", "https://challenges.cloudflare.com.evil.test")).toBe(false)
  })
})

describe("what stays locked", () => {
  it("keeps the nonce and refuses unsafe-inline and unsafe-eval for scripts", () => {
    const scriptSrc = d.get("script-src") ?? ""
    expect(scriptSrc).toContain(`'nonce-${NONCE}'`)
    expect(scriptSrc).not.toContain("'unsafe-inline'")
    expect(scriptSrc).not.toContain("'unsafe-eval'")
  })

  it("keeps the cheap half: no plugins, no base rewrite, default self", () => {
    expect(d.get("object-src")).toBe("'none'")
    expect(d.get("base-uri")).toBe("'self'")
    expect(d.get("default-src")).toBe("'self'")
  })

  it("allows inline style deliberately, and says so", () => {
    expect(d.get("style-src")).toContain("'unsafe-inline'")
    expect(readFileSync("lib/csp.ts", "utf8")).toContain("is not an oversight")
  })

  it("exports the origin lists so they are asserted, not buried in a string", () => {
    expect(PI_CONNECT_ORIGINS.length).toBeGreaterThan(4)
    expect(PI_FRAME_ANCESTORS).toContain("'self'")
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
  const layout = readFileSync("app/layout.tsx", "utf8")

  it("the layout that loads the Pi SDK renders per request", () => {
    expect(layout).toContain('export const dynamic = "force-dynamic"')
  })

  it("both script tags in it carry the nonce", () => {
    expect(layout).toContain("nonce={nonce}")
    expect(layout.match(/nonce=\{nonce\}/g) ?? []).toHaveLength(2)
  })

  it("the nonce comes from the request headers middleware set", () => {
    expect(layout).toContain('headers()).get("x-nonce")')
  })

  it("says what removing the dynamic line would require", () => {
    expect(layout).toContain("Do not remove it on its own")
  })
})
