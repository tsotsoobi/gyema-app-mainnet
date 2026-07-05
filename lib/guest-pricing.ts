// Guest rail zone pricing. V1: Greater Accra only, four zones, static matrix.
// Prices anchored to July 2026 Accra dispatch market rates (cross-zone 40-55,
// Tema corridor 55-60 per delivery at incumbent services; within-zone floor ~20-25).
// Repricing is a one-cell edit here; nothing else in the app knows prices.

export type GuestZone = "A" | "B" | "C" | "D"

// Bounded area list for the guest form. Everything else gets the
// corridor-coming-soon signpost. Keep alphabetized within zones.
export const GUEST_AREAS: Record<string, GuestZone> = {
  // Zone A: Central Accra
  "Accra Central": "A",
  "Adabraka": "A",
  "Airport Residential": "A",
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
}

export function quoteCedis(pickupArea: string, dropoffArea: string): number | null {
  const from = GUEST_AREAS[pickupArea]
  const to = GUEST_AREAS[dropoffArea]
  if (!from || !to) return null
  const key = [from, to].sort().join("")
  return ZONE_MATRIX[key] ?? null
}