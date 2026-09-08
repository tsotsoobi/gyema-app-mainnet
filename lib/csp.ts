// The Content-Security-Policy, and the reasoning that shaped it.
//
// WHY THE NONCE NEEDED A CHECK FIRST
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
//   ○ /            static   <- loads the Pi SDK through the root layout
//   ○ /send        static   <- same layout
//   ○ /track       static   <- same layout
//   ƒ /track/[id]  dynamic
//
// Three of the four pages that load the SDK were prerendered. The root layout
// now opts its subtree into dynamic rendering so the nonce can reach them.
// That is a real cost, stated plainly: the HTML shell is rendered per request
// instead of served from the CDN. For an app whose every page already fetches
// its data client-side, the shell is small and the trade is worth it; the
// alternative is a policy with 'unsafe-inline' in script-src, which is a
// script policy that permits injected scripts, which is not a script policy.
//
// WHAT IS ALLOWED, AND WHY EACH ONE IS HERE
//
// script-src   'self' for the app's own bundles, the nonce for the two tags in
//              the layout, and sdk.minepi.com because the Pi SDK is loaded from
//              there. No 'unsafe-inline' and no 'unsafe-eval'.
// connect-src  Supabase over https and wss (PostgREST plus realtime, which the
//              client opens even when unused), and api.minepi.com, which the
//              Pi SDK calls from the page during authentication and payment.
// frame-src    sdk.minepi.com: the SDK opens its payment and auth UI in an
//              iframe. Blocking this breaks paying, not just styling.
// frame-ancestors  the app is framed BY the Pi Browser through *.pinet.com.
// style-src    'unsafe-inline' is present and is not an oversight: the root
//              layout injects a <style> block for the Geist font variables and
//              Tailwind's runtime writes inline styles. A style nonce would
//              have to reach both. Inline style is a defacement and clickjacking
//              risk rather than a code execution one, and frame-ancestors and
//              base-uri close the routes that turn it into one.
// img-src      data: for the QR-ish inline assets and blob: for anything the
//              client generates; both are same-document, neither fetches.
//
// object-src, base-uri and form-action are locked because they are the cheap
// half of a CSP: no plugins, no rewriting the base for every relative URL on
// the page, no posting this page's form to another origin.

/** Origins the Pi SDK needs. Changing these changes whether sign-in works. */
const PI_SDK = "https://sdk.minepi.com"
const PI_API = "https://api.minepi.com"
const PI_BROWSER_PROXY = "https://*.pinet.com"
const PI_MINEPI = "https://*.minepi.com"

/** Supabase. The project host differs per network, so the wildcard is the point. */
const SUPABASE_HTTPS = "https://*.supabase.co"
const SUPABASE_WSS = "wss://*.supabase.co"

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
    `script-src 'self' 'nonce-${nonce}' ${PI_SDK}`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data: blob:`,
    `font-src 'self' data:`,
    `connect-src 'self' ${SUPABASE_HTTPS} ${SUPABASE_WSS} ${PI_API} ${PI_SDK}`,
    `frame-src ${PI_SDK} ${PI_MINEPI}`,
    `frame-ancestors 'self' ${PI_BROWSER_PROXY} ${PI_MINEPI}`,
    `base-uri 'self'`,
    `form-action 'self'`,
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
 * Report-only is the default deliberately. A CSP that is wrong about the Pi
 * SDK does not degrade the app, it stops sign-in and payment, and the only
 * place to find that out is inside the Pi Browser. Ship it in report mode,
 * open the app on that network, read the console, then set the flag.
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

/** True when the policy will actually block. Used for the one-line log. */
export function cspIsEnforcing(enforceFlag: string | undefined): boolean {
  return enforceFlag === "true"
}
