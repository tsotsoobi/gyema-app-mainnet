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
import { TurnstileWidget } from "@/components/turnstile-widget"

const GYEMA_WHATSAPP = "233500005780"

const GUEST_SEND_ENABLED = process.env.NEXT_PUBLIC_GUEST_SEND_ENABLED === "true"

// Empty string when the key is not set, which is what switches the whole bot
// check off: TurnstileWidget renders nothing, no token is sent, and the route
// skips verification because its own half of the configuration is missing too.
// Both halves are checked independently on purpose, so a deployment that has
// one and not the other fails in the visible direction rather than the silent
// one (lib/turnstile.ts).
const TURNSTILE_SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? ""

type Step = "form" | "quote" | "done"

/**
 * What to tell a sender whose post was refused.
 *
 * Every branch here is a false positive waiting to happen, which is why each
 * one says what to do rather than that something went wrong. A rate-limited
 * sender who is told "check the form" will edit a form that was already
 * correct and post again, spending another slot on a window that is already
 * full.
 */
function refusalMessage(status: number, reason: unknown): string {
  if (status === 429 || reason === "rate_limited") {
    return "Too many deliveries posted from this number or this network just now. Please wait a few minutes and try again."
  }
  if (reason === "limiter_unavailable") {
    return "We could not confirm this post just now. Please try again in a minute."
  }
  if (reason === "bot_check_failed") {
    return "The browser check did not pass. Please wait for the box above to tick and try again."
  }
  return "Could not create your delivery. Please check the form and try again."
}

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
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null)
  // Bumped after every failed submit. A Turnstile token is single use, so
  // retrying with the one already held would be refused by Cloudflare for a
  // reason that has nothing to do with this sender.
  const [turnstileResetKey, setTurnstileResetKey] = useState(0)
  // The challenge could not run at all, as opposed to not having been solved
  // yet. Kept apart from the token because the two look the same from here and
  // need opposite treatment: waiting is right for one and a dead end for the
  // other.
  const [turnstileUnavailable, setTurnstileUnavailable] = useState(false)

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
          turnstileToken,
        }),
      })
      const body = await res.json()
      if (!res.ok || !body?.ok) {
        // A refusal that the sender can act on beats one generic line. The
        // three cases below are the ones a real person can actually hit, and
        // each of them has a different thing to do about it: wait, retry the
        // check, or fix the form. Anything else keeps the original message.
        setErrorMsg(refusalMessage(res.status, body?.reason))
        // Whatever went wrong, the token is spent. Ask for a fresh one so the
        // next attempt is not refused for the previous attempt's reason.
        setTurnstileResetKey((n) => n + 1)
        return
      }
      setTrackingId(body.trackingId)
      setStep("done")
    } catch {
      setErrorMsg("Network problem. Please try again.")
      setTurnstileResetKey((n) => n + 1)
    } finally {
      setSubmitting(false)
    }
  }

  const waLink = `https://wa.me/${GYEMA_WHATSAPP}?text=${encodeURIComponent(
    offList ? `Quote ${trackingId}: ${pickupArea} to ${dropoffArea}` : `Verify ${trackingId}`
  )}`

  // The way out when the browser check cannot run.
  //
  // Deliberately NOT waLink. That one names a tracking ID, which does not
  // exist yet: it is minted by the post this sender is being prevented from
  // making, so before the done step it interpolates an empty string and the
  // operator receives "Verify " with nothing after it. A fallback that arrives
  // as an unanswerable message is not a fallback.
  //
  // This carries everything the operator needs to post the delivery by hand,
  // because that is what the sender is being asked to hand over.
  const waFallbackLink = `https://wa.me/${GYEMA_WHATSAPP}?text=${encodeURIComponent(
    [
      "Gyema delivery request. The browser check would not load, so I could not post it myself.",
      `Pickup: ${[pickupArea, pickupLandmark].filter(Boolean).join(", ") || "not given"}`,
      `Dropoff: ${[dropoffArea, dropoffLandmark].filter(Boolean).join(", ") || "not given"}`,
      `Package: ${packageSize || "not given"}`,
      contentsNote ? `Contents: ${contentsNote}` : null,
      `Recipient: ${[recipientName, recipientPhone].filter(Boolean).join(", ") || "not given"}`,
      `My number: ${senderPhone || "not given"}`,
      whenPref === "date" && scheduledDate ? `When: ${scheduledDate}` : `When: ${whenPref}`,
      `Payment: ${paymentType}`,
    ]
      .filter(Boolean)
      .join("\n")
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
            Send packages across Accra today. Your courier is a verified Pi Pioneer.
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
                Paid on delivery. A verified Pi Pioneer courier handles your package.
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

            <TurnstileWidget
              siteKey={TURNSTILE_SITE_KEY}
              onToken={(token) => {
                setTurnstileToken(token)
                // A token arriving proves the challenge is running after all,
                // so a stale unavailable flag from a slow first load clears
                // rather than stranding a sender who would now succeed.
                if (token) setTurnstileUnavailable(false)
              }}
              onUnavailable={() => setTurnstileUnavailable(true)}
              resetKey={turnstileResetKey}
            />

            {turnstileUnavailable && (
              <div className="space-y-2 rounded-md border p-3" style={{ borderColor: "#DC2626" }}>
                <p className="text-xs" style={{ color: "#DC2626" }}>
                  The browser check could not load, so this form cannot be sent
                  from here. It is usually an ad blocker, or a public wifi
                  network that wants you to sign in first.
                </p>
                <p className="text-xs text-muted-foreground">
                  Turn the blocker off for this page and reload, or send the
                  delivery straight to us and we will post it for you. The
                  message below is already filled in with what you entered.
                </p>
                <a href={waFallbackLink} target="_blank" rel="noopener noreferrer" className="block">
                  <Button className="w-full h-11" style={{ backgroundColor: "#15803D" }}>
                    Send this delivery on WhatsApp
                  </Button>
                </a>
              </div>
            )}

            {errorMsg && (
              <p className="text-sm" style={{ color: "#DC2626" }}>{errorMsg}</p>
            )}

            <Button
              className="w-full h-11"
              disabled={
                (!offList && quote === null) ||
                !senderPhone.trim() ||
                submitting ||
                // Only ever a gate when Turnstile is configured. Without a site
                // key the widget renders nothing, no token can arrive, and this
                // clause is false, so the button behaves as it always did.
                (TURNSTILE_SITE_KEY !== "" && !turnstileToken)
              }
              onClick={handleSubmit}
            >
              {submitting
                ? "Creating..."
                : TURNSTILE_SITE_KEY !== "" && turnstileUnavailable
                  ? "Browser check unavailable"
                  : TURNSTILE_SITE_KEY !== "" && !turnstileToken
                    ? "Checking your browser..."
                    : "Confirm and verify my number"}
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
              on the Track page. A verified Pi Pioneer courier will handle your
              package.
            </p>
          </Card>
        )}
      </div>
    </div>
  )
}