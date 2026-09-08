import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { last4ErrorMessage, isLast4Locked } from "@/lib/last4-messages"
import { MAX_LAST4_ATTEMPTS } from "@/lib/last4-guard"

// The ceiling landed in the routes with nothing in the UI reading it, so the
// tenth wrong attempt read exactly like the first and a locked sender was told
// their own number "does not match" with no way to find out why. This is the
// copy that closes that gap, and the assertion that all three cards use it.

describe("last4ErrorMessage", () => {
  it("counts down after a wrong entry, matching the courier card's shape", () => {
    // components/guest-courier-card.tsx says:
    //   "That code is not right. 3 tries left before it locks."
    const msg = last4ErrorMessage("guard_failed", 3)
    expect(msg).toContain("do not match")
    expect(msg).toContain("3 tries left before it locks")
  })

  it("says try, not tries, when one is left", () => {
    expect(last4ErrorMessage("guard_failed", 1)).toContain("1 try left")
    expect(last4ErrorMessage("guard_failed", 1)).not.toContain("tries")
  })

  it("does not invent a count when the server did not send one", () => {
    // A missing count must read as a plain refusal rather than announcing a
    // lockout that has not happened.
    const msg = last4ErrorMessage("guard_failed", undefined)
    expect(msg).toContain("do not match")
    expect(msg).not.toMatch(/tries? left/)
    expect(msg).not.toContain("locked")
  })

  it("on lock, says it is locked for this delivery and to contact support", () => {
    const msg = last4ErrorMessage("guard_locked", 0)
    expect(msg).toContain("locked for this delivery")
    expect(msg).toContain("Contact Gyema dispatch")
    // And it is distinct from the wrong-digits message, which is the whole
    // point: a sender must be able to tell the two apart.
    expect(msg).not.toBe(last4ErrorMessage("guard_failed", 3))
  })

  it("tells a sender who has just spent the last try that the right digits will not help either", () => {
    // The surprising part of any ceiling, and the part support gets called
    // about: once locked, the correct answer is refused too.
    expect(last4ErrorMessage("guard_locked", 0)).toContain("including with the right digits")
    expect(last4ErrorMessage("guard_failed", 0)).toContain("now locked")
  })

  it("keeps the other refusals it inherited", () => {
    expect(last4ErrorMessage("no_code")).toContain("does not have a code yet")
    expect(last4ErrorMessage("not_confirmable")).toContain("cannot be confirmed right now")
    expect(last4ErrorMessage("network")).toContain("Network problem")
    expect(last4ErrorMessage("something_unexpected")).toContain("Please try again")
    expect(last4ErrorMessage(undefined)).toContain("Please try again")
  })

  it("never names the phone number or the code", () => {
    // These messages are shown on a public page to whoever holds the link.
    for (const [reason, left] of [
      ["guard_failed", 3],
      ["guard_locked", 0],
      ["no_code", undefined],
    ] as const) {
      const msg = last4ErrorMessage(reason, left as number | undefined)
      expect(msg).not.toMatch(/\b\d{4}\b/)
    }
  })
})

describe("isLast4Locked", () => {
  it("is true on guard_locked and on a guard_failed with nothing left", () => {
    expect(isLast4Locked("guard_locked", 0)).toBe(true)
    expect(isLast4Locked("guard_failed", 0)).toBe(true)
  })

  it("is false while attempts remain, and for unrelated refusals", () => {
    expect(isLast4Locked("guard_failed", 1)).toBe(false)
    expect(isLast4Locked("guard_failed", MAX_LAST4_ATTEMPTS)).toBe(false)
    expect(isLast4Locked("guard_failed", undefined)).toBe(false)
    expect(isLast4Locked("no_code", undefined)).toBe(false)
    expect(isLast4Locked("network", undefined)).toBe(false)
  })
})

describe("the three tracker cards use it", () => {
  const source = readFileSync("components/track-view.tsx", "utf8")

  it("no card carries its own copy of the guard_failed sentence any more", () => {
    // Three hand written copies were how they drifted apart in the first place.
    expect(source).not.toContain('setRevealError("Those digits do not match')
    expect(source).not.toContain('setConfirmError("Those digits do not match')
    expect(source).not.toContain('setDeliveryError("Those digits do not match')
  })

  it("each card passes both the reason and the remaining attempts", () => {
    expect(source).toContain("setRevealError(last4ErrorMessage(res.reason, res.attemptsLeft))")
    expect(source).toContain("setConfirmError(last4ErrorMessage(body.reason, body.attemptsLeft))")
    expect(source).toContain("setDeliveryError(last4ErrorMessage(body.reason, body.attemptsLeft))")
  })

  it("each card locks its own input and button when the ceiling is reached", () => {
    // Leaving them live would invite an attempt that is refused whatever is
    // typed, which is how a sender concludes the app is broken rather than
    // that they are locked out.
    for (const flag of ["revealLocked", "confirmLocked", "deliveryLocked"]) {
      expect(source).toContain(`const [${flag}, set${flag[0].toUpperCase()}${flag.slice(1)}] = useState(false)`)
      expect(source).toContain(`disabled={${flag}}`)
    }
    expect(source).toContain("revealing || revealLocked ||")
    expect(source).toContain("confirming || confirmLocked ||")
    expect(source).toContain("deliveryConfirming || deliveryLocked ||")
  })

  it("the reveal helper carries attemptsLeft back from the route", () => {
    const guestJobs = readFileSync("lib/guest-jobs.ts", "utf8")
    expect(guestJobs).toContain("attemptsLeft: typeof body?.attemptsLeft === \"number\"")
  })
})
