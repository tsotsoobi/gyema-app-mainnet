// What the sender is told when the last-4 guard refuses them.
//
// Three cards on the public tracker share this guard: showing the delivery
// code, confirming pickup, and confirming delivery. Until now all three
// mapped guard_failed to one sentence and ignored the rest of the response,
// so the tenth wrong attempt read exactly like the first and a locked sender
// was told their own number "does not match" with no way to find out why.
//
// The ceiling (lib/last4-guard.ts) returns attemptsLeft on every refusal and
// guard_locked on the last one. This turns those into words, in one place, so
// the three cards cannot drift apart.
//
// The wording follows the courier card (components/guest-courier-card.tsx),
// which has had a ceiling since August: state what happened, then the count,
// then what to do when there is nothing left to try.

/**
 * Copy for a refused last-4 attempt.
 *
 * `attemptsLeft` is omitted rather than zero when the server did not say, so a
 * missing count reads as a plain refusal instead of announcing a lockout that
 * has not happened.
 */
export function last4ErrorMessage(
  reason: string | undefined,
  attemptsLeft?: number
): string {
  switch (reason) {
    case "guard_locked":
      return (
        "Too many wrong attempts. The code check is locked for this delivery, " +
        "including with the right digits. Contact Gyema dispatch to confirm it another way."
      )

    case "guard_failed": {
      const base = "Those digits do not match the phone this delivery was posted with."
      if (typeof attemptsLeft !== "number") return base
      if (attemptsLeft <= 0) {
        // Belt and braces: a zero here means the next attempt is refused
        // outright, so say so rather than inviting one more.
        return `${base} No tries left, so the code check is now locked. Contact Gyema dispatch.`
      }
      return `${base} ${attemptsLeft} ${attemptsLeft === 1 ? "try" : "tries"} left before it locks.`
    }

    case "not_found":
      return "No delivery with that tracking ID."

    case "no_code":
      return "This delivery does not have a code yet. It is created when a courier accepts."

    case "not_confirmable":
    case "state_changed":
      return "This delivery cannot be confirmed right now. Refreshing status."

    case "network":
      return "Network problem. Please try again."

    default:
      return "Could not complete that. Please try again."
  }
}

/** True when the guard will refuse every further attempt on this delivery. */
export function isLast4Locked(reason: string | undefined, attemptsLeft?: number): boolean {
  return reason === "guard_locked" || (reason === "guard_failed" && attemptsLeft === 0)
}
