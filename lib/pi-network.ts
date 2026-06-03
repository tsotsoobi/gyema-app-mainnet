// Gyema's Pi Network integration.
//
// Key difference from PiLApp's lib/pi-network.ts:
// - PiLApp silently substituted MOCK auth when window.Pi was undefined,
//   which made it look like sign-in worked but actually used fake users.
// - Gyema fails LOUDLY if window.Pi is missing, so you can tell when the
//   SDK didn't load (e.g. running outside Pi Browser, or the script tag
//   in app/layout.tsx didn't fire).
//
// Pi SDK reference: https://github.com/pi-apps/pi-platform-docs

export type PiUser = {
  uid: string
  username: string
  accessToken: string
  // v2: Supabase session tokens issued by /api/auth/verify after Pi auth
  // succeeds. Optional because legacy code paths still produce PiUser
  // without them.
  supabaseAccessToken?: string
  supabaseRefreshToken?: string
  supabaseUserId?: string
}

export type UserRole = "traveller" | "sender"

declare global {
  interface Window {
    Pi?: {
      init: (config: { version: string; sandbox?: boolean }) => void
      authenticate: (
        scopes: string[],
        onIncompletePaymentFound: (payment: PiPayment) => void
      ) => Promise<{ accessToken: string; user: { uid: string; username: string } }>
      createPayment: (
        paymentData: {
          amount: number
          memo: string
          metadata: Record<string, unknown>
        },
        callbacks: {
          onReadyForServerApproval: (paymentId: string) => void
          onReadyForServerCompletion: (paymentId: string, txid: string) => void
          onCancel: (paymentId: string) => void
          onError: (error: Error, payment?: PiPayment) => void
        }
      ) => Promise<PiPayment>
    }
  }
}

export type PiPayment = {
  identifier: string
  amount: number
  memo: string
  metadata: Record<string, unknown>
}

/**
 * True only when the official Pi SDK script has loaded and Pi Browser
 * has injected the Pi global. Use this to gate sign-in UI.
 */
export const isPiSdkAvailable = (): boolean => {
  return typeof window !== "undefined" && typeof window.Pi !== "undefined"
}

/**
 * Authenticate the current Pioneer with Pi Network.
 * Throws an explicit error if the SDK is not available — no silent mock fallback.
 *
 * NOTE: This is the lower-level Pi-only auth. For full sign-in (Pi auth +
 * Supabase session), use signInWithPi() below.
 */
export const authenticateWithPi = async (): Promise<PiUser> => {
  if (!isPiSdkAvailable()) {
    throw new Error(
      "Pi SDK not available. Open Gyema inside Pi Browser to sign in."
    )
  }

  const Pi = window.Pi!
  const scopes = ["username", "payments"]

  const onIncompletePaymentFound = (payment: PiPayment) => {
    // When real escrow is built (v2), this callback notifies the backend
    // that an unfinished payment exists so it can be resolved.
    console.log("[gyema] Incomplete payment found:", payment)
  }

  try {
    const auth = await Pi.authenticate(scopes, onIncompletePaymentFound)
    return {
      uid: auth.user.uid,
      username: auth.user.username,
      accessToken: auth.accessToken,
    }
  } catch (error) {
    console.error("[gyema] Pi authentication failed:", error)
    throw new Error("Sign-in cancelled or failed. Please try again.")
  }
}

/**
 * Full sign-in flow: Pi auth + server-side verification + Supabase session.
 *
 * 1. Authenticates the Pioneer with Pi SDK (Pi Browser handles KYC enforcement).
 * 2. Sends the Pi access token to /api/auth/verify.
 * 3. Server calls Pi Platform /v2/me to verify the token, then provisions
 *    a Supabase Auth user and generates a real Supabase session.
 * 4. Returns a PiUser with Supabase session tokens populated, with uid
 *    set to the canonical pi_uid from the pioneer row (which may differ
 *    from the uid Pi.authenticate() returned this session due to Testnet
 *    uid rotation).
 *
 * Throws on any failure — caller decides whether to retry or surface
 * specific guidance to the Pioneer.
 */
