import type React from "react"
import type { Metadata, Viewport } from "next"
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

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: "#7B2CBF",
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
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
        />
        <Script id="pi-init" strategy="beforeInteractive">
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
