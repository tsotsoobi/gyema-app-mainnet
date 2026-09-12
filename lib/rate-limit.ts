import { Ratelimit } from "@upstash/ratelimit"
import { Redis } from "@upstash/redis"
import { ipAddress } from "@vercel/functions"
import { createHash } from "crypto"

// Rate limiting for the routes a stranger can reach, in one file.
//
// WHY A SHARED STORE AND NOT A MAP
//
// Vercel functions are stateless and horizontally scaled. A counter in module
// scope is per instance, so a caller spread across ten cold starts gets ten
// budgets, and the limit that looked like 6 an hour is 60. Upstash Redis over
// its REST API is the shared store: one round trip per checked request, no
// connection pool to keep warm, and it works from the Node runtime these
// routes already pin.
//
// ONE DATABASE SERVES BOTH NETWORKS, SO EVERY KEY IS NAMESPACED
//
// Testnet and Mainnet point at the same Upstash database. Without a namespace
// they would share every window: a scripted flood against Testnet, which is
// publicly discoverable and which strangers have already found, would exhaust
// the window that a real sender on Mainnet needs. The namespace is built in
// networkNamespace() below, and the part that makes a collision impossible is
// the Supabase project ref rather than the human-readable label. The reasoning
// is written out there because it is the one thing in this file that has to be
// right for the two networks to stay separate.
//
// WHAT THIS CANNOT DO
//
// The identifier is an IP address, and in Ghana a large share of mobile
// traffic leaves through carrier-grade NAT, so one address can stand for a
// neighbourhood. Every per-IP number below is therefore set generously, and
// the tight limit on the one route that matters is keyed on the sender's own
// phone number instead, which is per person and immune to NAT. An attacker
// who can rotate addresses is not stopped by any of this; Turnstile
// (lib/turnstile.ts) is the control that does not depend on the network path.

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * True when this deployment has somewhere to keep counters.
 *
 * Absent credentials mean the limiter is OFF and every route runs unlimited.
 * That is deliberate and it is not the same thing as a Redis failure: local
 * development, and any deployment where these variables were never set, must
 * keep working. A configured limiter that then errors is a different case and
 * each route decides it separately (see FailureMode).
 */
export function limiterConfigured(): boolean {
  return Boolean(
    process.env.UPSTASH_REDIS_REST_URL?.trim() &&
      process.env.UPSTASH_REDIS_REST_TOKEN?.trim()
  )
}

/**
 * The key prefix for this deployment, and the reason it is shaped this way.
 *
 * Two parts. The label ("testnet" or "mainnet") is for a human reading keys in
 * the Upstash console and is derived from NEXT_PUBLIC_IS_TESTNET, which is a
 * build-time bake that Mainnet leaves unset. The ref is the Supabase project
 * ref taken from NEXT_PUBLIC_SUPABASE_URL, and it is the part that carries the
 * guarantee.
 *
 * The label alone would not be safe. If someone ever forgot to set
 * NEXT_PUBLIC_IS_TESTNET on Testnet, both deployments would read "mainnet" and
 * silently share every window, which is the exact failure this namespace
 * exists to prevent, and nothing would look wrong. The two networks point at
 * different Supabase projects by definition, so the ref cannot collide unless
 * the app is already talking to the wrong database, in which case a shared
 * rate-limit window is the smallest of the problems.
 */
export function networkNamespace(): string {
  const label = process.env.NEXT_PUBLIC_IS_TESTNET === "true" ? "testnet" : "mainnet"
  const ref = supabaseProjectRef()
  return `gyema:${label}:${ref}`
}

/**
 * The project ref out of https://<ref>.supabase.co.
 *
 * Not a secret: it is the host half of the public Supabase URL that every
 * browser session already sends. Falls back to "unconfigured" rather than
 * throwing, because a deployment with no Supabase URL cannot serve a request
 * anyway and a throw here would turn a clear failure into a confusing one.
 */
