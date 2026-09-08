import { NextRequest, NextResponse } from "next/server"
import { buildCsp, cspHeaderName } from "@/lib/csp"

// Edge middleware. Two jobs: get every request onto https, and mint the CSP
// nonce for the request so the policy and the page agree about it.
//
// Vercel terminates TLS and answers http itself, so a request that arrives
// over http reaches the app as an ordinary request with x-forwarded-proto
// saying so. Without this, an http URL for a custom domain would serve the app
// over cleartext: the session token in the response body of /api/auth/verify,
// a delivery code from /api/guest/delivery-code, and a sender's phone number
// would all cross the network in the clear.
//
// HSTS in next.config.mjs tells a browser never to try http again. This is
// what handles the FIRST request, before the browser has been told, and any
// request from something that ignores HSTS.
//
// LOOPBACK IS EXEMPT, deliberately: `next dev` serves http://localhost, and a
// redirect there is an infinite loop against a server that has no https to
// redirect to. The check is on the hostname, not on an environment variable,
// so it cannot be switched off in production by setting NODE_ENV wrongly.

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"])

function isLoopback(hostname: string): boolean {
  const bare = hostname.split(":")[0]
  return LOOPBACK_HOSTS.has(bare) || LOOPBACK_HOSTS.has(hostname)
}

export function middleware(request: NextRequest) {
  const proto = request.headers.get("x-forwarded-proto")
  const host = request.headers.get("host") ?? request.nextUrl.host

  // Only redirect when the proxy has told us it was http. An absent header
  // means nothing is in front of us, which is the local dev case, and
  // guessing there would break it.
  if (proto === "http" && !isLoopback(host)) {
    const url = request.nextUrl.clone()
    url.protocol = "https:"
    url.port = ""
    // 308 rather than 301: it preserves the method and the body, so a POST
    // that arrives over http is not silently turned into a GET. It should not
    // happen, and if it does, losing the request quietly is worse than
    // redirecting it.
    return NextResponse.redirect(url, 308)
  }

  // A fresh nonce per request. Base64 of 16 random bytes: not a secret, but
  // unpredictable to an injected script, which is the only reader that matters.
  const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64")
  const csp = buildCsp(nonce)

  // The nonce reaches the layout through a REQUEST header, which is how a
  // server component reads a per-request value. It goes out on the response
  // too, so it can be read from a browser's network tab while debugging a
  // blocked script.
  const requestHeaders = new Headers(request.headers)
  requestHeaders.set("x-nonce", nonce)

  const response = NextResponse.next({ request: { headers: requestHeaders } })
  response.headers.set(cspHeaderName(process.env.CSP_ENFORCE), csp)
  response.headers.set("x-nonce", nonce)
  return response
}

export const config = {
  // Everything except Next's own static output and the icons, which are
  // served straight from the CDN and gain nothing from a middleware hop.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|icon.svg|apple-icon.png|.*\\.png$|.*\\.jpg$|.*\\.svg$|.*\\.txt$|.*\\.html$).*)",
  ],
}
