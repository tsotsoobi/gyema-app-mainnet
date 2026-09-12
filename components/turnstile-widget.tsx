"use client"

import { useCallback, useEffect, useRef } from "react"

// The Cloudflare Turnstile widget, rendered explicitly.
//
// WHY EXPLICIT RENDERING RATHER THAN THE AUTOMATIC MODE
//
// Turnstile's automatic mode scans the document for a div with a magic class
// and renders into whatever it finds. That works on a static page. This form
// is a React tree with three steps, the widget lives on the second, and it
// mounts and unmounts as the sender moves between them. Automatic mode has no
// way to be told that the element it rendered into is gone, so it leaves an
// orphaned widget and the next mount gets nothing. Explicit mode hands back a
// widget id that this component removes on unmount.
//
// WHY A RESET SIGNAL
//
// A Turnstile token is single use and short lived. Cloudflare refuses a
// replay, which is the property that stops a captured token being reused for a
// flood, and it means a failed submit cannot simply be retried with the token
// already in hand: the second attempt would be refused for a reason that has
// nothing to do with the sender. The parent bumps resetKey after any failure
// and this asks Cloudflare for a fresh challenge.
//
// RENDERS NOTHING WITHOUT A SITE KEY
//
// Same rule as everywhere else in this feature: no key, no widget, no script
// tag, no network request to Cloudflare at all. A deployment that has not been
// given the keys behaves as though this file does not exist.

const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"
const SCRIPT_ID = "cf-turnstile-script"

/**
 * How long to wait for the challenge to become usable before giving up.
 *
 * A script tag that is intercepted rather than blocked fires neither load nor
 * error: a captive portal can hold the request open, and a script element
 * that was already in the document before this component mounted will never
 * fire load again. Without a deadline both of those states wait forever, and
 * waiting forever is the silent failure this component exists to avoid.
 *
 * Ten seconds. Turnstile normally loads in well under one, and this has to
 * survive a slow mobile connection without declaring a working challenge dead.
 */
const LOAD_TIMEOUT_MS = 10_000

/**
 * How many challenge errors in a row before the widget is called unusable.
 *
 * Turnstile retries on its own, so ONE error-callback means nothing: a
 * challenge that fails once and solves on the next attempt is the normal
 * shape of a flaky network. Three in a row is not flakiness.
 *
 * This exists because of a real failure. A wrong site key makes
 * challenges.cloudflare.com answer 400, Turnstile fires error-callback and
 * retries, and it does that forever. The old code reported "no token" on each
 * one and nothing else, and the load deadline had already been cleared by the
 * successful script load, so nothing was left to time out. The button sat
 * disabled reading "Checking your browser..." indefinitely, which is exactly
 * the silent state this component was written to eliminate, reached by a route
 * nobody had walked yet.
 */
const ERROR_LIMIT = 3

/**
 * How long a challenge gets to solve after its FIRST error before it is called
 * unusable, even if the error count has not been reached.
 *
 * Counting alone is not enough: Turnstile could back off and retry slowly, or
 * stop retrying altogether after one error, and either way the count never
 * reaches the limit and the deadline never arrives. This is the floor under
 * that.
 *
 * Armed on the first error rather than on mount, deliberately. A challenge
 * that needs a human to click a checkbox can legitimately take longer than any
 * deadline worth setting, and starting a clock at mount would show the red
 * panel to somebody who was simply reading it. An error has to happen first.
 */
const ERROR_GRACE_MS = 10_000

type TurnstileApi = {
  render: (
    element: HTMLElement,
    options: {
      sitekey: string
      callback: (token: string) => void
      "expired-callback"?: () => void
      // Cloudflare passes an error code here. It is the difference between a
      // challenge that failed once and a site key the account does not own,
      // and it is the single most useful thing in the console when this goes
      // wrong, so it is typed and logged rather than discarded.
      "error-callback"?: (code?: string) => void
      theme?: "light" | "dark" | "auto"
      appearance?: "always" | "execute" | "interaction-only"
    }
  ) => string
  reset: (widgetId: string) => void
  remove: (widgetId: string) => void
}

