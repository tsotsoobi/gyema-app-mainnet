"use client"

import { useState } from "react"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { GUEST_AREA_NAMES, quoteCedis } from "@/lib/guest-pricing"

const GYEMA_WHATSAPP = "233500005780"

const GUEST_SEND_ENABLED = process.env.NEXT_PUBLIC_GUEST_SEND_ENABLED === "true"

type Step = "form" | "quote" | "done"

export default function SendPage() {
  const [step, setStep] = useState<Step>("form")
  const [pickupArea, setPickupArea] = useState("")
  const [pickupLandmark, setPickupLandmark] = useState("")
  const [dropoffArea, setDropoffArea] = useState("")
  const [dropoffLandmark, setDropoffLandmark] = useState("")
  const [packageSize, setPackageSize] = useState("")
  const [contentsNote, setContentsNote] = useState("")
  const [recipientName, setRecipientName] = useState("")
  const [recipientPhone, setRecipientPhone] = useState("")
  const [whenPref, setWhenPref] = useState("today")
  const [scheduledDate, setScheduledDate] = useState("")
  const [paymentType, setPaymentType] = useState("cash")
  const [senderPhone, setSenderPhone] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [trackingId, setTrackingId] = useState("")
  const [errorMsg, setErrorMsg] = useState("")
  const [offList, setOffList] = useState(false)

  const quote = offList
    ? null
    : pickupArea && dropoffArea
      ? quoteCedis(pickupArea, dropoffArea)
      : null

  const formComplete =
    pickupArea.trim() && dropoffArea.trim() && packageSize && recipientName && recipientPhone

  const handleSubmit = async () => {
    if (submitting || !senderPhone.trim()) return
    setSubmitting(true)
    setErrorMsg("")
    try {
      const res = await fetch("/api/guest/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pickupArea,
          pickupLandmark: pickupLandmark || null,
          dropoffArea,
          dropoffLandmark: dropoffLandmark || null,
          packageSize,
          contentsNote: contentsNote || null,
          recipientName,
          recipientPhone,
          senderPhone: senderPhone.trim(),
          whenPref,
          scheduledDate: whenPref === "date" ? scheduledDate || null : null,
          paymentType,
          offList,
        }),
      })
      const body = await res.json()
      if (!res.ok || !body?.ok) {
        setErrorMsg("Could not create your delivery. Please check the form and try again.")
        return
      }
      setTrackingId(body.trackingId)
      setStep("done")
    } catch {
      setErrorMsg("Network problem. Please try again.")
    } finally {
      setSubmitting(false)
    }
  }

  const waLink = `https://wa.me/${GYEMA_WHATSAPP}?text=${encodeURIComponent(
    offList ? `Quote ${trackingId}: ${pickupArea} to ${dropoffArea}` : `Verify ${trackingId}`
  )}`

  if (!GUEST_SEND_ENABLED) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6" style={{ backgroundColor: "#FEF7E6" }}>
        <Card className="p-6 max-w-md text-center space-y-2">
          <h1 className="text-xl font-bold">Gyema guest sending is live</h1>
          <p className="text-sm text-muted-foreground">
            Post your delivery on our main app. One tap, no account needed.
          </p>
          <a href="https://gyema8841.pinet.com/send" className="block">
            <Button className="w-full h-11" style={{ backgroundColor: "#15803D" }}>
              Post your delivery now
            </Button>
          </a>
          <p className="text-xs text-muted-foreground">
            Have a tracking ID? You can follow any delivery on the Track page.
          </p>
        </Card>
      </div>
    )
  }
  return (
    <div className="min-h-screen" style={{ backgroundColor: "#FEF7E6" }}>
      <div className="p-4 md:py-8" style={{ background: "linear-gradient(90deg, #1E1B4B, #15803D)" }}>
        <div className="max-w-md md:max-w-2xl mx-auto">
          <h1 className="text-2xl md:text-3xl font-bold text-white">Gyema</h1>
          <p className="text-sm md:text-base text-white/90 mt-1">
            Send packages across Accra today. Your courier is identity-verified.
          </p>
        </div>
      </div>
      <div className="h-1.5 flex">
        <div className="flex-1" style={{ backgroundColor: "#DC2626" }} />
        <div className="flex-1" style={{ backgroundColor: "#F5B800" }} />
        <div className="flex-1" style={{ backgroundColor: "#DC2626" }} />
        <div className="flex-1" style={{ backgroundColor: "#F5B800" }} />
      </div>

      <div className="px-4 py-4 md:py-8 space-y-3 max-w-md md:max-w-2xl mx-auto">
        {step === "form" && (
          <Card className="p-4 md:p-6 space-y-4">
            {!offList ? (
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="g-from">Pickup area</Label>
                  <Select value={pickupArea} onValueChange={setPickupArea}>
                    <SelectTrigger id="g-from">
                      <SelectValue placeholder="Select area" />
                    </SelectTrigger>
                    <SelectContent>
                      {GUEST_AREA_NAMES.map((area) => (
                        <SelectItem key={area} value={area}>
                          {area}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="g-to">Drop-off area</Label>
                  <Select value={dropoffArea} onValueChange={setDropoffArea}>
                    <SelectTrigger id="g-to">
                      <SelectValue placeholder="Select area" />
                    </SelectTrigger>
                    <SelectContent>
                      {GUEST_AREA_NAMES.map((area) => (
                        <SelectItem key={area} value={area}>
                          {area}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="g-from-t">Pickup area</Label>
                  <Input id="g-from-t" placeholder="e.g. Ashongman" value={pickupArea} onChange={(e) => setPickupArea(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="g-to-t">Drop-off area</Label>
                  <Input id="g-to-t" placeholder="e.g. Amasaman" value={dropoffArea} onChange={(e) => setDropoffArea(e.target.value)} />
                </div>
              </div>
            )}
            <button
              type="button"
              onClick={() => { setOffList(!offList); setPickupArea(""); setDropoffArea("") }}
              className="text-xs text-muted-foreground underline text-left"
            >
              {offList ? "Back to the area list" : "Not on the list? Tell us your area"}
            </button>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="g-from-lm">Pickup landmark</Label>
                <Input id="g-from-lm" placeholder="e.g. near Danquah Circle" value={pickupLandmark} onChange={(e) => setPickupLandmark(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="g-to-lm">Drop-off landmark</Label>
                <Input id="g-to-lm" placeholder="e.g. Community 4 market" value={dropoffLandmark} onChange={(e) => setDropoffLandmark(e.target.value)} />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="g-size">Package size</Label>
              <Select value={packageSize} onValueChange={setPackageSize}>
                <SelectTrigger id="g-size">
                  <SelectValue placeholder="Select size" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="small">Small (fits a phone box)</SelectItem>
                  <SelectItem value="medium">Medium (fits a shoe box)</SelectItem>
                  <SelectItem value="large">Large (a carton)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="g-contents">What is it?</Label>
              <Input id="g-contents" placeholder="e.g. documents, clothing" value={contentsNote} onChange={(e) => setContentsNote(e.target.value)} />
              <p className="text-xs text-muted-foreground">
                No sealed items your courier cannot inspect, no cash, nothing
                illegal. Gyema is not responsible for contents.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="g-rname">Recipient name</Label>
                <Input id="g-rname" value={recipientName} onChange={(e) => setRecipientName(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="g-rphone">Recipient phone</Label>
                <Input id="g-rphone" type="tel" placeholder="0XX XXX XXXX" value={recipientPhone} onChange={(e) => setRecipientPhone(e.target.value)} />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="g-when">When?</Label>
              <Select value={whenPref} onValueChange={setWhenPref}>
                <SelectTrigger id="g-when">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="today">Today</SelectItem>
                  <SelectItem value="tomorrow">Tomorrow</SelectItem>
                  <SelectItem value="date">Pick a date</SelectItem>
                </SelectContent>
              </Select>
              {whenPref === "date" && (
                <Input type="date" value={scheduledDate} onChange={(e) => setScheduledDate(e.target.value)} />
              )}
            </div>

            <Button className="w-full h-11" disabled={!formComplete} onClick={() => setStep("quote")}>
              Get my price
            </Button>
            <p className="text-xs text-center text-muted-foreground">
              Are you a Pi Pioneer? Open Gyema in Pi Browser to post directly.
            </p>
          </Card>
        )}

        {step === "quote" && (
          <Card className="p-4 md:p-6 space-y-4">
            <div className="text-center space-y-1">
              <p className="text-sm text-muted-foreground">
                {pickupArea} to {dropoffArea}
              </p>
              {quote !== null ? (
                <p className="text-3xl font-bold" style={{ color: "#15803D" }}>
                  {quote} GHS
                </p>
              ) : offList ? (
                <p className="text-sm font-semibold" style={{ color: "#1E1B4B" }}>
                  New corridor. We will price this route and message you the quote on WhatsApp.
                </p>
              ) : (
                <p className="text-sm" style={{ color: "#DC2626" }}>
                  We could not price this route. Pick areas from the list.
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                Paid on delivery. A KYC-verified Pioneer courier handles your package.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="g-pay">How will you pay?</Label>
              <Select value={paymentType} onValueChange={setPaymentType}>
                <SelectTrigger id="g-pay">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="cash">Cash on delivery</SelectItem>
                  <SelectItem value="momo">MoMo on delivery</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="g-sphone">Your phone number</Label>
              <Input id="g-sphone" type="tel" placeholder="0XX XXX XXXX" value={senderPhone} onChange={(e) => setSenderPhone(e.target.value)} />
              <p className="text-xs text-muted-foreground">
                Ghana SIMs are ID-registered, so verifying your number verifies
                you to your courier, the same way ride apps do.
              </p>
            </div>

            {errorMsg && (
              <p className="text-sm" style={{ color: "#DC2626" }}>{errorMsg}</p>
            )}

            <Button className="w-full h-11" disabled={(!offList && quote === null) || !senderPhone.trim() || submitting} onClick={handleSubmit}>
              {submitting ? "Creating..." : "Confirm and verify my number"}
            </Button>
            <Button variant="ghost" className="w-full h-8 text-xs" onClick={() => setStep("form")}>
              Back
            </Button>
          </Card>
        )}

        {step === "done" && (
          <Card className="p-4 md:p-6 space-y-4 text-center">
            <p className="text-sm text-muted-foreground">Your tracking ID</p>
            <p className="text-2xl font-bold font-mono">{trackingId}</p>
            <div className="rounded-md p-3 text-left space-y-1" style={{ backgroundColor: "#F5B80022", border: "1px solid #F5B80066" }}>
              <p className="text-sm font-semibold">One step left: verify your number</p>
              <p className="text-xs text-muted-foreground">
                Tap the button below and send us the WhatsApp message from the
                phone number you entered. Your delivery goes to a courier once
                we match the number.{offList && " New corridors are priced by hand, so we will message your quote on WhatsApp first."}
              </p>
            </div>
            <a href={waLink} target="_blank" rel="noopener noreferrer">
              <Button className="w-full h-11" style={{ backgroundColor: "#15803D" }}>
                Verify on WhatsApp
              </Button>
            </a>
            <p className="text-xs text-muted-foreground">
              Save your tracking ID. Anyone with it can follow the delivery live
              on the Track page. A KYC-verified Pioneer courier will handle your
              package.
            </p>
          </Card>
        )}
      </div>
    </div>
  )
}