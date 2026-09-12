// The Content-Security-Policy, and the reasoning that shaped it.
//
// WHY THE NONCE NEEDED A PRERENDER CHECK FIRST
//
// A nonce is minted per request in middleware and has to appear both in the
// header and on every script tag in the HTML. A statically prerendered page is
// HTML built once, at build time, so it cannot carry a per-request nonce: the
// browser gets a header naming a nonce that no tag on the page has, and blocks
// every script including the Pi SDK. That is the failure that broke pi-trace's
// PWAs, and it is silent in development, where pages are rendered per request.
//
// So the route table was read before this file was written:
//
//   o /            static   <- loads the Pi SDK through the root layout
//   o /send        static   <- same layout
//   o /track       static   <- same layout
//   f /track/[id]  dynamic
//
// Three of the four pages that load the SDK were prerendered. The root layout
// now opts its subtree into dynamic rendering so the nonce can reach them.
// That is a real cost, stated plainly: the HTML shell is rendered per request
// instead of served from the CDN. For an app whose every page already fetches
// its data client-side, the shell is small and the trade is worth it; the
// alternative is a policy with 'unsafe-inline' in script-src, which is a
// script policy that permits injected scripts, which is not a script policy.
//
// WHAT A DESKTOP REPORT-ONLY PASS CANNOT TELL YOU
//
// Enforcing this policy on Testnet broke sign-in with "Sign-in cancelled or
// failed", which is lib/pi-network.ts catching a rejected Pi.authenticate.
// A report-only pass on desktop had shown nothing, and that is a property of
// the pass rather than of the policy. Two whole directives are unreachable
// from a desktop browser:
//
//   frame-ancestors  only applies when the page IS framed. On desktop it is
//                    not, so the directive is inert and reports nothing. In
//                    Pi Browser the app is always framed.
//   connect-src      the SDK's requests to the Pi host platform only happen
//                    once a real Pi.authenticate is under way. On desktop
//                    window.Pi is missing, authenticateWithPi throws before
//                    any request is made, and the directive is never tested.
//
// So a clean desktop console said the page loads. It could not say the
// authentication flow works, because the flow never ran.
//
// WHAT THE SDK ACTUALLY TALKS TO
//
// Established by reading https://sdk.minepi.com/pi-sdk.js (1.1 MB, fetched
// 7 September) rather than by reasoning about what it probably does. Three
// facts from the source, each of which changed a directive below:
//
//   1. THE SDK CREATES NO IFRAME. The only "iframe" string in the file is a
//      key in a DOM attribute lookup table. It communicates with
//      window.parent.postMessage, which means our page is the CHILD and the
//      Pi host platform is the parent. postMessage is not governed by CSP at
//      all, so frame-src and child-src were never the blocker. That rules out
//      two of the four candidates.
//
//   2. THE PARENT ORIGIN IS NOT ALWAYS *.minepi.com. getHostPlatformURL()
//      returns one of three values: app-cdn.minepi.com by default, or
//      appstudio-u7cm9zhmha0ruwv8.piappengine.com, or
//      appstudio-pobr34hy4r0qmyuu.staging.piappengine.com. piappengine.com is
//      a domain the old policy did not mention anywhere, and it appears in
//      frame-ancestors, which is the directive a desktop pass cannot exercise.
//
//   3. THE SDK MAKES REQUESTS OF ITS OWN. Seven XMLHttpRequest and two fetch
//      call sites, and the origins named in the file are app-cdn.minepi.com,
//      rpc.testnet.minepi.com and sandbox.minepi.com. The old connect-src
//      listed api.minepi.com and sdk.minepi.com and none of those three.
//
// AND THE CSP RULE THAT MAKES THIS WORSE THAN IT LOOKS: a host source of
// https://*.minepi.com does NOT match the apex https://minepi.com. Wildcards
// match a label, not nothing. So a policy naming only *.minepi.com blocks the
// apex, which is where you say the auth flow is served from.
//
// MY BEST READING, AND ITS LIMIT
//
// connect-src is the likeliest single cause: it was missing every origin the
// SDK actually calls during authentication, and it is exercised only in Pi
// Browser. frame-ancestors is the other candidate that a desktop pass cannot
// rule out, and it was missing both piappengine.com and the minepi.com apex.
//
// I cannot prove which one fired without the Pi Browser console, and I am not
// going to pick one and call it established. Both are widened below, and the
// way to settle it is a report-only pass INSIDE Pi Browser: every violation
// names its directive and its blocked URI, which turns this from a deduction
// into a reading.

// ---------------------------------------------------------------------------
// Origins
// ---------------------------------------------------------------------------

/** The SDK bundle itself. */
const PI_SDK = "https://sdk.minepi.com"

/** Pi Platform's API, called by our routes and by the SDK. */
const PI_API = "https://api.minepi.com"

/**
 * Everything under minepi.com AND the apex, which the wildcard does not match.
 * Covers app-cdn (the default host platform), rpc.testnet, sandbox, api and
 * sdk, so a new subdomain in a later SDK does not become a fresh outage.
 */
const PI_MINEPI = "https://*.minepi.com"
const PI_MINEPI_APEX = "https://minepi.com"

/** Pi Browser serves the app through this proxy, and frames it. */
const PI_BROWSER_PROXY = "https://*.pinet.com"
const PI_BROWSER_APEX = "https://pinet.com"

/**
 * The App Studio host platform. Named in getHostPlatformURL() and absent from
 * the previous policy entirely, including from frame-ancestors, which is the
 * directive a desktop pass cannot exercise.
 */
