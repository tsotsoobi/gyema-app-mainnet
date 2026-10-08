import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  benchmarkMistypedAsPi,
  pioneerBenchmarkCedis,
  quoteCedis,
} from "@/lib/guest-pricing"

// The Pioneer forms print a cedi dispatch benchmark and take a Pi offer. A
// Pioneer who read "50 GHS" and typed 50 offered 50 Pi for a delivery worth
// about 50 cedis, and nothing refused it: the offer is never charged, so no
// payment check sees it, and piAmount accepts any finite number to 10,000.
//
// Two things close it and both are tested here. A non-blocking warning that
// fires on exactly that mistake, and a layout that stops putting a cedi figure
// directly above a Pi box.

describe("pioneerBenchmarkCedis resolves the same figure the form shows", () => {
  it("returns the exact cell for two areas in the bounded list", () => {
    const exact = quoteCedis("Osu", "Madina")
    expect(exact).not.toBeNull()
    expect(pioneerBenchmarkCedis("Osu", "Madina")).toEqual({ min: exact, max: exact })
  })

  it("returns a spread for the coarse city vocabulary", () => {
    const r = pioneerBenchmarkCedis("Accra", "Tema")
    expect(r).not.toBeNull()
    expect(r!.min).toBeLessThan(r!.max)
  })

  it("returns null rather than guessing a corridor it does not price", () => {
    expect(pioneerBenchmarkCedis("Kumasi", "Osu")).toBeNull()
    expect(pioneerBenchmarkCedis("Other", "Other")).toBeNull()
    expect(pioneerBenchmarkCedis("", "")).toBeNull()
  })
})

describe("benchmarkMistypedAsPi catches the mistake that shipped", () => {
  it("fires on the founder's case: a 50 GHS corridor with 50 typed as Pi", () => {
    // Pick a corridor the matrix prices at exactly 50 so the case is the real
    // one rather than an arranged one. Asylum Down is zone A, Amasaman zone E.
    expect(quoteCedis("Asylum Down", "Amasaman")).toBe(50)
    expect(benchmarkMistypedAsPi("50", "Asylum Down", "Amasaman")).toEqual({
      min: 50,
      max: 50,
    })
  })

  it("fires on a near miss inside a range, not only on an exact copy", () => {
    const r = pioneerBenchmarkCedis("Accra", "Tema")!
    const midway = (r.min + r.max) / 2
    expect(midway).toBeGreaterThan(r.min)
    expect(benchmarkMistypedAsPi(String(midway), "Accra", "Tema")).toEqual(r)
  })

  it("is silent on the Pi amounts the forms actually suggest", () => {
    // The placeholders are 10 on the trip form and 5 on the package form, and
    // the cheapest corridor in the matrix is well above both. That separation
    // is the whole reason a floor threshold is not noisy.
    for (const placeholder of ["5", "10"]) {
      for (const [from, to] of [
        ["Osu", "Madina"],
        ["Asylum Down", "Amasaman"],
        ["Accra", "Tema"],
      ]) {
        expect(benchmarkMistypedAsPi(placeholder, from, to)).toBeNull()
      }
    }
  })

  it("is silent just under the floor and speaks at it", () => {
    const r = pioneerBenchmarkCedis("Osu", "Madina")!
    expect(benchmarkMistypedAsPi(String(r.min - 0.1), "Osu", "Madina")).toBeNull()
    expect(benchmarkMistypedAsPi(String(r.min), "Osu", "Madina")).toEqual(r)
  })

  it("is silent when there is no benchmark on screen to copy", () => {
    expect(benchmarkMistypedAsPi("50", "Kumasi", "Osu")).toBeNull()
    expect(benchmarkMistypedAsPi("50", "Other", "Other")).toBeNull()
  })

  it("is silent on anything that is not a positive number", () => {
    for (const junk of ["", "   ", "abc", "-5", "0", "NaN", "Infinity"]) {
      expect(benchmarkMistypedAsPi(junk, "Osu", "Madina")).toBeNull()
    }
  })

  it("never depends on a Pi to GHS rate, because none exists", () => {
    // The whole module is read rather than the one function, because a rate
    // introduced anywhere in it would be available to this check.
    const src = readFileSync(join(process.cwd(), "lib", "guest-pricing.ts"), "utf8")
    expect(src).not.toMatch(/(PI_TO_GHS|GHS_PER_PI|piRate|exchangeRate)/i)
  })
})

// The layout half. These read the component rather than restating it, so a
// test that hardcoded the field order would pass on the day someone moved the
// benchmark back up against the money input.
describe("neither Pioneer form puts a cedi figure above a Pi input", () => {
  const src = readFileSync(join(process.cwd(), "components", "home-tab.tsx"), "utf8")

  const forms = [
    { name: "trip", open: 't-from"', date: 't-date"', money: 't-price"', close: 't-whatsapp"' },
    { name: "package", open: 'desc"', date: 'deadline"', money: 'offer"', close: 's-whatsapp"' },
  ]

  for (const form of forms) {
    describe(`the ${form.name} form`, () => {
      const start = src.indexOf(form.open)
      const end = src.indexOf(form.close)
      const region = src.slice(start, end)

      it("is located, so the assertions below are about something", () => {
        expect(start).toBeGreaterThan(-1)
        expect(end).toBeGreaterThan(start)
      })

      it("renders the benchmark and the warning", () => {
        expect(region).toContain("<CorridorBenchmark")
        expect(region).toContain("<PiUnitWarning")
      })

      it("separates the benchmark from the money field by at least one field", () => {
        const benchmark = region.indexOf("<CorridorBenchmark")
        const date = region.indexOf(form.date)
        const money = region.indexOf(form.money)
        expect(benchmark).toBeGreaterThan(-1)
        expect(date).toBeGreaterThan(benchmark)
        expect(money).toBeGreaterThan(date)
      })

      it("puts the warning after the money input, where the typed value is", () => {
        expect(region.indexOf("<PiUnitWarning")).toBeGreaterThan(region.indexOf(form.money))
      })
    })
  }

  it("carries exactly one copy of the benchmark sentence", () => {
    // Both forms held byte-identical copies of it, which is how one defect
    // shipped in two places. One component now, and this keeps it that way.
    const copies = src.match(/Typical dispatch rate on this corridor/g) ?? []
    expect(copies).toHaveLength(1)
  })

  it("does not let the warning block a submission", () => {
    // Advisory only. A Pioneer who means a large Pi offer is entitled to one,
    // so the warning must not reach either form's validity gate.
    expect(src).not.toMatch(/valid\s*=[\s\S]{0,400}benchmarkMistypedAsPi/)
    expect(src).not.toMatch(/disabled=\{[^}]*benchmarkMistypedAsPi/)
  })
})
