import { describe, it, expect, vi, beforeEach } from "vitest"
import { AdminMock } from "./helpers/admin-mock"
import { resolveCaller, callerRefusalResponse } from "@/lib/route-auth"

// The 13 September Mainnet incident, as a test.
//
// A Pioneer posted a trip at 07:44:07, was refused 401 at 07:45:16, and posted
// a package at 07:46:34, on one token with no re-authentication in between.
// auth_events showed a single verify at 07:43:14 taking 1481ms, so the token
// could not have changed, and nothing refreshes it because the authed client
// is built with autoRefreshToken false.
//
// The cause was one branch:
//
//     const { data, error } = await admin.auth.getUser(accessToken)
//     if (error || !data?.user) return null
//
// auth-js catches inside getUser and RETURNS any AuthError rather than
// throwing it. AuthRetryableFetchError, raised for a transient fetch issue,
// extends AuthError. So a network blip, a GoTrue 5xx and a 429 all landed on
// the same branch as a genuinely expired token, and every one of them told the
// Pioneer they were not signed in.
//
// These assert the classification, because that is the thing that was wrong.

const mock = new AdminMock()

beforeEach(() => {
  mock.calls = []
  mock.results = []
})

/** Shape an error the way auth-js would, for cases the shared mock lacks. */
function authError(fields: Record<string, unknown>) {
  mock.user = { data: null, error: { __isAuthError: true, ...fields } }
}

describe("a caller who is genuinely not signed in", () => {
  it("refuses a missing token without calling out to auth at all", async () => {
    mock.asPioneer()
    const verdict = await resolveCaller(mock.client() as never, undefined)
    expect(verdict).toMatchObject({ ok: false, reason: "no_token", status: 401 })
  })

  it("refuses a non-string token", async () => {
    const verdict = await resolveCaller(mock.client() as never, { token: "nice try" })
    expect(verdict).toMatchObject({ ok: false, reason: "no_token", status: 401 })
  })

  it("refuses a token GoTrue rejected, as 401", async () => {
    mock.asAnonymousFailure()
    const verdict = await resolveCaller(mock.client() as never, "expired")
    expect(verdict).toMatchObject({ ok: false, reason: "bad_token", status: 401 })
  })

  it("refuses a session with no Pi identity in app_metadata", async () => {
    mock.asForgedMetadataOnly()
    const verdict = await resolveCaller(mock.client() as never, "token")
    expect(verdict).toMatchObject({ ok: false, reason: "no_claim", status: 401 })
  })

  it("resolves a real Pioneer from app_metadata and never user_metadata", async () => {
    mock.asPioneer("pi-uid-1", "pioneer_one")
    const verdict = await resolveCaller(mock.client() as never, "token")
    expect(verdict).toMatchObject({
      ok: true,
      caller: { pi_uid: "pi-uid-1", pi_username: "pioneer_one" },
    })
  })
})

describe("auth being unreachable is NOT the caller's fault", () => {
  it("classifies a retryable fetch error as transient", async () => {
    mock.asAuthUnavailable()
    const verdict = await resolveCaller(mock.client() as never, "a-good-token")
    expect(verdict).toMatchObject({ ok: false, reason: "auth_unavailable", status: 503 })
  })

  it("classifies a rate limit as transient", async () => {
    mock.asAuthRateLimited()
    const verdict = await resolveCaller(mock.client() as never, "a-good-token")
    expect(verdict).toMatchObject({ ok: false, reason: "auth_unavailable", status: 503 })
  })

  it("classifies every 5xx as transient", async () => {
    for (const status of [500, 502, 503, 504]) {
      authError({ name: "AuthApiError", status, message: "upstream" })
      const verdict = await resolveCaller(mock.client() as never, "a-good-token")
      expect(verdict, String(status)).toMatchObject({ reason: "auth_unavailable", status: 503 })
    }
  })

  it("classifies an error with no status as transient, which is the safe default", async () => {
    // An error that reached us without a reply from GoTrue is not a verdict
    // about the token. A real rejection always carries a status, so defaulting
    // the unclassifiable case the other way would recreate the original bug:
    // telling a Pioneer with a good session to sign in again.
    authError({ name: "AuthUnknownError", message: "socket hang up" })
    const verdict = await resolveCaller(mock.client() as never, "a-good-token")
    expect(verdict).toMatchObject({ reason: "auth_unavailable", status: 503 })
  })
})

describe("the line between them", () => {
  // The dangerous direction of this mistake is the opposite one: classifying a
  // genuinely invalid session as transient means a client retries forever
  // instead of asking the Pioneer to sign in. These pin that line.
  it("keeps 400, 401 and 403 on the bad-token side", async () => {
    for (const status of [400, 401, 403]) {
      authError({ name: "AuthApiError", status, message: "bad jwt" })
      const verdict = await resolveCaller(mock.client() as never, "expired")
      expect(verdict, String(status)).toMatchObject({ reason: "bad_token", status: 401 })
    }
  })

  it("never resolves a caller on any failure, whichever side it falls", async () => {
    for (const setup of ["asAnonymousFailure", "asAuthUnavailable", "asAuthRateLimited"] as const) {
      mock[setup]()
      const verdict = await resolveCaller(mock.client() as never, "token")
      expect(verdict.ok, setup).toBe(false)
    }
  })
})

describe("what the log says", () => {
  it("records the name, status and code, and the classification", async () => {
    const lines: string[] = []
    const spy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "))
    })
    try {
      mock.asAuthRateLimited()
      await resolveCaller(mock.client() as never, "token")
    } finally {
      spy.mockRestore()
    }
    const joined = lines.join(" ")
    expect(joined).toContain("name=AuthApiError")
    expect(joined).toContain("status=429")
    expect(joined).toContain("code=over_request_rate_limit")
    expect(joined).toContain("classified=transient")
  })

  it("never logs the token", async () => {
    const lines: string[] = []
    const spy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "))
    })
    try {
      mock.asAnonymousFailure()
      await resolveCaller(mock.client() as never, "a-secret-session-token")
    } finally {
      spy.mockRestore()
    }
    expect(lines.join(" ")).not.toContain("a-secret-session-token")
  })
})

describe("the response a route returns", () => {
  it("keeps answering unauthorized on a 401, because the UI branches on it", async () => {
    const res = callerRefusalResponse({ ok: false, reason: "bad_token", status: 401 })
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ ok: false, reason: "unauthorized" })
  })

  it("answers auth_unavailable on a 503, which is a new and different thing", async () => {
    const res = callerRefusalResponse({ ok: false, reason: "auth_unavailable", status: 503 })
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ ok: false, reason: "auth_unavailable" })
  })

  it("collapses all three 401 reasons to one answer, so none of them probes", async () => {
    // A caller learns only that they are not signed in as someone this route
    // will act for. Which of the three it was stays in the log.
    for (const reason of ["no_token", "bad_token", "no_claim"] as const) {
      const res = callerRefusalResponse({ ok: false, reason, status: 401 })
      expect(await res.json()).toMatchObject({ reason: "unauthorized" })
    }
  })
})
