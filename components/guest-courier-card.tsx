"use client"

import { useState } from "react"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { submitDeliveryCodeAsync, type CourierGuestJob } from "@/lib/guest-jobs"
import { describeStamps, hasStamp, STAMP_COURIER_CODE } from "@/lib/delivery-stamps"

// The persistent card for a guest job this courier has accepted. Deliberately
// NOT ListingCard: that component is shared and typed to Listing, and a guest
// job is a different rail with no poster, no Pi price, and no listing id.
//
// Display, with exactly one write: the delivery code the recipient reads out
// at the door. Everything else here is still reflected state, and the sender's
// own sign-off still belongs to the sender on the public tracker. The code
// field is the courier attesting to where they are standing, which is the one
// fact the tracker cannot establish on their behalf.

// Statuses a courier no longer acts on. Mirrors the muted treatment the Past
// section gives finished listings, without touching that component.
const TERMINAL_STATUSES = new Set(["delivered", "cancelled", "expired"])

export function GuestCourierCard({ job }: { job: CourierGuestJob }) {
  const muted = TERMINAL_STATUSES.has(job.status)
  const when = job.whenPref === "date" ? job.scheduledDate : job.whenPref

  const [code, setCode] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [codeError, setCodeError] = useState<string | null>(null)
  const [codeAccepted, setCodeAccepted] = useState(false)
  const [locked, setLocked] = useState(false)

  // The field appears only while the package is in transit and only for jobs
  // that carry a code. Once this courier's stamp is on the row it goes away:
  // re-entering a code that already landed can only spend attempts.
  const alreadyStamped = hasStamp(job.deliveryConfirmedBy, STAMP_COURIER_CODE)
  const showCodeEntry =
    job.status === "in_transit" && job.hasDeliveryCode && !alreadyStamped && !codeAccepted

  const handleSubmitCode = async () => {
    if (submitting || code.length !== 4) return
    setSubmitting(true)
    setCodeError(null)
    const result = await submitDeliveryCodeAsync({ trackingId: job.trackingId, code })
    setSubmitting(false)
    if (result.ok) {
      setCodeAccepted(true)
      return
    }
    if (result.reason === "code_locked") {
      setLocked(true)
      setCodeError(
        "Too many wrong codes. This delivery can no longer be closed with a code. Contact Gyema dispatch."
      )
    } else if (result.reason === "wrong_code") {
      const left = result.attemptsLeft ?? 0
      setCodeError(
        `That code is not right. ${left} ${left === 1 ? "try" : "tries"} left before it locks.`
      )
    } else if (result.reason === "not_assigned" || result.reason === "unauthorized") {
      setCodeError("Sign in with Pi as the courier who accepted this delivery.")
    } else if (result.reason === "not_confirmable" || result.reason === "state_changed") {
      setCodeError("This delivery cannot be confirmed right now. Reopen the tab to refresh.")
    } else if (result.reason === "network") {
      setCodeError("Network problem. Please try again.")
    } else {
      setCodeError("Could not submit that code. Please try again.")
    }
  }

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

      {/* The card's only write. Plainly labelled: the courier is being asked
          for a number somebody else is holding, so the copy says whose. */}
      {showCodeEntry && (
        <div className="rounded-md p-3 space-y-2" style={{ backgroundColor: "#F5B80022", border: "1px solid #F5B80066" }}>
          <p className="text-sm font-semibold">Handing the package over?</p>
          <p className="text-xs text-muted-foreground">
            Ask the person receiving the package for their 4-digit delivery
            code. The sender gave it to them. Entering it here records that you
            made the handover in person.
          </p>
          <div className="space-y-1.5">
            <Label htmlFor={`code-${job.trackingId}`}>Delivery code from the recipient</Label>
            <Input
              id={`code-${job.trackingId}`}
              inputMode="numeric"
              maxLength={4}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/[^0-9]/g, ""))}
              placeholder="1234"
              disabled={locked}
            />
          </div>
          {codeError && <p className="text-xs" style={{ color: "#DC2626" }}>{codeError}</p>}
          <Button
            className="w-full"
            disabled={submitting || locked || code.length !== 4}
            onClick={handleSubmitCode}
          >
            {submitting ? "Checking..." : "Submit delivery code"}
          </Button>
        </div>
      )}

      {(codeAccepted || alreadyStamped) && job.status !== "delivered" && (
        <div className="rounded-md p-3 space-y-1" style={{ backgroundColor: "#15803D14", border: "1px solid #15803D33" }}>
          <p className="text-sm font-semibold" style={{ color: "#15803D" }}>Delivery code accepted</p>
          <p className="text-xs" style={{ color: "#166534" }}>
            Your handover is recorded. The delivery closes once the sender signs
            off on the tracker.
          </p>
        </div>
      )}

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
              {describeStamps(job.deliveryConfirmedBy)
                ? ` by ${describeStamps(job.deliveryConfirmedBy)}`
                : ""}
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
