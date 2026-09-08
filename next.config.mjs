/** @type {import('next').NextConfig} */

// Security headers.
//
// There were none: no HSTS, no nosniff, no framing rule, no referrer policy,
// no permissions policy (finding S-7). These are the static half, the half
// that cannot break the Pi SDK. The Content-Security-Policy that governs
// script execution is a separate change with its own risk, shipped separately
// and behind a report-only flag, because a CSP that blocks the Pi SDK breaks
// sign-in and payments rather than degrading them.
//
// FRAMING IS THE ONE THAT NEEDS CARE. The app runs INSIDE the Pi Browser,
// which serves it through a *.pinet.com proxy, so it is framed by design.
// X-Frame-Options cannot express "this origin and that wildcard", it only has
// DENY and SAMEORIGIN, so it is not used at all: a SAMEORIGIN would break the
// app in the only browser it is meant to run in.
//
// frame-ancestors does express it, and now lives in the single CSP that
// middleware.ts sets per request (lib/csp.ts). It was briefly set here as a
// CSP carrying that one directive; it moved rather than being duplicated,
// because two Content-Security-Policy headers on one response are both
// enforced and their intersection applies, which is a confusing way to break
// something.

const securityHeaders = [
  {
    // Two years, subdomains included, NO preload.
    //
    // Preload is a one-way door: it ships the domain in a list compiled into
    // browsers, and removal takes months. It is the right end state and the
    // wrong thing to do on the same day as a first HSTS header, especially
    // with a custom domain still hypothetical (docs/hosted-proposal.md).
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains",
  },
  {
    // Stops a browser deciding for itself that a JSON response is HTML, which
    // is how a stored string becomes a script.
    key: "X-Content-Type-Options",
    value: "nosniff",
  },
  {
    // A tracking ID is a capability: anyone holding one can look up a delivery
    // and reach the last-4 guard. It travels in the path on the deep-link form
    // (/track/GYM-XXXXXX), so a full referrer would hand it to every outbound
    // link a sender taps, including the wa.me links this app builds.
    // strict-origin-when-cross-origin sends the origin only, off-origin.
    key: "Referrer-Policy",
    value: "strict-origin-when-cross-origin",
  },
  {
    // Nothing in this app reads a location or opens a camera: the only
    // navigator call in the tree is clipboard.writeText in the detail sheet.
    // So both are denied outright rather than scoped, because the honest
    // scope today is nowhere.
    //
    // WHEN THE COURIER MAP ARRIVES and needs a position, do not widen this
    // line: add a headers() entry for that path alone with
    // geolocation=(self), so the permission exists on the one route that uses
    // it and nowhere else. Same for camera if proof-of-delivery photos ever
    // ship. The point of this header is that a permission is granted per
    // surface, not per app.
    key: "Permissions-Policy",
    value: "geolocation=(), camera=(), microphone=(), payment=(), usb=(), interest-cohort=()",
  },
]

const nextConfig = {
  eslint: {
    ignoreDuringBuilds: true,
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
  async headers() {
    return [
      {
        // Every route, including the API. A JSON response benefits from
        // nosniff and from not being framed just as much as a page does.
        source: "/:path*",
        headers: securityHeaders,
      },
    ]
  },
}

export default nextConfig