declare global {
  interface Window {
    turnstile?: TurnstileApi
  }
}

/**
 * Load the Turnstile script once per document.
 *
 * Resolves immediately if it is already there, which happens when the sender
 * steps back to the form and forward to the quote again. A second script tag
 * would re-register the global and orphan the first one's widgets.
 */
function loadTurnstileScript(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve()
  if (window.turnstile) return Promise.resolve()

  const existing = document.getElementById(SCRIPT_ID)
  if (existing) {
    return new Promise((resolve, reject) => {
      existing.addEventListener("load", () => resolve())
      existing.addEventListener("error", () => reject(new Error("turnstile script failed")))
    })
  }

  return new Promise((resolve, reject) => {
    const script = document.createElement("script")
    script.id = SCRIPT_ID
    script.src = SCRIPT_SRC
    script.async = true
    script.defer = true
    script.onload = () => resolve()
    script.onerror = () => reject(new Error("turnstile script failed"))
    document.head.appendChild(script)
  })
}

export function TurnstileWidget({
  siteKey,
  onToken,
  onUnavailable,
  resetKey = 0,
}: {
  /** NEXT_PUBLIC_TURNSTILE_SITE_KEY. Empty string means render nothing. */
  siteKey: string
  /** Called with a token when the challenge is solved, and null when it is not. */
  onToken: (token: string | null) => void
  /**
   * Called when the challenge cannot run at all, as opposed to not having been
   * solved yet. An ad blocker, a captive portal, or Cloudflare being
   * unreachable all land here.
   *
   * Reported separately because the two states look identical from the outside
   * and need opposite treatment. "Not solved yet" resolves itself in a second
   * and the right thing to do is wait. "Cannot run" never resolves, and a
   * parent that treats it as waiting leaves a disabled button and a sender
   * with no idea why they cannot post.
   */
  onUnavailable?: () => void
  /** Any change to this value asks Cloudflare for a fresh challenge. */
  resetKey?: number
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const widgetIdRef = useRef<string | null>(null)
  // Consecutive challenge errors, and the grace timer armed by the first of
  // them. Refs rather than state: nothing renders from them, and the reset
  // effect below has to be able to clear both.
  const errorCountRef = useRef(0)
  const errorDeadlineRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Held in a ref so the render effect below does not depend on the identity
  // of the callback. The parent recreates it on every render, and a dependency
  // on it would tear the widget down and rebuild it on every keystroke in the
  // form.
  const onTokenRef = useRef(onToken)
  onTokenRef.current = onToken
  const onUnavailableRef = useRef(onUnavailable)
  onUnavailableRef.current = onUnavailable

  const emit = useCallback((token: string | null) => {
    onTokenRef.current(token)
  }, [])

  const emitUnavailable = useCallback(() => {
    onUnavailableRef.current?.()
  }, [])

  useEffect(() => {
    if (!siteKey) return
    const container = containerRef.current
    if (!container) return

    let cancelled = false
    // Set the moment this attempt reaches a verdict, so the three ways it can
    // end (loaded, failed, timed out) cannot each report one.
    let settled = false

    // Every route to "this challenge cannot run" ends here. An ad blocker, a
    // captive portal, Cloudflare being unreachable, and a render that throws
    // all land on the same report, because they need the same answer from the
    // parent: say so, and offer the way around it.
    const clearErrorDeadline = () => {
      if (errorDeadlineRef.current) {
        clearTimeout(errorDeadlineRef.current)
        errorDeadlineRef.current = null
      }
    }

    const reportUnavailable = (why: string) => {
      console.warn(`[gyema] Turnstile unavailable: ${why}`)
      emit(null)
      emitUnavailable()
    }

    const timer = setTimeout(() => {
      if (cancelled || settled) return
      settled = true
      reportUnavailable("did not load within the deadline")
    }, LOAD_TIMEOUT_MS)

    loadTurnstileScript()
      .then(() => {
        if (cancelled || settled) return
        settled = true
        clearTimeout(timer)

        // THE SILENT CASE, and the reason this branch is separate from the
        // catch below. A captive portal answers the script request with its
        // own login page and a 200, and some blockers answer with an empty
        // body. Either way the load event fires and this promise resolves
        // normally, but the global the script was supposed to define is not
        // there. Returning quietly here, which is what this did before, left
        // a disabled button reading "Checking your browser..." for as long as
        // the sender was willing to look at it.
        if (!window.turnstile) {
          reportUnavailable("script resolved without defining window.turnstile")
          return
        }

        try {
          widgetIdRef.current = window.turnstile.render(container, {
            sitekey: siteKey,
            callback: (token: string) => {
              // A token means the challenge is working, whatever it did
              // before. Clear the error state so a single earlier failure
              // cannot accumulate across a long session and eventually trip
              // the limit on a widget that is solving fine.
              errorCountRef.current = 0
              clearErrorDeadline()
              emit(token)
            },
            // An expired token is worth nothing to the route, so the parent is
            // told to drop it rather than being left holding a value that will
            // be refused at submit time. NOT an error: expiry is the normal
            // end of a token's life and Turnstile refreshes itself.
            "expired-callback": () => emit(null),
            "error-callback": (code?: string) => {
              emit(null)
              errorCountRef.current += 1
              console.warn(
                `[gyema] Turnstile challenge error ${errorCountRef.current}: ${code ?? "no code"}`
              )

              if (errorCountRef.current >= ERROR_LIMIT) {
                clearErrorDeadline()
                reportUnavailable(
                  `challenge failed ${errorCountRef.current} times, last code ${code ?? "none"}`
                )
                return
              }

              // Arm the floor once, on the first error. Re-arming on each one
              // would let a steady drip of errors push the deadline out
              // forever, which is the same spin in a slower costume.
              if (!errorDeadlineRef.current) {
                errorDeadlineRef.current = setTimeout(() => {
                  errorDeadlineRef.current = null
                  reportUnavailable("challenge did not solve after its first error")
                }, ERROR_GRACE_MS)
              }
            },
            theme: "light",
          })
        } catch {
          // A bad site key, or a Turnstile build that does not like this
          // container. Nothing the sender can do, but they still need telling.
          reportUnavailable("render threw")
        }
      })
      .catch(() => {
        if (cancelled || settled) return
        settled = true
        clearTimeout(timer)
        // The request was refused outright, which is what a blocker that
        // cancels the request rather than faking a response produces.
        reportUnavailable("script request failed")
      })

    return () => {
      cancelled = true
      clearTimeout(timer)
      clearErrorDeadline()
      const id = widgetIdRef.current
      if (id && window.turnstile) {
        try {
          window.turnstile.remove(id)
        } catch {
          // Already gone. Nothing to clean up and nothing worth reporting.
        }
      }
      widgetIdRef.current = null
    }
  }, [siteKey, emit, emitUnavailable])

  useEffect(() => {
    // Skip the initial render: resetKey starts at zero and the widget has just
    // been created, so resetting it here would discard a fresh challenge.
    if (resetKey === 0) return
    const id = widgetIdRef.current
    if (id && window.turnstile) {
      // A deliberate reset is a fresh start, so the error budget resets with
      // it. Without this, a sender whose first submit failed for an unrelated
      // reason would carry earlier challenge errors into the retry and could
      // meet the limit on their second attempt rather than their fourth.
      errorCountRef.current = 0
      if (errorDeadlineRef.current) {
        clearTimeout(errorDeadlineRef.current)
        errorDeadlineRef.current = null
      }
      emit(null)
      window.turnstile.reset(id)
    }
  }, [resetKey, emit])

  if (!siteKey) return null

  return <div ref={containerRef} className="flex justify-center" />
}
