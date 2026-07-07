"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import {
  acceptGuestJobAsync,
  type AcceptedGuestJob,
  type OpenGuestJob,
} from "@/lib/guest-jobs"
import { getSupabaseSession } from "@/lib/pi-network"

const WHATSAPP_STORAGE_KEY = "gyema_whatsapp"

export function GuestJobCard({
  job,
  onClick,
}: {
  job: OpenGuestJob
  onClick: () => void
}) {
  return (
    <button onClick={onClick} className="w-full text-left">
      <Card className="p-4 space-y-2 hover:border-primary transition-colors">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-sm truncate">
              {job.pickupArea} {"\u2192"} {job.dropoffArea}
            </p>
            <div className="flex items-center gap-1.5 mt-1">
              <Badge className="text-[10px]" style={{ backgroundColor: "#15803D" }}>
                Guest delivery
              </Badge>
              <Badge variant="secondary" className="text-[10px]">
                Phone-verified sender
              </Badge>
            </div>
          </div>
          <div className="gyema-gold-gradient rounded-md px-2.5 py-1 text-xs font-bold text-amber-950 whitespace-nowrap">
            {job.quoteCedis ?? "?"} GHS
          </div>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>{job.whenPref === "date" ? job.scheduledDate : job.whenPref}</span>
          <span>{"\u00b7"}</span>
          <span>{job.packageSize}</span>
          <span>{"\u00b7"}</span>
          <span className="font-mono text-[10px]">{job.trackingId}</span>
        </div>
      </Card>
    </button>
  )
}

export function GuestJobSheet({
  job,
  onClose,
  onAccepted,
}: {
  job: OpenGuestJob | null
  onClose: () => void
  onAccepted: (trackingId: string) => void
}) {
  const [whatsapp, setWhatsapp] = useState(() => {
    try {
      return window.localStorage.getItem(WHATSAPP_STORAGE_KEY) ?? ""
    } catch {
      return ""
    }
  })
  const [pending, setPending] = useState(false)
  const [error, setError] = useState("")
  const [revealed, setRevealed] = useState<AcceptedGuestJob | null>(null)

  const handleAccept = async () => {
    if (!job || pending || !whatsapp.trim()) return
    if (!getSupabaseSession()?.accessToken) {
      setError("Sign in with Pi to accept deliveries. Guest browsing can view jobs but not take them.")
      return
    }
    setPending(true)
    setError("")
    try {
      window.localStorage.setItem(WHATSAPP_STORAGE_KEY, whatsapp.trim())
    } catch {}
    const result = await acceptGuestJobAsync({
      trackingId: job.trackingId,
      accepterWhatsapp: whatsapp.trim(),
    })
    setPending(false)
    if (!result) {
      setError("This job is no longer available. Another courier may have taken it.")
      return
    }
    setRevealed(result)
    onAccepted(job.trackingId)
  }

  const handleClose = () => {
    setRevealed(null)
    setError("")
    onClose()
  }

  return (
    <Sheet open={!!job} onOpenChange={(open) => { if (!open) handleClose() }}>
      <SheetContent side="bottom" className="max-h-[85vh] overflow-y-auto">
        <SheetHeader>
          <SheetTitle>
            {job ? `${job.pickupArea} \u2192 ${job.dropoffArea}` : ""}
          </SheetTitle>
        </SheetHeader>
        {job && !revealed && (
          <div className="space-y-4 pt-2">
            <div className="flex items-center gap-1.5">
              <Badge className="text-[10px]" style={{ backgroundColor: "#15803D" }}>
                Guest delivery
              </Badge>
              <Badge variant="secondary" className="text-[10px]">
                Phone-verified sender
              </Badge>
            </div>
            <p className="text-2xl font-bold" style={{ color: "#15803D" }}>
              {job.quoteCedis ?? "?"} GHS
              <span className="text-sm font-normal text-muted-foreground">
                {" "}paid to you on delivery
              </span>
            </p>
            <p className="text-xs text-muted-foreground">
              You keep the full amount, {job.paymentType === "momo" ? "MoMo" : "cash"} on
              delivery. No Pi fee. Sender contact and landmarks are revealed once
              you accept.
            </p>
            <div className="space-y-1.5">
              <Label htmlFor="gj-wa">Your WhatsApp number</Label>
              <Input
                id="gj-wa"
                type="tel"
                placeholder="0XX XXX XXXX"
                value={whatsapp}
                onChange={(e) => setWhatsapp(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Shared with Gyema dispatch to coordinate pickup.
              </p>
            </div>
            {error && (
              <p className="text-sm" style={{ color: "#DC2626" }}>{error}</p>
            )}
            <Button
              className="w-full h-11"
              disabled={pending || !whatsapp.trim()}
              onClick={handleAccept}
            >
              {pending ? "Accepting..." : "Accept this delivery"}
            </Button>
          </div>
        )}
        {revealed && (
          <div className="space-y-4 pt-2">
            <p className="text-sm font-semibold" style={{ color: "#15803D" }}>
              You have this delivery. Contact details:
            </p>
            <div className="rounded-md border p-3 space-y-1 text-sm">
              <p><span className="text-muted-foreground">Sender:</span> {revealed.senderPhone}</p>
              <p><span className="text-muted-foreground">Pickup:</span> {revealed.pickupArea}{revealed.pickupLandmark ? `, ${revealed.pickupLandmark}` : ""}</p>
              <p><span className="text-muted-foreground">Recipient:</span> {revealed.recipientName ?? "-"} {revealed.recipientPhone ? `(${revealed.recipientPhone})` : ""}</p>
              <p><span className="text-muted-foreground">Drop-off:</span> {revealed.dropoffArea}{revealed.dropoffLandmark ? `, ${revealed.dropoffLandmark}` : ""}</p>
              <p><span className="text-muted-foreground">You collect:</span> {revealed.quoteCedis} GHS ({revealed.paymentType === "momo" ? "MoMo" : "cash"})</p>
            </div>
            <p className="text-xs text-muted-foreground">
              Gyema dispatch will message you on WhatsApp to coordinate. The
              sender can follow progress on the Track page with {revealed.trackingId}.
            </p>
            <Button className="w-full h-11" variant="outline" onClick={handleClose}>
              Done
            </Button>
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}