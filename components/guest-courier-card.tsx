"use client"

import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { type CourierGuestJob } from "@/lib/guest-jobs"

// The persistent card for a guest job this courier has accepted. Deliberately
// NOT ListingCard: that component is shared and typed to Listing, and a guest
// job is a different rail with no poster, no Pi price, and no listing id.
//
// Read-only by design. Every value here is display; the confirmations belong
// to the sender on the public tracker.

// Statuses a courier no longer acts on. Mirrors the muted treatment the Past
// section gives finished listings, without touching that component.
const TERMINAL_STATUSES = new Set(["delivered", "cancelled", "expired"])

export function GuestCourierCard({ job }: { job: CourierGuestJob }) {
  const muted = TERMINAL_STATUSES.has(job.status)
  const when = job.whenPref === "date" ? job.scheduledDate : job.whenPref

  return (
    <Card
      className={`p-4 space-y-3 ${muted ? "bg-muted/40 border-muted opacity-70" : ""}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <p className={`font-semibold text-sm ${muted ? "text-muted-foreground" : ""}`}>
            {job.pickupArea} {"\u2192"} {job.dropoffArea}
          </p>
          <div className="flex items-center gap-1.5 mt-1 flex-wrap">
            <Badge className="text-[10px] text-amber-950" style={{ backgroundColor: "#F5B800" }}>
              Guest delivery
            </Badge>
            <Badge variant="secondary" className="text-[10px]">
              Phone-verified sender
            </Badge>
            <Badge variant="outline" className="text-[10px]">
              {job.status}
            </Badge>
          </div>
        </div>
        <div
          className={`rounded-md px-2.5 py-1 text-xs font-bold text-amber-950 whitespace-nowrap ${
            muted ? "bg-muted" : "gyema-gold-gradient"
          }`}
        >
          {job.quoteCedis ?? "?"} GHS
        </div>
      </div>

      {/* Everything needed to actually make the delivery, kept on the card so
          it survives closing the app. */}
      <div className="rounded-md border p-3 space-y-1 text-sm">
        <p>
          <span className="text-muted-foreground">Pickup:</span> {job.pickupArea}
          {job.pickupLandmark ? `, ${job.pickupLandmark}` : ""}
        </p>
        <p>
          <span className="text-muted-foreground">Recipient:</span>{" "}
          {job.recipientName ?? "-"}{" "}
          {job.recipientPhone ? (
            <a href={`tel:${job.recipientPhone}`} className="underline">
              {job.recipientPhone}
            </a>
          ) : null}
        </p>
        <p>
          <span className="text-muted-foreground">Drop-off:</span> {job.dropoffArea}
          {job.dropoffLandmark ? `, ${job.dropoffLandmark}` : ""}
        </p>
        <p>
          <span className="text-muted-foreground">Package:</span> {job.packageSize}
          {when ? ` \u00b7 ${when}` : ""}
        </p>
        <p>
          <span className="text-muted-foreground">You collect:</span>{" "}
          {job.quoteCedis ?? "?"} GHS ({job.paymentType === "momo" ? "MoMo" : "cash"})
        </p>
      </div>

      {/* Sender-side sign-off, reflected only. Absent until the sender
          confirms on the public tracker. */}
      {(job.pickupConfirmedAt || job.deliveryConfirmedAt) && (
        <div className="space-y-0.5">
          {job.pickupConfirmedAt && (
            <p className="text-xs" style={{ color: "#15803D" }}>
              Pickup confirmed{job.pickupConfirmedBy ? ` by ${job.pickupConfirmedBy}` : ""}
              {" \u00b7 "}
              {formatDate(job.pickupConfirmedAt)}
            </p>
          )}
          {job.deliveryConfirmedAt && (
            <p className="text-xs" style={{ color: "#15803D" }}>
              Delivery confirmed
              {job.deliveryConfirmedBy ? ` by ${job.deliveryConfirmedBy}` : ""}
              {" \u00b7 "}
              {formatDate(job.deliveryConfirmedAt)}
            </p>
          )}
        </div>
      )}

      <p className="font-mono text-[10px] text-muted-foreground">{job.trackingId}</p>
    </Card>
  )
}

function formatDate(iso: string): string {
  if (!iso) return "-"
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    })
  } catch {
    return iso
  }
}
