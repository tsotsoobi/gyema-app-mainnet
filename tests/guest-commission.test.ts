import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import {
  COMMISSION_BASIS_POINTS,
  COMMISSION_RATE_LABEL,
  COMMISSION_ROUND_PESEWAS,
  courierSplit,
  recordedSplit,
} from "@/lib/guest-commission"

// The courier commission: 7.5% of the gross quote, rounded to the nearest
// 0.50 GHS with an exact half step rounding up.

describe("the rate and rounding are what was decided", () => {
  it("is 7.5% rounded to 0.50", () => {
    expect(COMMISSION_BASIS_POINTS).toBe(750)
    expect(COMMISSION_ROUND_PESEWAS).toBe(50)
    expect(COMMISSION_RATE_LABEL).toBe("7.5%")
  })
})

describe("courierSplit on every price on the current ladder", () => {
  // quote, exact 7.5%, commission after rounding, courier keeps
  const ladder: Array<[number, number, number]> = [
    [25, 2.0, 23.0], // 1.875
    [35, 2.5, 32.5], // 2.625
    [40, 3.0, 37.0], // 3.00
    [45, 3.5, 41.5], // 3.375
    [50, 4.0, 46.0], // 3.75, an exact half step, rounds up
    [55, 4.0, 51.0], // 4.125
    [60, 4.5, 55.5], // 4.50
    [70, 5.5, 64.5], // 5.25, an exact half step, rounds up
  ]

  for (const [quote, commission, keeps] of ladder) {
    it(`${quote} GHS: owes ${commission.toFixed(2)}, keeps ${keeps.toFixed(2)}`, () => {
      expect(courierSplit(quote)).toEqual({
        collectCedis: quote,
        commissionCedis: commission,
        keepsCedis: keeps,
        rateLabel: "7.5%",
      })
    })
  }

  it("covers every distinct price in ZONE_MATRIX, so a new ladder price fails here first", () => {
    const source = readFileSync("lib/guest-pricing.ts", "utf8")
    const block = source.slice(source.indexOf("const ZONE_MATRIX"), source.indexOf("export function quoteCedis"))
    const prices = [...new Set((block.match(/:\s*(\d+)/g) ?? []).map((m) => Number(m.replace(/\D/g, ""))))].sort(
      (a, b) => a - b
    )
    expect(prices).toEqual(ladder.map(([q]) => q))
  })
})

describe("courierSplit on off-ladder and unusable quotes", () => {
  it("handles a hand-set decimal quote exactly", () => {
    // 42.50 * 7.5% = 3.1875, nearest 0.50 is 3.00
    expect(courierSplit(42.5)).toMatchObject({ commissionCedis: 3.0, keepsCedis: 39.5 })
    // 36.67 * 7.5% = 2.75025, just past the half step, rounds to 3.00
    expect(courierSplit(36.67)).toMatchObject({ commissionCedis: 3.0, keepsCedis: 33.67 })
  })

  it("accepts a numeric string, which is how a numeric column can arrive", () => {
    expect(courierSplit("40")).toMatchObject({ commissionCedis: 3.0 })
    expect(courierSplit("50.00")).toMatchObject({ commissionCedis: 4.0 })
  })

  it("keeps collect equal to commission plus keeps, to the pesewa", () => {
    for (let pesewas = 100; pesewas <= 20_000; pesewas += 7) {
      const s = courierSplit(pesewas / 100)!
      expect(Math.round(s.commissionCedis * 100) + Math.round(s.keepsCedis * 100)).toBe(pesewas)
      expect(Math.round(s.commissionCedis * 100) % 50).toBe(0)
    }
  })

  it("refuses anything that is not a positive two decimal amount", () => {
    for (const bad of [null, undefined, 0, -40, Number.NaN, Number.POSITIVE_INFINITY, 42.555, "", "abc", "40.123", "-5", {}]) {
      expect(courierSplit(bad), String(bad)).toBeNull()
    }
  })
})

describe("recordedSplit reads what was written and never recomputes", () => {
  it("labels a figure the current rate produced", () => {
    expect(recordedSplit(40, 3)).toEqual({
      collectCedis: 40,
      commissionCedis: 3,
      keepsCedis: 37,
      rateLabel: "7.5%",
    })
  })

  it("keeps a 5% remit recorded before this rate, with no rate label", () => {
    expect(recordedSplit(40, 2)).toEqual({
      collectCedis: 40,
      commissionCedis: 2,
      keepsCedis: 38,
      rateLabel: null,
    })
  })

  it("shows no split when nothing usable was recorded", () => {
    expect(recordedSplit(40, null)).toBeNull()
    expect(recordedSplit(null, 3)).toBeNull()
    expect(recordedSplit(40, 41)).toBeNull()
    expect(recordedSplit(40, -1)).toBeNull()
  })
})

// The figure on a courier's screen and the figure in remit_cedis must never
// disagree, so the function lives on the server only. A component or client
// lib importing it would be the start of a second computation in the browser.
describe("lib/guest-commission.ts is imported by API routes and nothing else", () => {
  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const full = join(dir, entry).replace(/\\/g, "/")
      if (statSync(full).isDirectory()) return sourceFiles(full)
      return /\.(ts|tsx|mjs|js)$/.test(entry) ? [full] : []
    })
  }

  it("has no importer outside app/api", () => {
    const importers = [...sourceFiles("app"), ...sourceFiles("components"), ...sourceFiles("lib"), ...sourceFiles("hooks")]
      .filter((f) => f !== "lib/guest-commission.ts")
      // An import, not a mention: lib/guest-jobs.ts names this file in a comment.
      .filter((f) => /(from|import\()\s*["'][^"']*guest-commission["']/.test(readFileSync(f, "utf8")))
    for (const f of importers) {
      expect(f, `${f} imports the commission function`).toMatch(/^app\/api\//)
    }
    expect(importers.sort()).toEqual([
      "app/api/guest/accept/route.ts",
      "app/api/guest/mine/route.ts",
      "app/api/guest/open/route.ts",
    ])
  })
})
