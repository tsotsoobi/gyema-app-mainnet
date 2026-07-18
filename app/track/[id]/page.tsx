import { TrackView } from "@/components/track-view"

// /track/GYM-XXXXXX (path-based deep-link). Pinet hosts preserve path
// segments but strip query strings, so dispatch/WhatsApp templates deep-link
// this form: gyema8841.pinet.com/track/GYM-XXXXXX.
export default async function TrackByIdPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  return <TrackView initialId={id} />
}