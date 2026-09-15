// Courier commission on the guest rail. Server only.
//
// Gyema takes 7.5% of the gross quote the customer pays, denominated in cedis,
// from the courier. The courier keeps the rest. The base is the quote itself,
// not what Gyema nets after any payment channel deduction: a courier can check
// a percentage of a price they can see, and cannot check a subtraction they
// never saw. One price per corridor on every channel, so nothing here knows
// about channels.
//
// ROUNDING. The commission is rounded to the nearest 0.50 GHS, because the
// courier hands it over as physical money and counting pesewas is friction.
// An exact half step rounds UP: 3.75 becomes 4.00 and 5.25 becomes 5.50. On
// the current ladder that is the 50 and 70 corridors. The arithmetic runs in
// integer pesewas so a value like 3.75 can never arrive as 3.7499999.
//
// WHY ONE FUNCTION, AND WHY NOT THE BROWSER. The figure a courier is shown
// and the figure written to guest_jobs.remit_cedis must never disagree. So
// app/api/guest/open computes the preview with courierSplit, app/api/guest/
// accept computes the value it writes with courierSplit, and app/api/guest/
// mine reads the written value back with recordedSplit. No component imports
// this file: every figure reaches the UI inside an API response.
// tests/guest-commission.test.ts enforces that by source scan.

/** 7.5%, in basis points. The only place the rate lives. */
export const COMMISSION_BASIS_POINTS = 750

/** The commission is rounded to a multiple of this many pesewas. */
export const COMMISSION_ROUND_PESEWAS = 50

/** The rate as a courier reads it, derived from the basis points. */
export const COMMISSION_RATE_LABEL = `${COMMISSION_BASIS_POINTS / 100}%`

export type CourierSplit = {
  /** What the courier collects from the customer at the door: the quote. */
  collectCedis: number
  /** What the courier owes Gyema. */
  commissionCedis: number
  /** What the courier keeps. collectCedis minus commissionCedis, exactly. */
  keepsCedis: number
  /**
   * The rate to print beside the commission, or null when the figure was not
   * produced by the current rate (a remit recorded by hand before this
   * function existed). Never print a rate the record does not carry.
   */
  rateLabel: string | null
}

/**
 * A cedi amount as integer pesewas, or null when it is not a usable amount.
 *
 * Accepts a number or a plain decimal string, because a numeric column can
 * arrive as either. Refuses anything with more than two decimal places rather
 * than rounding it silently: a quote of 42.555 is a data fault, not a price.
 */
function toPesewas(value: unknown, allowZero: boolean): number | null {
  let n: unknown = value
  if (typeof value === "string") {
    if (!/^\d+(\.\d{1,2})?$/.test(value.trim())) return null
    n = Number(value.trim())
  }
  if (typeof n !== "number" || !Number.isFinite(n)) return null
  if (n < 0 || (!allowZero && n === 0)) return null
  const pesewas = Math.round(n * 100)
  if (Math.abs(pesewas - n * 100) > 1e-6) return null
  return pesewas
}

/**
 * Commission in pesewas for a quote in pesewas, rounded to the nearest
 * COMMISSION_ROUND_PESEWAS with an exact half step rounding up.
 *
 * The exact commission is quote * bp / 10000 pesewas. Counted in rounding
 * steps that is quote * bp / (10000 * step). Rounding half up on a ratio n / u
 * of positive integers is floor((2n + u) / 2u), which stays in integers.
 */
function commissionPesewas(quotePesewas: number): number {
  const n = quotePesewas * COMMISSION_BASIS_POINTS
  const u = 10_000 * COMMISSION_ROUND_PESEWAS
  const steps = Math.floor((2 * n + u) / (2 * u))
  return steps * COMMISSION_ROUND_PESEWAS
}

/**
 * The split at the current rate, for a quote. Null when the quote is null,
 * not positive, or not a two decimal cedi amount: such a job has no price a
 * courier could agree to, and app/api/guest/accept refuses it.
 */
export function courierSplit(quoteCedis: unknown): CourierSplit | null {
  const quote = toPesewas(quoteCedis, false)
  if (quote === null) return null
  const commission = commissionPesewas(quote)
  return {
    collectCedis: quote / 100,
    commissionCedis: commission / 100,
    keepsCedis: (quote - commission) / 100,
    rateLabel: COMMISSION_RATE_LABEL,
  }
}

/**
 * The split as RECORDED on a job: the quote and the remit_cedis actually
 * written, never recomputed. A job accepted before this function existed keeps
 * whatever was recorded for it, and rateLabel is null unless the recorded
 * commission is exactly what the current rate gives for that quote.
 *
 * Null when either amount is missing or unusable, or the remit exceeds the
 * quote, so the UI shows the amount collected and nothing it cannot stand
 * behind.
 */
export function recordedSplit(quoteCedis: unknown, remitCedis: unknown): CourierSplit | null {
  const quote = toPesewas(quoteCedis, false)
  const remit = toPesewas(remitCedis, true)
  if (quote === null || remit === null || remit > quote) return null
  return {
    collectCedis: quote / 100,
    commissionCedis: remit / 100,
    keepsCedis: (quote - remit) / 100,
    rateLabel: remit === commissionPesewas(quote) ? COMMISSION_RATE_LABEL : null,
  }
}