export const signInWithPi = async (): Promise<PiUser> => {
  // Step 1: Pi auth (this throws if SDK unavailable or user cancels).
  const piUser = await authenticateWithPi()

  // Step 2: Server-side verification + Supabase session generation.
  let response: Response
  try {
    response = await fetch("/api/auth/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accessToken: piUser.accessToken }),
    })
  } catch (error) {
    console.error("[gyema] /api/auth/verify network error:", error)
    throw new Error(
      "Could not reach Gyema servers. Check your connection and try again."
    )
  }

  // Step 3: Parse the response.
  let body: {
    ok: boolean
    pioneer?: {
      pi_uid: string
      pi_username: string
      supabase_user_id: string
    }
    session?: {
      access_token: string
      refresh_token: string
    }
    reason?: string
    message?: string
  }
  try {
    body = await response.json()
  } catch {
    console.error("[gyema] /api/auth/verify returned non-JSON response")
    throw new Error("Server returned an unexpected response. Please try again.")
  }

  // Step 4: Handle gate failure.
  if (!body.ok || !body.session || !body.pioneer) {
    console.warn("[gyema] Auth gate rejected:", body.reason, body.message)
    throw new Error(
      body.message || "Sign-in could not be completed. Please try again."
    )
  }

  // Step 5: Success — return the Pioneer with Supabase session attached.
  //
  // CRITICAL: override piUser.uid with body.pioneer.pi_uid. The Pi SDK
  // returns a session-rotated uid (Testnet quirk), while the server
  // returns the CANONICAL pi_uid stored in the pioneer row. All listings
  // and other persisted data are keyed on the canonical uid, so the
  // frontend must use the canonical value for queries to resolve correctly.
  return {
    ...piUser,
    uid: body.pioneer.pi_uid,
    supabaseAccessToken: body.session.access_token,
    supabaseRefreshToken: body.session.refresh_token,
    supabaseUserId: body.pioneer.supabase_user_id,
  }
}

/**
 * True if this user is a guest session (Continue-as-Guest path), not an
 * authenticated Pioneer. Guests can browse and check tracking IDs but
 * cannot create or modify listings — posting requires a Pi identity so
 * every listing is traceable to a real Pioneer.
 */
export const isGuest = (user: PiUser): boolean => {
  return user.uid.startsWith("guest-")
}

/**
 * Full sign-in + persistence flow used by both the initial Sign-In screen
 * and any in-app upgrade points (e.g. a guest tapping "Sign in to post").
 *
 * Runs Pi auth + Supabase session provisioning, then writes the user to
 * in-memory and localStorage. Returns the fully-hydrated PiUser. Throws
 * with a user-presentable message on any failure.
 *
 * Callers are responsible for updating their own React state with the
 * returned user — this helper does not know about component state.
 */
export const signInAndPersist = async (): Promise<PiUser> => {
  const user = await signInWithPi()

  if (user.supabaseAccessToken && user.supabaseRefreshToken) {
    setSupabaseSession({
      accessToken: user.supabaseAccessToken,
      refreshToken: user.supabaseRefreshToken,
    })
  } else {
    console.error(
      "[pi-network] signInWithPi resolved without Supabase session tokens",
      {
        hasAccess: !!user.supabaseAccessToken,
        hasRefresh: !!user.supabaseRefreshToken,
      }
    )
  }

  setStoredUser(user)
  return user
}

/**
 * Silent session restore for cold app mount.
 *
 * When a user returns to the app via a fresh tab (cold Pi Ecosystem entry),
 * localStorage has their PiUser but inMemorySession is null — meaning the
 * app thinks they're signed in but has no Supabase session to authenticate
 * backend requests. POSTs fail with generic network errors.
 *
 * This function fixes that by exchanging the stored Pi accessToken for a
 * fresh Supabase session via /api/auth/verify. The verify route is
 * idempotent: for existing pioneers it just returns their session; for
 * users whose Pi token has expired it returns 401, signalling we need a
 * fresh Pi.authenticate().
 *
 * SAFETY: The fetch is wrapped in a 5-second AbortController timeout.
 * Without this, a hung verify call (e.g. preview deployment missing env
 * vars, Pi Platform slow response, or network blip) would leave the
 * mount effect awaiting forever and the spinner showing forever. With
 * the timeout, worst case is "restore aborts after 5s, user sees SignIn
 * screen" — the same UX as a token-expired flow.
 *
 * Returns the fully-hydrated PiUser on success (with Supabase session
 * populated in-memory), or null if restore failed. Callers should treat
 * null as "stored session is no longer valid" and decide whether to clear
 * localStorage or prompt a fresh sign-in.
 */
