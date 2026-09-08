import { describe, it, expect } from "vitest"
import {
  assertUsablePioneerSalt,
  MIN_SALT_LENGTH,
  SecretConfigurationError,
} from "@/lib/env-guard"

// S-8. PIONEER_PASSWORD_SALT is the HMAC key that derives every Pioneer's
// Supabase password from their pi_uid. Anyone holding it signs in as anyone,
// with Pi never involved. A missing salt already threw; a weak one did not.

const GOOD = "9f2c1d7a4e5b8c3f0a6d9e2b7c4f1a8d3e6b9c2f5a8d1e4b7c0f3a6d9e2b5c8f"

describe("assertUsablePioneerSalt", () => {
  it("accepts a generated salt", () => {
    expect(() => assertUsablePioneerSalt(GOOD)).not.toThrow()
  })

  it("refuses absent and blank", () => {
    for (const value of [undefined, "", "   "]) {
      expect(() => assertUsablePioneerSalt(value)).toThrow(SecretConfigurationError)
    }
  })

  it("refuses placeholders, whatever the casing", () => {
    for (const value of ["changeme", "CHANGEME", "Secret", "gyema", "replace-me", "todo"]) {
      expect(() => assertUsablePioneerSalt(value)).toThrow(/placeholder/i)
    }
  })

  it("refuses anything shorter than the minimum", () => {
    expect(() => assertUsablePioneerSalt("a1b2c3d4e5f6a7b8")).toThrow(
      new RegExp(`${MIN_SALT_LENGTH}`)
    )
  })

  it("refuses long strings built from too few characters", () => {
    for (const value of ["a".repeat(64), "ab".repeat(32), "1234".repeat(16)]) {
      expect(() => assertUsablePioneerSalt(value)).toThrow(/distinct characters/)
    }
  })

  it("never puts the value in the message", () => {
    // A refusal that quotes the secret back has moved it into a log.
    const secret = "changeme"
    try {
      assertUsablePioneerSalt(secret)
      throw new Error("should have thrown")
    } catch (err) {
      expect((err as Error).message).not.toContain(secret)
    }
    const shortish = "abcdefgh"
    try {
      assertUsablePioneerSalt(shortish)
      throw new Error("should have thrown")
    } catch (err) {
      expect((err as Error).message).not.toContain(shortish)
    }
  })

  it("says what to do about it", () => {
    try {
      assertUsablePioneerSalt(undefined)
    } catch (err) {
      expect((err as Error).message).toContain("openssl rand -hex 32")
      expect((err as Error).message).toContain("must not share")
    }
  })
})
