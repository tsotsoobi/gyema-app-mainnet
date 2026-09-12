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

type TurnstileApi = {
  render: (
    element: HTMLElement,
    options: {
      sitekey: string
      callback: (token: string) => void
      "expired-callback"?: () => void
      "error-callback"?: () => void
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
            callback: (token: string) => emit(token),
            // An expired token is worth nothing to the route, so the parent is
            // told to drop it rather than being left holding a value that will
            // be refused at submit time.
            "expired-callback": () => emit(null),
            "error-callback": () => emit(null),
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
      emit(null)
      window.turnstile.reset(id)
    }
  }, [resetKey, emit])

  if (!siteKey) return null

  return <div ref={containerRef} className="flex justify-center" />
}