function supabaseProjectRef(): string {
  const raw = process.env.NEXT_PUBLIC_SUPABASE_URL
  if (!raw) return "unconfigured"
  try {
    const host = new URL(raw).hostname
    const first = host.split(".")[0]
    return first && first !== "" ? first : "unconfigured"
  } catch {
    return "unconfigured"
  }
}

// ---------------------------------------------------------------------------
// The limits
// ---------------------------------------------------------------------------

/**
 * What happens when the limiter is configured but Redis does not answer.
 *
 * "closed" refuses the request. "open" allows it and logs a warning. The
 * choice is per route and each one is argued at its entry in LIMITS, because
 * the right answer depends entirely on what else is guarding that route and
 * on what a refusal costs the person on the other end.
 */
export type FailureMode = "open" | "closed"

export type LimitSpec = {
  /** Requests allowed per window. */
  limit: number
  /** Window length, in the duration syntax @upstash/ratelimit parses. */
  window: `${number} ${"s" | "m" | "h" | "d"}`
  /** What a Redis error does. */
  onError: FailureMode
}

/**
 * Every limit in the app, with the number derived from what the route does
 * rather than rounded to something that looks tidy.
 *
 * The buckets are named, not per route, because two routes that are the same
 * action by the same person should share one budget. The three last-4 routes
 * are one handshake and share one bucket for that reason.
 */
export const LIMITS = {
  /**
   * Guest job creation, per IP. The LOOSE half of a two-key limit.
   *
   * Twenty an hour from one address. This is deliberately not tight: the guest
   * send page is the one surface reached from an ordinary mobile browser
   * rather than from Pi Browser, and Ghanaian mobile data is heavily
   * NAT-shared, so a tight per-IP number here would refuse a real sender
   * because a stranger on the same carrier posted first. Twenty is above any
   * plausible cluster of real senders behind one address in an hour, and a
   * script that rotates sender phone numbers to dodge the tight key still
   * meets it.
   */
  guest_create_ip: { limit: 20, window: "1 h", onError: "closed" },

  /**
   * Guest job creation, per sender phone. The TIGHT half.
   *
   * Four an hour. A sender posting one delivery, mistyping something and
   * posting again, then posting a second parcel, has used three. Four is one
   * more than that. This key is per person rather than per network path, so
   * NAT does not apply to it, which is why the tight limit lives here and not
   * on the address.
   *
   * Checked after body validation, since the phone number is not known before
   * it. The per-IP key above is checked first, before parsing, so a flood of
   * malformed bodies is still limited.
   */
  guest_create_phone: { limit: 4, window: "1 h", onError: "closed" },

  /**
   * The Pi sign-in gate, per IP.
   *
   * Forty per five minutes. Each call is a Pi Platform round trip plus, on a
   * valid token, a Supabase user lookup, a password derivation and a session
   * mint, so this is the most expensive unauthenticated route in the app and
   * an invalid token still costs the Pi Platform hop.
   *
   * Forty rather than something tighter because a Pioneer legitimately hits
   * this on every app open: Pi Browser caches hard, restoreSessionFromStorage
   * calls it on load, and reopening the app repeatedly while testing is normal
   * behaviour. Forty in five minutes is one sign-in every seven seconds
   * sustained, which no person reaches by hand and which cuts a scripted
   * token-stuffing loop by orders of magnitude.
   */
  auth_verify: { limit: 40, window: "5 m", onError: "open" },

  /**
   * The public tracker lookup, per IP.
   *
   * A hundred and twenty per ten minutes. Nothing polls: every call is a
   * person pressing Track, opening a deep link, or the re-lookup that runs
   * after a confirmation. A sender refreshing while they wait for a courier is
   * the high-water mark for real use and it is nowhere near twelve a minute.
   *
   * What this is actually for is enumeration. A GYM- ID is six characters and
   * is the entry ticket to every public guest route, so scanning for valid
   * ones is the front half of any attack on the sender-side guards. Twelve
   * lookups a minute against a space of roughly sixteen million makes that
   * pointless from one address without inconveniencing anybody.
   *
   * This used to say the ID was minted with Math.random, which was finding
   * S-17 and was the reason the number here mattered more than it looked.
   * Both rails now mint from randomBytes, so the ID is no longer predictable
   * and this limit is defence in depth rather than the thing standing between
   * a guesser and a valid code.
   */
  guest_track: { limit: 120, window: "10 m", onError: "open" },

  /**
   * The open jobs board, per IP.
   *
   * Sixty per ten minutes. A courier refreshing the board to catch a new job
   * is the normal case and it is bursty. The payload is sanitized and carries
   * no phone, landmark or name, so the only thing a limit protects here is the
   * database read itself, and being generous costs nothing.
   */
  guest_open: { limit: 60, window: "10 m", onError: "open" },

  /**
   * All three sender-side last-4 routes, per IP, sharing ONE bucket.
   *
   * A hundred and twenty an hour. One complete handshake is about six calls:
   * reveal the code, confirm pickup, confirm delivery, plus a mistyped attempt
   * or two. A hundred and twenty is therefore roughly twenty senders' worth of
   * traffic from one address in an hour, which leaves plenty of room under
   * NAT.
   *
   * It is loose ON PURPOSE, because it is not the control. The control is the
   * permanent ten-attempt ceiling per job in lib/last4-guard.ts, which lives
   * in Postgres, counts only wrong answers, and never decays. A window here
   * cannot improve on that for a single job. What it does add is friction
   * against spraying one guess each across many tracking IDs, which the
   * per-job counter cannot see.
   *
   * The worst false positive in the whole application is a sender standing at
   * a door who cannot confirm their delivery, so the number is set where a
   * real person will never meet it.
   */
  guest_last4: { limit: 120, window: "1 h", onError: "open" },
} satisfies Record<string, LimitSpec>