export const restoreSessionFromStorage = async (): Promise<PiUser | null> => {
  const stored = getStoredUser()
  if (!stored) return null

  // Guest sessions don't need verify — they're local-only.
  if (isGuest(stored)) return stored

  // Real Pioneer session — exchange the stored Pi accessToken for a
  // fresh Supabase session.
  if (!stored.accessToken) {
    console.warn("[pi-network] Stored user has no accessToken, cannot restore")
    return null
  }

  // 5-second timeout via AbortController. Caps the worst-case spinner
  // delay on cold mount when verify hangs (e.g. env misconfig on a
  // preview deployment, Pi Platform slow response, transient network
  // blip). Without this, the await would sit forever and the spinner
  // would never resolve. With the timeout, worst case is "restore
  // aborts after 5s, user sees SignIn screen."
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 5000)

  try {
    const response = await fetch("/api/auth/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accessToken: stored.accessToken }),
      signal: controller.signal,
    })
    clearTimeout(timeoutId)

    const body = (await response.json()) as {
      ok: boolean
      pioneer?: {
        pi_uid: string
        pi_username: string
        supabase_user_id: string
      }
      session?: {
        access_token: string
        refresh_token: string
      }
      reason?: string
    }

    if (!body.ok || !body.session || !body.pioneer) {
      console.warn("[pi-network] Session restore rejected:", body.reason)
      return null
    }

    // Restore in-memory Supabase session.
    setSupabaseSession({
      accessToken: body.session.access_token,
      refreshToken: body.session.refresh_token,
    })

    // Return the canonical user shape, matching signInWithPi.
    const restored: PiUser = {
      uid: body.pioneer.pi_uid,
      username: body.pioneer.pi_username,
      accessToken: stored.accessToken,
      supabaseAccessToken: body.session.access_token,
      supabaseRefreshToken: body.session.refresh_token,
      supabaseUserId: body.pioneer.supabase_user_id,
    }

    // Persist the canonical user back to localStorage (the canonical
    // pi_uid may differ from what was stored if rotation happened).
    setStoredUser(restored)

    return restored
  } catch (error) {
    clearTimeout(timeoutId)
    if (error instanceof Error && error.name === "AbortError") {
      console.warn("[pi-network] Session restore timed out after 5s")
    } else {
      console.error("[pi-network] Session restore network error:", error)
    }
    return null
  }
}

// In-memory Supabase session storage.
//
// Deliberately NOT in localStorage — leaked tokens could be read by any
// XSS or third-party script. In-memory means the tokens are gone when
// the tab closes, requiring fresh sign-in. This is a security improvement
// over v1's localStorage-backed user object that included accessToken.
let inMemorySession: {
  accessToken: string
  refreshToken: string
} | null = null

export const setSupabaseSession = (
  session: { accessToken: string; refreshToken: string } | null
) => {
  inMemorySession = session
}

export const getSupabaseSession = () => {
  return inMemorySession
}

