// Cloudflare Turnstile: the bot check on the one form a stranger can submit.
//
// WHY THIS AND NOT A TIGHTER RATE LIMIT
//
// Rate limiting keys on an IP address, and an address is the one thing an
// attacker with a proxy pool changes for free. It is also the thing a real
// sender in Accra shares with a whole neighbourhood through carrier-grade NAT.
// So the per-IP limit on guest creation is set generously (lib/rate-limit.ts)
// and this carries the weight instead: a challenge is per browser, per person,
// and does not care which address the request came from.
//
// OFF UNLESS BOTH KEYS ARE SET
//
// isTurnstileConfigured() requires the site key AND the secret key. Either one
// missing means the check does not run, the widget does not render, and the
// route behaves exactly as it did before this file existed.
//
// That fail-open default is deliberate and it is the opposite of the usual
// advice, so here is the argument. The site key is NEXT_PUBLIC_ and therefore
// baked at build time: setting it requires a redeploy. If a half-configured
// deployment refused every guest post, the failure would be a silent outage of
// the only unauthenticated write in the app, and the person who notices is a
// sender who cannot post a delivery. A missing bot check is a smaller problem
// than a guest rail that is down, and the rate limiter is still in front of the
// route either way.
//
// The verification call itself does NOT fail open. Once the check is switched
// on, a token that Cloudflare rejects, or a siteverify call that errors, is a
// refusal. See verifyTurnstileToken.
//
// PI BROWSER IS UNTESTED
//
// The widget renders in an iframe from challenges.cloudflare.com, and this app
// runs inside Pi Browser, which is itself a framing proxy. The CSP names the
// Cloudflare origin (lib/csp.ts) so the policy is not the blocker, but whether
// the challenge renders and solves inside Pi Browser has not been observed.
// That is the check to run on Testnet before either key is ever set on
// Mainnet, and it is the reason the keys are the switch rather than a code
// change.

/** Where a token is verified. Cloudflare's documented endpoint. */
const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify"

/** How long to wait for Cloudflare before treating the check as failed. */
const SITEVERIFY_TIMEOUT_MS = 4000

/**
 * True when this deployment has both halves of the Turnstile configuration.
 *
 * Both, not either. A site key with no secret renders a widget whose token
 * nothing checks, which is worse than no widget: it looks like a control and
 * is not one. A secret with no site key refuses every post, because no client
 * can produce a token.
 */
export function isTurnstileConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY?.trim() &&
      process.env.TURNSTILE_SECRET_KEY?.trim()
  )
}

export type TurnstileVerdict =
  | { ok: true }
  | { ok: false; reason: "missing_token" | "rejected" | "unavailable" }

/**
 * Ask Cloudflare whether this token is a real solved challenge.
 *
 * The remote address is passed when known, which lets Cloudflare check that
 * the token is being redeemed from the same place it was issued. It is
 * optional in their API and omitted rather than guessed when the platform did
 * not give us one.
 *
 * A token is single use. Replaying one returns a timeout-or-duplicate error
 * code from Cloudflare and is refused here, which is the property that stops a
 * captured token being reused for a flood.
 *
 * FAILS CLOSED, unlike the configuration check above. Once an operator has set
 * both keys they have said this check must run, and an unreachable Cloudflare
 * is not permission to skip it. The cost of that choice is stated where it
 * lands: if siteverify is down, guest posting is down, and the way back is to
 * unset one key and redeploy.
 */
export async function verifyTurnstileToken(
  token: string | null | undefined,
  remoteIp?: string
): Promise<TurnstileVerdict> {
  if (!token || token.trim() === "") {
    return { ok: false, reason: "missing_token" }
  }

  const secret = process.env.TURNSTILE_SECRET_KEY
  if (!secret) {
    // Unreachable through the routes, which check isTurnstileConfigured first.
    // Refusing rather than allowing keeps that true for any future caller.
    console.error("[turnstile] verify called with no TURNSTILE_SECRET_KEY")
    return { ok: false, reason: "unavailable" }
  }

  const form = new URLSearchParams()
  form.set("secret", secret)
  form.set("response", token)
  if (remoteIp && remoteIp !== "noip") {
    form.set("remoteip", remoteIp)
  }

  try {
    const response = await fetch(SITEVERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
      signal: AbortSignal.timeout(SITEVERIFY_TIMEOUT_MS),
    })
    if (!response.ok) {
      console.warn("[turnstile] siteverify HTTP", response.status)
      return { ok: false, reason: "unavailable" }
    }
    const body = (await response.json()) as {
      success?: boolean
      "error-codes"?: string[]
    }
    if (body?.success === true) return { ok: true }

    // The error codes say why a token was refused (expired, already redeemed,
    // wrong secret) and none of them contain anything about the person, so
    // logging them is safe and is the only way to tell a misconfigured secret
    // apart from a real bot.
    console.warn("[turnstile] rejected:", (body?.["error-codes"] ?? []).join(","))
    return { ok: false, reason: "rejected" }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn("[turnstile] siteverify unavailable:", message)
    return { ok: false, reason: "unavailable" }
  }
}