export type LimitName = keyof typeof LIMITS

// ---------------------------------------------------------------------------
// The limiter
// ---------------------------------------------------------------------------

/**
 * How long to wait for Redis before giving up on it.
 *
 * A hung REST call would otherwise hold the function open until the platform
 * timeout, turning a slow dependency into a slow app. Two hundred and fifty
 * milliseconds is well past a healthy Upstash round trip from Vercel and short
 * enough that a person does not feel it. A timeout is treated exactly like any
 * other Redis error, so the route's own FailureMode decides what happens.
 */
const REDIS_TIMEOUT_MS = 250

let redis: Redis | null = null
const limiters = new Map<LimitName, Ratelimit>()

/**
 * Built on first use, never at module load.
 *
 * On Vercel a module-level construction runs during the build, where these
 * variables are not set, so a throw there would fail the build for a reason
 * that has nothing to do with the build.
 */
function limiterFor(name: LimitName): Ratelimit {
  if (!redis) {
    redis = Redis.fromEnv()
  }
  const existing = limiters.get(name)
  if (existing) return existing

  const spec = LIMITS[name]
  const limiter = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(spec.limit, spec.window),
    // The namespace and the bucket name together. Every key this deployment
    // writes begins with the namespace, so the two networks cannot meet.
    prefix: `${networkNamespace()}:${name}`,
    // Analytics writes an extra key per request for the Upstash dashboard.
    // Off: it doubles the write cost of every limited request to populate a
    // dashboard nobody has agreed to read.
    analytics: false,
    // An in-process cache of identifiers already known to be over the limit
    // for this window. A warm instance answers a repeat offender without a
    // Redis round trip. Per instance and therefore best-effort, which is fine:
    // it can only skip work for a caller who was already going to be refused.
    ephemeralCache: new Map(),
  })
  limiters.set(name, limiter)
  return limiter
}

export type LimitVerdict =
  /** Allowed. Either under the limit, or the limiter is off or failed open. */
  | { ok: true }
  /** Refused. `retryAfterSeconds` is what the caller should be told to wait. */
  | { ok: false; reason: "rate_limited" | "limiter_unavailable"; retryAfterSeconds: number }

/**
 * Check one limit for one identifier.
 *
 * Returns ok when the limiter is not configured at all, so a deployment
 * without Upstash credentials behaves exactly as it did before this file
 * existed. When it IS configured and Redis then fails, the spec's onError
 * decides, and either way the failure is logged with the bucket name so a
 * Redis outage is visible in the Vercel log rather than silent.
 *
 * The identifier is never a raw phone number: see phoneIdentifier.
 */