// Generalized user-to-app (U2A) payment. Drives the full Pi payment
// lifecycle: SDK createPayment -> /api/payments/approve -> SDK completion
// -> /api/payments/complete. Resolves with { paymentId, txid } after the
// server confirms completion; rejects on cancel, error, or approval fail.
//
// This is the exact path the checklist test used, now parameterized so
// real charges (the service fee) reuse the same proven plumbing.
export const createU2APayment = async (input: {
  amount: number
  memo: string
  metadata: Record<string, unknown>
}): Promise<{ paymentId: string; txid: string }> => {
  if (!isPiSdkAvailable()) {
    throw new Error(
      "Pi SDK not available. Open Gyema inside Pi Browser to pay."
    )
  }

  const Pi = window.Pi!

  return new Promise<{ paymentId: string; txid: string }>((resolve, reject) => {
    Pi.createPayment(
      {
        amount: input.amount,
        memo: input.memo,
        metadata: input.metadata,
      },
      {
        onReadyForServerApproval: async (paymentId: string) => {
          console.log("[gyema] Payment ready for server approval:", paymentId)
          try {
            const res = await fetch("/api/payments/approve", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ paymentId }),
            })
            if (!res.ok) {
              const errText = await res.text()
              console.error("[gyema] Approve endpoint failed:", errText)
              reject(new Error("Server approval failed"))
            }
          } catch (err) {
            console.error("[gyema] Approve fetch error:", err)
            reject(err instanceof Error ? err : new Error("Approve fetch failed"))
          }
        },
        onReadyForServerCompletion: async (paymentId: string, txid: string) => {
          console.log("[gyema] Payment completed by SDK:", paymentId, txid)
          try {
            const res = await fetch("/api/payments/complete", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ paymentId, txid }),
            })
            if (!res.ok) {
              const errText = await res.text()
              console.error("[gyema] Complete endpoint failed:", errText)
              reject(new Error("Server completion failed"))
              return
            }
            resolve({ paymentId, txid })
          } catch (err) {
            console.error("[gyema] Complete fetch error:", err)
            reject(err instanceof Error ? err : new Error("Complete fetch failed"))
          }
        },
        onCancel: (paymentId: string) => {
          console.log("[gyema] Payment cancelled:", paymentId)
          reject(new Error("Payment cancelled."))
        },
        onError: (error: Error, payment?: PiPayment) => {
          console.error("[gyema] Payment error:", error, payment)
          reject(error)
        },
      }
    ).catch(reject)
  })
}

// Checklist test payment — now a thin wrapper over createU2APayment,
// preserving the original behavior (0.001 testnet π, checklist metadata)
// so the debug card on the Profile tab keeps working unchanged.
export const createTestPayment = async (): Promise<string> => {
  const { paymentId } = await createU2APayment({
    amount: 0.001,
    memo: "Gyema test transaction",
    metadata: { type: "checklist_test", app: "gyema" },
  })
  return paymentId
}

// Local-storage helpers for role persistence between sessions.
// (Listings themselves are also persisted locally for v1 — see lib/listings.ts.)

const ROLE_KEY = "gyema-role"
const USER_KEY = "gyema-user"

export const getStoredRole = (): UserRole | null => {
  if (typeof window === "undefined") return null
  const v = localStorage.getItem(ROLE_KEY)
  return v === "traveller" || v === "sender" ? v : null
}

export const setStoredRole = (role: UserRole) => {
  if (typeof window !== "undefined") {
    localStorage.setItem(ROLE_KEY, role)
  }
}

export const getStoredUser = (): PiUser | null => {
  if (typeof window === "undefined") return null
  try {
    const raw = localStorage.getItem(USER_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as PiUser
    // SECURITY: never read Supabase session tokens from localStorage.
    // If a previous version of the app stored them, drop them on read.
    return {
      uid: parsed.uid,
      username: parsed.username,
      accessToken: parsed.accessToken,
      // supabaseAccessToken/supabaseRefreshToken intentionally omitted
      // — these come only from in-memory after a fresh sign-in.
    }
  } catch {
    return null
  }
}

export const setStoredUser = (user: PiUser | null) => {
  if (typeof window === "undefined") return
  if (user) {
    // SECURITY: strip Supabase session tokens before persisting.
    // Only uid, username, accessToken go to localStorage. Session
    // tokens stay in-memory only.
    const persistable = {
      uid: user.uid,
      username: user.username,
      accessToken: user.accessToken,
    }
    localStorage.setItem(USER_KEY, JSON.stringify(persistable))
  } else {
    localStorage.removeItem(USER_KEY)
  }
}

export const clearStoredAuth = () => {
  if (typeof window !== "undefined") {
    localStorage.removeItem(ROLE_KEY)
    localStorage.removeItem(USER_KEY)
  }
  // Also clear in-memory session.
  setSupabaseSession(null)
}
