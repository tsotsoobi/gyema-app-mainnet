import { TrackView } from "@/components/track-view"

// /track/GYM-XXXXXX (path-based deep-link). Pinet hosts preserve path
// segments but strip query strings, so dispatch and WhatsApp templates
// deep-link this form: <this network's pinet host>/track/GYM-XXXXXX.
//
// The host differs per network and the two are easy to transpose:
// gyema3681.pinet.com is TESTNET, gyema8841.pinet.com is MAINNET. A Testnet
// dispatch link that names 8841 sends a sender to the live app to track a job
// that only exists here, where it resolves to nothing.
export default async function TrackByIdPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  return <TrackView initialId={id} />
}