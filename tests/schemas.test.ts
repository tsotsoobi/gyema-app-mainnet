import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import {
  GuestCreateBody,
  GuestConfirmDeliveryBody,
  GuestLast4Body,
  PaymentCompleteBody,
  ghanaPhone,
  reasonFor,
  trackingId,
} from "@/lib/schemas"

// Phase 3. zod was a dependency from the start and imported nowhere: every
// route hand-rolled its checks, so they differed. These test the schemas
// themselves, and the route tests exercise them through the handlers.

function reason(schema: { safeParse: (v: unknown) => { success: boolean; error?: unknown } }, value: unknown) {
  const r = schema.safeParse(value)
  expect(r.success).toBe(false)
  return reasonFor(r.error as never)
}

describe("bounds", () => {
  it("caps every free text field a stranger can send", () => {
    // /api/guest/create is the one route an unauthenticated caller can write a
    // row with. An uncapped string there is a row they choose the size of.
    const base = {
      pickupArea: "Osu",
      dropoffArea: "Madina",
      packageSize: "small",
      senderPhone: "0244123456",
    }
    for (const [field, length] of [
      ["pickupArea", 81],
      ["dropoffArea", 81],
      ["pickupLandmark", 161],
      ["dropoffLandmark", 161],
      ["contentsNote", 501],
      ["recipientName", 81],
    ] as const) {
      const body = { ...base, [field]: "x".repeat(length) }
      expect(GuestCreateBody.safeParse(body).success, `${field} should be capped`).toBe(false)
    }
  })

  it("accepts an ordinary delivery", () => {
    const parsed = GuestCreateBody.safeParse({
      pickupArea: "  Osu  ",
      dropoffArea: "Madina",
      packageSize: "small",
      senderPhone: "0244123456",
      contentsNote: "  documents  ",
      recipientName: "Ama",
      recipientPhone: "+233 20 123 4567",
      whenPref: "today",
      paymentType: "momo",
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      // Trimmed on the way in, so the required check, the area list and the
      // insert all read one value. This is the fix for the untrimmed areas
      // found live on 21 August.
      expect(parsed.data.pickupArea).toBe("Osu")
      expect(parsed.data.contentsNote).toBe("documents")
    }
  })

  it("bounds the session token from above and not from below", () => {
    // The property is the maximum: without one, a caller chooses how much text
    // the route hands to getUser. A short token is a wrong credential, which is
    // a 401 from resolveCaller, not a 400 from here.
    expect(PaymentCompleteBody.safeParse({
      accessToken: "x".repeat(5000),
      paymentId: "p1",
      txid: "a".repeat(64),
    }).success).toBe(false)
    expect(PaymentCompleteBody.safeParse({
      accessToken: "short",
      paymentId: "p1",
      txid: "a".repeat(64),
    }).success).toBe(true)
  })
})

describe("the Ghana phone rule", () => {
  it("takes the two forms people actually type", () => {
    for (const value of [
      "0244123456",
      "+233244123456",
      "+233 24 412 3456",
      "024-412-3456",
      "(024) 412 3456",
    ]) {
      expect(ghanaPhone.safeParse(value).success, value).toBe(true)
    }
  })

  it("refuses anything too short to carry a guard", () => {
    // The last four digits of this number become the guard on three public
    // routes. A number with fewer than four digits creates a job whose guard
    // can never be satisfied by anybody, including its owner.
    for (const value of ["123", "12345678", "", "   "]) {
      expect(ghanaPhone.safeParse(value).success, value).toBe(false)
    }
  })

  it("refuses letters and injection-shaped punctuation", () => {
    for (const value of ["0244abc456", "0244123456; drop", "0244123456,or=1"]) {
      expect(ghanaPhone.safeParse(value).success, value).toBe(false)
    }
  })

  it("does not rewrite what the sender typed", () => {
    // Normalising to E.164 here would change the last four digits on numbers
    // entered with a country code, which is the guard. That is a migration
    // with a backfill, not a validation rule.
    const parsed = ghanaPhone.safeParse("+233 24 412 3456")
    expect(parsed.success && parsed.data).toBe("+233 24 412 3456")
  })
})

describe("the tracking ID rule", () => {
  it("upper-cases and trims what a person types into the tracker", () => {
    const parsed = trackingId.safeParse("  gym-a1b2c3  ")
    expect(parsed.success && parsed.data).toBe("GYM-A1B2C3")
  })

  it("refuses anything else", () => {
    for (const value of ["GYM-A1B2C", "GYM-A1B2C3X", "XYZ-A1B2C3", "GYM-A1B2C!", ""]) {
      expect(trackingId.safeParse(value).success, value).toBe(false)
    }
  })
})

describe("refusal reasons do not change", () => {
  // The UI branches on some of these and the route tests assert others.
  // Validation moved into one file; the contract did not.
  it("keeps each route's own name for its own field", () => {
    expect(reason(GuestLast4Body, { trackingId: "nope", last4: "1234" })).toBe("invalid_tracking_id")
    expect(reason(GuestLast4Body, { trackingId: "GYM-A1B2C3", last4: "12" })).toBe("invalid_last4")
    expect(reason(GuestConfirmDeliveryBody, { trackingId: "GYM-A1B2C3", last4: "1234" })).toBe("invalid_via")
    expect(reason(GuestCreateBody, {
      pickupArea: "Osu", dropoffArea: "Madina", packageSize: "enormous", senderPhone: "0244123456",
    })).toBe("bad_size")
    expect(reason(GuestCreateBody, {
      pickupArea: "Osu", dropoffArea: "Madina", packageSize: "small",
      senderPhone: "0244123456", paymentType: "gold",
    })).toBe("bad_payment")
    expect(reason(GuestCreateBody, {
      pickupArea: "Osu", dropoffArea: "Madina", packageSize: "small", senderPhone: "12",
    })).toBe("invalid_phone")
    expect(reason(PaymentCompleteBody, { paymentId: "p1", txid: "not-a-hash" })).toBe("bad_txid")
  })

  it("falls back to bad_request rather than naming an unexpected field", () => {
    expect(reason(GuestCreateBody, { packageSize: "small", senderPhone: "0244123456" })).toBe("bad_request")
  })
})

describe("the discriminator on confirm-delivery", () => {
  it("requires last4 on the sender path and code on the courier path", () => {
    const base = { trackingId: "GYM-A1B2C3" }
    expect(reason(GuestConfirmDeliveryBody, { ...base, via: "sender" })).toBe("invalid_last4")
    expect(reason(GuestConfirmDeliveryBody, { ...base, via: "courier_code" })).toBe("invalid_code")
    expect(GuestConfirmDeliveryBody.safeParse({ ...base, via: "sender", last4: "1234" }).success).toBe(true)
    expect(
      GuestConfirmDeliveryBody.safeParse({
        ...base, via: "courier_code", code: "1234", accessToken: "token",
      }).success
    ).toBe(true)
  })

  it("has no default via, so an absent one is malformed rather than a sender", () => {
    expect(GuestConfirmDeliveryBody.safeParse({ trackingId: "GYM-A1B2C3", last4: "1234" }).success).toBe(false)
  })
})

describe("every route validates its body", () => {
  function routeFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) return routeFiles(full)
      return entry === "route.ts" ? [full.replace(/\\/g, "/")] : []
    })
  }

  const routes = routeFiles("app/api")

  it("finds every route, so a new one cannot skip this file", () => {
    // 18 today: the original 15 plus the three status transitions. The count
    // is asserted so adding a route without adding it to this sweep fails
    // here rather than going unvalidated.
    expect(routes.length).toBe(18)
  })

  for (const file of routes) {
    it(`${file} parses through a schema or takes no input`, () => {
      const source = readFileSync(file, "utf8")
      const readsBody = source.includes("request.json()") || source.includes("req.json()")
      const usesSchema =
        source.includes("parseJsonBody") ||
        source.includes("parseQuery") ||
        source.includes("safeParse")

      // A route either validates with a schema, or reads nothing from the
      // caller at all. Reading a raw body and trusting it is the thing this
      // phase removed.
      if (readsBody) {
        expect(usesSchema, `${file} reads a body without a schema`).toBe(true)
      }
      expect(source).not.toContain("await request.json()\n    const {")
    })
  }
})
