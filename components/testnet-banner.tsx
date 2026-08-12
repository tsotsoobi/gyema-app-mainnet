// Persistent staging marker for the Testnet deployment.
//
// Testnet is fully functional and publicly discoverable. Strangers have found
// it and posted real trips believing it was the live app, so every route needs
// an unmissable, non-dismissible marker, not a one-time toast.
//
// Server component on purpose: this reads env at render and has no
// interactivity, so it ships zero JS and cannot be hidden by a client bug.
//
// Fails closed. The banner appears ONLY when NEXT_PUBLIC_IS_TESTNET is exactly
// the string "true". Unset, "false", "1", or anything else renders nothing, so
// the live app can never show it by accident. Set it in the Testnet
// deployment's environment; do not set it in production.

export function TestnetBanner() {
  if (process.env.NEXT_PUBLIC_IS_TESTNET !== "true") return null

  return (
    <div
      role="status"
      className="w-full px-4 py-1.5 text-center text-xs font-medium text-white"
      style={{ backgroundColor: "#DC2626" }}
    >
      Test environment. Deliveries posted here are not real. The live app is
      gyema8841.pinet.com, open it in Pi Browser.
    </div>
  )
}
