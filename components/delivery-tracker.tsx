"use client"

import { type Listing } from "@/lib/listings"

type Stage = {
  label: string
  caption: string
  state: "done" | "current" | "upcoming" | "cancelled"
}

const FOREST = "#15803D"
const GOLD = "#F5B800"
const VERMILLION = "#DC2626"

function fmtDate(iso?: string | null): string {
  if (!iso) return ""
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ""
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" })
}

function deriveStages(l: Listing): Stage[] {
  const s = l.status
  const cancelled = s === "expired"
  const acceptedDone = s === "matched" || s === "in_transit" || s === "completed"
  const delivered = s === "completed"

  return [
    {
      label: "Posted",
      caption: `@${l.postedByUsername} \u00b7 ${fmtDate(l.createdAt)}`,
      state: "done",
    },
    {
      label: "Accepted",
      caption: cancelled
        ? "Match cancelled"
        : acceptedDone
          ? `@${l.matchedWithUsername ?? "traveller"} is carrying it`
          : "Waiting for a traveller",
      state: cancelled ? "cancelled" : acceptedDone ? "done" : "current",
    },
    {
      label: "In transit",
      caption: `On the way to ${l.toCity}`,
      state: cancelled ? "upcoming" : s === "in_transit" ? "current" : delivered ? "done" : "upcoming",
    },
    {
      label: "Delivered",
      caption: delivered ? `Signed for in ${l.toCity}` : `Destination: ${l.toCity}`,
      state: delivered ? "done" : "upcoming",
    },
  ]
}

function nodeColor(state: Stage["state"]): string {
  if (state === "done") return FOREST
  if (state === "current") return GOLD
  if (state === "cancelled") return VERMILLION
  return "#D6D3D1"
}

export function DeliveryTracker({ listing }: { listing: Listing }) {
  const stages = deriveStages(listing)
  const doneCount = stages.filter((st) => st.state === "done").length
  const currentIdx = stages.findIndex((st) => st.state === "current")
  const filled = currentIdx >= 0 ? currentIdx + 0.5 : doneCount
  const pct = Math.max(0, Math.min(100, (filled / (stages.length - 1)) * 100))

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <p className="font-semibold text-base">
          {listing.fromCity} {"\u2192"} {listing.toCity}
        </p>
        <div className="relative h-1.5 w-full rounded-full bg-stone-200">
          <div
            className="absolute left-0 top-0 h-1.5 rounded-full transition-all"
            style={{ width: `${pct}%`, backgroundColor: GOLD }}
          />
        </div>
        <div className="flex justify-between">
          <span className="text-[10px] font-mono text-muted-foreground">{listing.fromCity}</span>
          <span className="text-[10px] font-mono text-muted-foreground">{listing.toCity}</span>
        </div>
      </div>

      <div>
        {stages.map((st, i) => {
          const color = nodeColor(st.state)
          const isLast = i === stages.length - 1
          return (
            <div key={st.label} className="flex gap-3">
              <div className="flex flex-col items-center">
                <div
                  className="h-4 w-4 rounded-full flex items-center justify-center shrink-0"
                  style={{
                    backgroundColor: st.state === "upcoming" ? "transparent" : color,
                    border: st.state === "upcoming" ? `2px solid ${color}` : "none",
                    boxShadow: st.state === "current" ? `0 0 0 4px ${GOLD}33` : "none",
                  }}
                >
                  {st.state === "done" && (
                    <span className="text-white text-[10px] leading-none">{"\u2713"}</span>
                  )}
                </div>
                {!isLast && (
                  <div
                    className="w-0.5 flex-1"
                    style={{ backgroundColor: st.state === "done" ? FOREST : "#E7E5E4", minHeight: "1.5rem" }}
                  />
                )}
              </div>
              <div className="pb-4">
                <p className="text-sm font-medium leading-tight" style={{ opacity: st.state === "upcoming" ? 0.5 : 1 }}>
                  {st.label}
                </p>
                <p className="text-xs font-mono mt-0.5 text-muted-foreground" style={{ opacity: st.state === "upcoming" ? 0.5 : 1 }}>
                  {st.caption}
                </p>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}