const PI_APP_ENGINE = "https://*.piappengine.com"

/**
 * Cloudflare Turnstile: the bot check on the guest post form.
 *
 * One origin serves all three things it needs, and each one is a different
 * directive, which is why it appears four times below rather than once:
 * the api.js loader is script-src, the challenge renders in an iframe from the
 * same host so it is frame-src and child-src, and the widget reports back to
 * it, so it is connect-src too. A policy that names it in only some of those
 * fails in a way that looks like the widget simply never appears.
 *
 * Named unconditionally rather than only when the keys are set. The policy is
 * built per request in middleware and the site key is a build-time bake, so
 * making the policy conditional would mean a redeploy could change the header
 * and the widget in two steps rather than one. Naming an origin nothing loads
 * from costs nothing.
 */
const TURNSTILE = "https://challenges.cloudflare.com"

/** Supabase. The project host differs per network, so the wildcard is the point. */
const SUPABASE_HTTPS = "https://*.supabase.co"
const SUPABASE_WSS = "wss://*.supabase.co"

/** Every Pi origin the SDK may reach out to, in one list. */
export const PI_CONNECT_ORIGINS = [
  PI_SDK,
  PI_API,
  PI_MINEPI,
  PI_MINEPI_APEX,
  PI_APP_ENGINE,
  PI_BROWSER_PROXY,
  PI_BROWSER_APEX,
]

/** Every origin allowed to frame this app: the Pi Browser and its host platform. */
export const PI_FRAME_ANCESTORS = [
  "'self'",
  PI_BROWSER_PROXY,
  PI_BROWSER_APEX,
  PI_MINEPI,
  PI_MINEPI_APEX,
  PI_APP_ENGINE,
]

/**
 * Build the policy for one request.
 *
 * `nonce` is base64 from crypto.getRandomValues, minted per request. It is not
 * a secret and does not need to be unguessable to an attacker who can read the
 * page; it needs to be unpredictable to one who cannot, which is the case an
 * injected script is in.
 */
export function buildCsp(nonce: string): string {
  return [
    `default-src 'self'`,

    // The SDK bundle, and app-cdn in case a later version loads a second
    // chunk from the host platform. No 'unsafe-inline', no 'unsafe-eval'.
    `script-src 'self' 'nonce-${nonce}' ${PI_SDK} ${PI_MINEPI} ${TURNSTILE}`,

    // Inline style is deliberate and is not an oversight: the layout injects a
    // style block for the Geist font variables and Tailwind writes inline
    // styles at runtime. It is a defacement risk rather than a code execution
    // one, and frame-ancestors and base-uri close the routes that turn it into
    // one.
    `style-src 'self' 'unsafe-inline'`,

    `img-src 'self' data: blob: ${PI_MINEPI} ${PI_MINEPI_APEX}`,
    `font-src 'self' data:`,

    // The directive that was missing the origins the SDK actually calls.
    `connect-src 'self' ${SUPABASE_HTTPS} ${SUPABASE_WSS} ${TURNSTILE} ${PI_CONNECT_ORIGINS.join(" ")}`,

    // The SDK creates no iframe of its own (source, above), so these are here
    // for a future version rather than for today's flow. Both are named
    // because frame-src falls back to child-src, and an older engine reading
    // only child-src should get the same answer.
    `frame-src 'self' ${TURNSTILE} ${PI_SDK} ${PI_MINEPI} ${PI_MINEPI_APEX} ${PI_APP_ENGINE}`,
    `child-src 'self' ${TURNSTILE} ${PI_SDK} ${PI_MINEPI} ${PI_MINEPI_APEX} ${PI_APP_ENGINE}`,

    // Who may frame US. Inert on desktop, load-bearing in Pi Browser.
    `frame-ancestors ${PI_FRAME_ANCESTORS.join(" ")}`,

    // A form posting to the Pi host platform would be blocked by 'self' alone.
    // Nothing in this app submits a cross-origin form today, and the SDK
    // exchange is postMessage rather than a form, but this is one of the
    // directives a desktop pass cannot exercise, so it is widened to the same
    // Pi origins rather than left as the narrow guess that broke sign-in.
    `form-action 'self' ${PI_MINEPI} ${PI_MINEPI_APEX} ${PI_APP_ENGINE}`,

    `base-uri 'self'`,
    `object-src 'none'`,
  ].join("; ")
}

/**
 * Which header name to send.
 *
 * CSP_ENFORCE=true sends Content-Security-Policy, which blocks.
 * Anything else, including unset, sends Content-Security-Policy-Report-Only,
 * which blocks nothing and writes a violation to the browser console.
 *
 * Report-only is the default deliberately, and the Testnet outage is the
 * argument for it: a CSP that is wrong about the Pi SDK does not degrade the
 * app, it stops sign-in. Ship it in report mode, open the app IN PI BROWSER,
 * read the console, then set the flag. A desktop pass is not that check.
 *
 * There is no reporting endpoint configured, so violations go to the console
 * and nowhere else. That is the right amount of machinery for one person
 * reading one browser; a report-uri would need a collector, and an unread
 * collector is worse than a console somebody looked at.
 */
export function cspHeaderName(enforceFlag: string | undefined): string {
  return enforceFlag === "true"
    ? "Content-Security-Policy"
    : "Content-Security-Policy-Report-Only"
}

/** True when the policy will actually block. */
export function cspIsEnforcing(enforceFlag: string | undefined): boolean {
  return enforceFlag === "true"
}
