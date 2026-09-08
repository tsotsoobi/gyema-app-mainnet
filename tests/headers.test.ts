import { describe, it, expect } from "vitest"
import { NextRequest } from "next/server"
import { readFileSync } from "node:fs"
import { middleware } from "@/middleware"
import nextConfig from "@/next.config.mjs"

// Phase 4, the static half. There were no security headers at all (S-7).
// These assert the two properties that are easy to get wrong: the framing rule
// has to admit the Pi Browser's proxy, and the https redirect must not fire on
// loopback, where there is no https to redirect to.

async function headerMap() {
  const rules = await (nextConfig as unknown as { headers: () => Promise<Array<{ source: string; headers: Array<{ key: string; value: string }> }>> }).headers()
  const all = new Map<string, string>()
  for (const rule of rules) {
    for (const h of rule.headers) all.set(h.key, h.value)
  }
  return { rules, all }
}

describe("the static headers", () => {
  it("covers every route, api included", async () => {
    const { rules } = await headerMap()
    expect(rules).toHaveLength(1)
    expect(rules[0].source).toBe("/:path*")
  })

  it("sets HSTS for two years with subdomains and WITHOUT preload", async () => {
    const { all } = await headerMap()
    const hsts = all.get("Strict-Transport-Security")
    expect(hsts).toContain("max-age=63072000")
    expect(hsts).toContain("includeSubDomains")
    // Preload is a one-way door: removal takes months and browsers ship the
    // list. Not on the same day as a first HSTS header.
    expect(hsts).not.toContain("preload")
  })

  it("sets nosniff and a referrer policy that does not leak a tracking ID", async () => {
    const { all } = await headerMap()
    expect(all.get("X-Content-Type-Options")).toBe("nosniff")
    // A tracking ID travels in the path on the deep-link form and is a
    // capability: it reaches the last-4 guard. It must not ride a referrer to
    // wa.me or anywhere else.
    expect(all.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin")
  })

  it("denies geolocation and camera, because nothing uses them", async () => {
    const { all } = await headerMap()
    const pp = all.get("Permissions-Policy") ?? ""
    expect(pp).toContain("geolocation=()")
    expect(pp).toContain("camera=()")
    expect(pp).toContain("microphone=()")
    // Empty parentheses, not (self): the honest scope today is nowhere, and
    // a permission is granted per surface when a surface needs it.
    expect(pp).not.toContain("geolocation=(self)")
    expect(pp).not.toContain("camera=(self)")
  })

  it("sets no CSP of its own, because middleware sets the only one", async () => {
    // frame-ancestors lives in the per-request policy now (lib/csp.ts). Two
    // CSP headers on one response are both enforced and the intersection
    // applies, which is a confusing way to break something.
    const { all } = await headerMap()
    expect(all.has("Content-Security-Policy")).toBe(false)
    expect(all.has("Content-Security-Policy-Report-Only")).toBe(false)
  })

  it("does not use X-Frame-Options, which cannot express that", async () => {
    const { all } = await headerMap()
    expect(all.has("X-Frame-Options")).toBe(false)
    // SAMEORIGIN would break the app in the only browser it is meant to run in.
    const source = readFileSync("next.config.mjs", "utf8")
    expect(source).toContain("X-Frame-Options cannot express")
  })

  it("carries no duplicate of any header middleware also sets", async () => {
    const { rules } = await headerMap()
    const keys = rules.flatMap((r) => r.headers.map((h) => h.key))
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys).not.toContain("Content-Security-Policy")
  })
})

describe("the https redirect", () => {
  function request(url: string, headers: Record<string, string>) {
    return new NextRequest(new Request(url, { headers }))
  }

  it("redirects http to https with 308, keeping method and body", () => {
    const res = middleware(
      request("http://gyema3681.pinet.com/track/GYM-A1B2C3", {
        "x-forwarded-proto": "http",
        host: "gyema3681.pinet.com",
      })
    )
    expect(res.status).toBe(308)
    expect(res.headers.get("location")).toBe("https://gyema3681.pinet.com/track/GYM-A1B2C3")
  })

  it("leaves https alone", () => {
    const res = middleware(
      request("https://gyema3681.pinet.com/", {
        "x-forwarded-proto": "https",
        host: "gyema3681.pinet.com",
      })
    )
    expect(res.status).toBe(200)
    expect(res.headers.get("location")).toBeNull()
  })

  it("never redirects loopback, where there is no https to redirect to", () => {
    for (const host of ["localhost:3000", "127.0.0.1:3000", "localhost"]) {
      const res = middleware(
        request(`http://${host}/`, { "x-forwarded-proto": "http", host })
      )
      expect(res.status, host).toBe(200)
    }
  })

  it("does nothing when no proxy has told us the protocol", () => {
    // An absent header is the local case. Guessing would break dev.
    const res = middleware(request("http://gyema3681.pinet.com/", { host: "gyema3681.pinet.com" }))
    expect(res.status).toBe(200)
  })

  it("decides on the hostname, not on an environment variable", () => {
    // NODE_ENV set wrongly in production must not switch the redirect off.
    // Comments are stripped: the header explains this choice by naming the
    // variable, which is the opposite of reading it.
    const code = readFileSync("middleware.ts", "utf8")
      .split(/\r?\n/)
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n")
    expect(code).not.toContain("NODE_ENV")

    // One environment variable is read in this file, and it is the CSP mode
    // flag: a deliberate switch rather than an accident of deployment.
    // Anything else appearing here should be looked at.
    const envReads = code.match(/process\.env\.[A-Z_]+/g) ?? []
    expect(envReads).toEqual(["process.env.CSP_ENFORCE"])
  })
})
