"use client"

import { Suspense } from "react"
import { useSearchParams } from "next/navigation"
import { TrackView } from "@/components/track-view"

function TrackQuery() {
  const searchParams = useSearchParams()
  return <TrackView initialId={searchParams.get("id") ?? ""} />
}

// /track and /track?id=GYM-XXXXXX (query-based; works on Vercel URLs).
// For pinet-hosted deep-links use /track/GYM-XXXXXX (path-based) since pinet
// strips query strings.
export default function TrackPage() {
  return (
    <Suspense fallback={<div className="px-4 py-4 text-sm text-muted-foreground">Loading tracker...</div>}>
      <TrackQuery />
    </Suspense>
  )
}