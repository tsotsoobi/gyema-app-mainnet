// Guest rail zone pricing. V1: Greater Accra only, four zones, static matrix.
// Prices anchored to July 2026 Accra dispatch market rates (cross-zone 40-55,
// Tema corridor 55-60 per delivery at incumbent services; within-zone floor ~20-25).
// Repricing is a one-cell edit here; nothing else in the app knows prices.

export type GuestZone = "A" | "B" | "C" | "D" | "E"

// Bounded area list for the guest form. Everything else gets the
// corridor-coming-soon signpost. Keep alphabetized within zones.
export const GUEST_AREAS: Record<string, GuestZone> = {
  // Zone A: Central Accra
  "Accra Central": "A",
  "Adabraka": "A",
  "Airport Residential": "A",
  "Asylum Down": "A",
  "Cantonments": "A",
  "Dzorwulu": "A",
  "Labone": "A",
  "North Ridge": "A",
  "Osu": "A",
  "Ridge": "A",
  // Zone B: East and North
  "Adenta": "B",
  "Ashaley Botwe": "B",
  "East Legon": "B",
  "Haatso": "B",
  "Madina": "B",
  "Oyarifa": "B",
  "Spintex": "B",
  // Zone C: West Accra
  "Ablekuma": "C",
  "Dansoman": "C",
  "Kaneshie": "C",
  "Lapaz": "C",
  "Mallam": "C",
  "Weija": "C",
  // Zone D: Tema corridor
  "Ashaiman": "D",
  "Nungua": "D",
  "Sakumono": "D",
  "Tema Community 1-12": "D",
  "Tema Community 13-25": "D",
  // Zone E: Northwest periphery
  "Amasaman": "E",
  "Kutunse": "E",
}

export const GUEST_AREA_NAMES = Object.keys(GUEST_AREAS)

// Symmetric zone-to-zone matrix in GHS. Key is the two zones sorted
// alphabetically and joined, so "AD" covers both A->D and D->A.
const ZONE_MATRIX: Record<string, number> = {
  AA: 25,
  AB: 40,
  AC: 40,
  AD: 55,
  BB: 25,
  BC: 45,
  BD: 45,
  CC: 25,
  CD: 60,
  DD: 25,
  AE: 50,
  BE: 55,
  CE: 40,
  DE: 70,
  EE: 35,
}

export function quoteCedis(pickupArea: string, dropoffArea: string): number | null {
  const from = GUEST_AREAS[pickupArea]
  const to = GUEST_AREAS[dropoffArea]
  if (!from || !to) return null
  const key = [from, to].sort().join("")
  return ZONE_MATRIX[key] ?? null
}

// Pioneer-rail advisory benchmark. Maps the coarse GHANA_CITIES vocabulary
// onto zone SETS and returns the min to max GHS spread across the zone
// cross-product. "Accra" spans zones A to C; "Tema" is the D corridor.
// Cities outside the Greater Accra zone system return null: never guess
// a price. Advisory only; Pioneer settlement stays in Pi.
const CITY_ZONE_SETS: Record<string, GuestZone[]> = {
  Accra: ["A", "B", "C"],
  Tema: ["D"],
}

export function quoteCedisRangeForCities(
  fromCity: string,
  toCity: string,
): { min: number; max: number } | null {
  const fromZones = CITY_ZONE_SETS[fromCity]
  const toZones = CITY_ZONE_SETS[toCity]
  if (!fromZones || !toZones) return null
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (const a of fromZones) {
    for (const b of toZones) {
      const v = ZONE_MATRIX[[a, b].sort().join("")]
      if (v === undefined) continue
      if (v < min) min = v
      if (v > max) max = v
    }
  }
  if (!Number.isFinite(min)) return null
  return { min, max }
}