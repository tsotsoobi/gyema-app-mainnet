import type React from "react"
import type { Metadata, Viewport } from "next"
import { headers } from "next/headers"
import Script from "next/script"
import { GeistSans } from "geist/font/sans"
import { GeistMono } from "geist/font/mono"
import { TestnetBanner } from "@/components/testnet-banner"
import "./globals.css"

export const metadata: Metadata = {
  title: "Gyema — P2P Delivery on Pi",
  description:
    "Gyema connects routine travellers with senders needing packages delivered. Decentralized P2P delivery powered by Pi Network.",
}

// DYNAMIC RENDERING, and the reason is the CSP nonce.
//
// A nonce is minted per request in middleware and has to appear both in the
// header and on every script tag. A statically prerendered page is HTML built
// once, at build time, so it cannot carry one: the browser gets a header
// naming a nonce that no tag on the page has, and blocks every script,
// including the Pi SDK. Sign-in and payment stop. It is silent in development,
// where pages render per request, which is what makes it a trap.
//
// The route table before this line was added:
//
//   o /            static   <- loads the Pi SDK, through this layout
//   o /send        static   <- same
//   o /track       static   <- same
//   f /track/[id]  dynamic
//
// Three of the four were prerendered. This opts the whole subtree into
// per-request rendering so the nonce reaches them.
//
// THE COST, stated plainly: the HTML shell is rendered per request instead of
// served from the CDN. Every page in this app already fetches its data
// client-side, so the shell is small and this is a function invocation rather
// than a database query. The alternative is 'unsafe-inline' in script-src,
// which permits injected scripts, which is not a script policy.
//
// Removing this line means going back to a prerendered app, and the CSP must
// change in the same commit: either hash the inline script or move it to a
// file. Do not remove it on its own.
export const dynamic = "force-dynamic"

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: "#7B2CBF",
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  // Set by middleware.ts on the request. Absent only if middleware did not
  // run, in which case the CSP header is absent too and an unnonced script is
  // still executed: the two travel together or not at all.
  const nonce = (await headers()).get("x-nonce") ?? undefined

  return (
    <html lang="en">
      <head>
        <style>{`
html {
  font-family: ${GeistSans.style.fontFamily};
  --font-sans: ${GeistSans.variable};
  --font-mono: ${GeistMono.variable};
}
        `}</style>
      </head>
      <body>
        {/*
          Pi Network SDK — must load BEFORE any code that calls window.Pi.
          strategy="beforeInteractive" guarantees the SDK script runs before
          React hydrates, so window.Pi is defined when client components mount.

          sandbox flag is set dynamically based on hostname. Per Pi SDK docs,
          sandbox: true is ONLY for the Pi Sandbox environment at
          sandbox.minepi.com (desktop testing). When the app loads inside the
          real Pi Browser — whether via the direct gyema-app.vercel.app URL
          or Pi Browser's *.pinet.com proxy — sandbox must be false. Setting
          sandbox: true while in Pi Browser triggers an iframe-context bug
          where event handlers break text input focus (observed May 6, 2026).

          Non-production hostnames (preview deployments, dev URLs, localhost)
          fall back to sandbox: true.

          Testnet vs mainnet is controlled by Developer Portal app config,
          not this flag — changing sandbox does not affect Pi token type.
        */}
        <Script
          src="https://sdk.minepi.com/pi-sdk.js"
          strategy="beforeInteractive"
          nonce={nonce}
        />
        <Script id="pi-init" strategy="beforeInteractive" nonce={nonce}>
          {`
            try {
              if (typeof Pi !== 'undefined') {
                var host = typeof window !== 'undefined'
                  ? window.location.hostname
                  : '';
                var isProduction =
                  host === 'gyema-app.vercel.app' ||
                  host.endsWith('.pinet.com');
                Pi.init({ version: "2.0", sandbox: !isProduction });
              }
            } catch (e) {
              console.warn("Pi SDK init skipped:", e);
            }
          `}
        </Script>
        <TestnetBanner />
        {children}
      </body>
    </html>
  )
}