export async function checkLimit(
  name: LimitName,
  identifier: string
): Promise<LimitVerdict> {
  if (!limiterConfigured()) return { ok: true }

  const spec = LIMITS[name]
  try {
    const result = await withTimeout(limiterFor(name).limit(identifier))
    if (result.success) return { ok: true }
    return {
      ok: false,
      reason: "rate_limited",
      retryAfterSeconds: secondsUntil(result.reset),
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[rate-limit] ${name} unavailable, failing ${spec.onError}:`, message)
    if (spec.onError === "open") return { ok: true }
    return { ok: false, reason: "limiter_unavailable", retryAfterSeconds: 30 }
  }
}

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`redis did not answer in ${REDIS_TIMEOUT_MS}ms`)),
      REDIS_TIMEOUT_MS
    )
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

/** Whole seconds until a reset timestamp, floored at one. */
function secondsUntil(resetMs: number): number {
  return Math.max(1, Math.ceil((resetMs - Date.now()) / 1000))
}

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

/**
 * The caller's address, as the platform reports it.
 *
 * ipAddress() from @vercel/functions reads x-real-ip, which Vercel Proxy sets
 * on the way in. Reading that helper rather than parsing x-forwarded-for by
 * hand matters: x-forwarded-for is a list a client can prepend entries to, and
 * picking the wrong element from it hands the caller control of their own
 * rate-limit key.
 *
 * Off Vercel there is no proxy and no header, which is the local development
 * case. Everything without an address shares the "noip" bucket. That is the
 * honest behaviour: it means one shared budget for all of them rather than an
 * unlimited one each, and locally the limiter is switched off anyway because
 * the Upstash variables are not set.
 */
export function ipIdentifier(request: Request): string {
  const fromVercel = ipAddress(request)
  if (fromVercel) return fromVercel

  // Only as a fallback, and only the first entry, which is the client as the
  // outermost proxy saw it. Used when something other than Vercel is in front.
  const forwarded = request.headers.get("x-forwarded-for")
  const first = forwarded?.split(",")[0]?.trim()
  return first && first !== "" ? first : "noip"
}

/**
 * A stable identifier for a phone number that is not the phone number.
 *
 * Normalised to digits first, so 0244123456 and +233244123456 written by the
 * same person do not get two budgets purely because of how they typed it.
 *
 * Hashed because a rate-limit key is not a place to keep a customer's phone
 * number: keys are visible to anyone with the Upstash console and they end up
 * in support screenshots. This is key hygiene and NOT encryption, and the
 * difference is worth stating plainly: a ten-digit space can be exhausted
 * against this hash in seconds by anyone who wants to. It keeps the number out
 * of casual view; it would not withstand somebody trying.
 */
export function phoneIdentifier(phone: string): string {
  const digits = phone.replace(/[^0-9]/g, "")
  // Compare on the national part: a number stored with and without the +233
  // country code is one person, and the trailing nine digits are what both
  // forms share.
  const national = digits.length > 9 ? digits.slice(-9) : digits
  return createHash("sha256").update(national).digest("hex").slice(0, 16)
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

/**
 * The headers that go out with a refusal.
 *
 * Retry-After is the whole point: a client that is told to wait knows how
 * long, and the send page and the tracker both put that number in front of the
 * person rather than showing an unexplained failure.
 *
 * There is no helper here that builds the body, deliberately. The three
 * families of route in this app answer with three different shapes
 * ({ ok, reason }, { error, reason }, { ok, reason, message }) and the UI
 * branches on them. A refusal is written at each call site in that route's own
 * shape, for the same reason lib/schemas.ts maps its failures back to the
 * reason string the route already used: the control moved, the contract did
 * not.
 */
export function retryAfterHeaders(retryAfterSeconds: number): Record<string, string> {
  return { "Retry-After": String(retryAfterSeconds) }
}
