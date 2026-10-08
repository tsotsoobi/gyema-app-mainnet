import { describe, it, expect } from "vitest"
// @ts-expect-error plain .mjs script with no type declarations
import { evaluate } from "../scripts/audit-gate.mjs"

// The gate that replaced `npm audit --audit-level=high` in `npm run security`.
// What it must never do is let a high or critical through that is not the
// exact recorded exception, at the exact path it was recorded for.

const NEXT_POSTCSS = "node_modules/next/node_modules/postcss"

function advisory(ghsa: string, severity: string) {
  return { url: `https://github.com/advisories/${ghsa}`, severity, title: "t", range: "<9" }
}

function report(vulns: Record<string, { via: unknown[]; nodes: string[] }>) {
  return { vulnerabilities: vulns, metadata: {} }
}

describe("audit gate", () => {
  it("passes the recorded postcss advisories at next's pinned path", () => {
    const r = evaluate(
      report({
        postcss: {
          via: [advisory("GHSA-6g55-p6wh-862q", "high"), advisory("GHSA-r28c-9q8g-f849", "high")],
          nodes: [NEXT_POSTCSS],
        },
        next: { via: ["postcss"], nodes: ["node_modules/next"] },
      })
    )
    expect(r.ok).toBe(true)
    expect(r.accepted).toHaveLength(2)
    expect(r.failures).toEqual([])
  })

  it("fails the same advisory at any other path", () => {
    const r = evaluate(
      report({ postcss: { via: [advisory("GHSA-6g55-p6wh-862q", "high")], nodes: ["node_modules/postcss"] } })
    )
    expect(r.ok).toBe(false)
  })

  it("fails when the accepted path is one of several", () => {
    const r = evaluate(
      report({
        postcss: {
          via: [advisory("GHSA-6g55-p6wh-862q", "high")],
          nodes: [NEXT_POSTCSS, "node_modules/postcss"],
        },
      })
    )
    expect(r.ok).toBe(false)
  })

  it("fails any other high or critical, including one on the same package", () => {
    expect(
      evaluate(report({ postcss: { via: [advisory("GHSA-aaaa-bbbb-cccc", "high")], nodes: [NEXT_POSTCSS] } })).ok
    ).toBe(false)
    expect(
      evaluate(report({ next: { via: [advisory("GHSA-dddd-eeee-ffff", "critical")], nodes: ["node_modules/next"] } }))
        .ok
    ).toBe(false)
  })

  it("ignores moderate and low, as --audit-level=high did", () => {
    const r = evaluate(
      report({ postcss: { via: [advisory("GHSA-qx2v-qp2m-jg93", "moderate")], nodes: ["node_modules/postcss"] } })
    )
    expect(r.ok).toBe(true)
  })

  it("fails closed on a report it cannot read", () => {
    expect(evaluate(null).ok).toBe(false)
    expect(evaluate({ error: { code: "ENOAUDIT" } }).ok).toBe(false)
    expect(evaluate({ metadata: {} }).ok).toBe(false)
  })

  it("reports an exception that no longer appears, without failing", () => {
    const r = evaluate(report({}))
    expect(r.ok).toBe(true)
    expect(r.stale).toEqual(["GHSA-6g55-p6wh-862q", "GHSA-r28c-9q8g-f849"])
  })
})
