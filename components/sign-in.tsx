"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import {
  signInAndPersist,
  isPiSdkAvailable,
  type PiUser,
} from "@/lib/pi-network"

interface SignInProps {
  onSignedIn: (user: PiUser) => void
  onContinueAsGuest: () => void
}

export function SignIn({ onSignedIn, onContinueAsGuest }: SignInProps) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")

  const handlePiSignIn = async () => {
    setError("")
    setLoading(true)
    try {
      const user = await signInAndPersist()
      onSignedIn(user)
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Sign-in failed. Please try again."
      console.error("[sign-in] handlePiSignIn failed:", {
        message,
        error: err,
        timestamp: new Date().toISOString(),
      })
      setError(message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-6 py-12 gyema-gradient">
      <Card className="w-full max-w-sm overflow-hidden shadow-xl">
        <div className="p-8 pb-0 space-y-6">
          <div className="flex flex-col items-center space-y-3">
            <div className="w-20 h-20 rounded-2xl bg-secondary flex items-center justify-center shadow-lg">
              <img
                src="/gyema-hand.png"
                alt="Gyema"
                className="w-20 h-20 object-contain"
              />
            </div>
            <h1 className="text-3xl font-bold tracking-tight">Gyema</h1>
            <p className="text-sm text-muted-foreground text-center">
              Connecting People · Delivering Value
            </p>
          </div>
        </div>

        <div className="kente-band my-6" aria-hidden="true" />

        <div className="px-8 pb-8 space-y-6">
          {!isPiSdkAvailable() && (
            <div className="rounded-md bg-amber-50 border border-amber-200 p-3 text-xs text-amber-900">
              Pi SDK not detected. Open this app inside <strong>Pi Browser</strong>{" "}
              to sign in with your Pi account.
            </div>
          )}

          {error && (
            <div className="rounded-md bg-red-50 border border-red-200 p-3 text-xs text-red-900">
              {error}
            </div>
          )}

          <div className="space-y-3">
            <Button
              className="w-full h-12 text-base font-semibold"
              size="lg"
              onClick={handlePiSignIn}
              disabled={loading || !isPiSdkAvailable()}
            >
              {loading ? "Signing in…" : "Sign in with Pi"}
            </Button>

            <a href="/send" className="block">
              <Button
                variant="outline"
                className="w-full h-12 text-base"
                size="lg"
              >
                Post delivery as guest
              </Button>
            </a>

            <button
              type="button"
              onClick={onContinueAsGuest}
              className="w-full text-center text-xs text-muted-foreground underline"
            >
              Just browsing? Continue as guest
            </button>
          </div>

          <p className="text-xs text-muted-foreground text-center">
            Powered by Pi Network · Decentralized P2P Delivery
          </p>
        </div>
      </Card>
    </div>
  )
}
