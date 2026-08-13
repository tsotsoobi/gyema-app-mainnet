import { createHash, randomInt, timingSafeEqual } from "crypto"

// The one-time delivery code: the courier's proof of physical presence at
// handover. Minted when a courier claims a guest job, revealed to the sender
// on the public tracker behind the same last-4 guard the confirm routes use,
// carried by the sender to the recipient, and spoken aloud at the door.
//
// SERVER ONLY. This module imports node:crypto and must never be pulled into
// a client component. The client-safe half of this feature (the stamp tokens)
// lives in lib/delivery-stamps.ts precisely so this file stays server-side.
//
// Only the SHA-256 hash is ever stored (guest_jobs.delivery_code_hash), and
// that column never appears in any response payload from any route.

// 0000 through 9999 inclusive. 0000 is a valid code and is never re-rolled:
// skipping it would both bias the draw and leak a bit to anyone guessing.
export const DELIVERY_CODE_SPACE = 10000

export function mintDeliveryCode(): string {
  // randomInt is CSPRNG-backed and rejection-samples internally, so every
  // code in the space is equally likely. Not Math.random.
  return String(randomInt(0, DELIVERY_CODE_SPACE)).padStart(4, "0")
}

export function hashDeliveryCode(code: string): string {
  return createHash("sha256").update(code).digest("hex")
}

// Constant-time digest compare. The submitting courier never holds the stored
// hash, so a timing oracle here is a thin attack at best, but a code check is
// exactly the place to not hand one out for free.
export function hashesMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "hex")
  const bufB = Buffer.from(b, "hex")
  if (bufA.length === 0 || bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

// Recover the plaintext by exhausting the code space (10k SHA-256 rounds,
// sub-millisecond). The sender reveal needs the plaintext and the column
// holds only the hash, so there is nowhere else for it to come from.
//
// Be clear-eyed about what this means: over a 4-digit space the hash is
// obfuscation at rest, not secrecy. Anyone who can read delivery_code_hash
// can run this same loop. The column is not a substitute for guarding the
// read paths, which is why every route that touches it guards first.
export function codeFromHash(hash: string): string | null {
  for (let i = 0; i < DELIVERY_CODE_SPACE; i++) {
    const candidate = String(i).padStart(4, "0")
    if (hashDeliveryCode(candidate) === hash) return candidate
  }
  return null
}
