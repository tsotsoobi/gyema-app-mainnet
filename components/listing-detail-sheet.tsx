"use client"

import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Badge } from "@/components/ui/badge"
import type { Listing } from "@/lib/listings"
import {
  acceptListingAsync,
  releaseListingAsync,
  cancelMatchedListingAsync,
  confirmCompletionAsync,
} from "@/lib/listings-async"
import { createU2APayment, signInAndPersist, type PiUser } from "@/lib/pi-network"

// localStorage key used to persist the user's WhatsApp number across sessions.
// V1.1 keeps this device-local; V2 moves it server-side once we have a profiles
// table. See the WhatsApp prompt in the Accept flow below.
const WHATSAPP_STORAGE_KEY = "gyema_whatsapp"

// Flat connection fee (in π) charged via U2A when a Pioneer accepts a
// listing. Paying it unlocks the counterparty's contact. This is Gyema's
// Option A revenue: the sender pays the traveller directly, peer-to-peer,
// and Gyema charges this flat fee for making the match.
const CONNECTION_FEE_PI = 1

// The viewer's role with respect to this listing.
// - "sender" or "traveller": viewer is a party to the delivery (poster or matched)
// - "outsider": viewer is some other Pioneer browsing the marketplace
// - "self_open": viewer is the original poster while the listing is still open
//                (no Accept button shown to themselves)
type ViewerRole = "sender" | "traveller" | "outsider" | "self_open"

function determineViewerRole(
  listing: Listing,
  viewerUid: string,
): ViewerRole {
  const isPoster = listing.postedById === viewerUid
  const isMatched = listing.matchedWithUserId === viewerUid

  // Open listings: poster sees self_open, others see outsider
  if (listing.status === "open") {
    return isPoster ? "self_open" : "outsider"
  }

  // Once matched, only the two parties have any role
  if (!isPoster && !isMatched) return "outsider"

  // Sender = the party providing the package
  // Traveller = the party physically carrying it
  //
  // Logic:
  //   - kind="package" means a Sender posted asking for delivery,
  //     so the poster is the SENDER and the matched user is the TRAVELLER.
  //   - kind="trip" means a Traveller posted offering capacity,
  //     so the poster is the TRAVELLER and the matched user is the SENDER.
  if (listing.kind === "package") {
    return isPoster ? "sender" : "traveller"
  }
  return isPoster ? "traveller" : "sender"
}

interface ListingDetailSheetProps {
  listing: Listing
  currentUser: {
    uid: string
    username: string
    whatsapp?: string
  }
  onClose: () => void
  onListingUpdated?: (updated: Listing) => void
  onSignedIn?: (user: PiUser) => void
}

export function ListingDetailSheet({
  listing: initialListing,
  currentUser,
  onClose,
  onListingUpdated,
  onSignedIn,
}: ListingDetailSheetProps) {
  // Keep the listing in local state so Accept/Mark-Complete actions
  // re-render the sheet with new buttons immediately, without forcing
  // the parent to refetch and re-mount the component.
  const [listing, setListing] = useState<Listing>(initialListing)

  const [acceptPending, setAcceptPending] = useState(false)
  const [confirmPending, setConfirmPending] = useState(false)
  const [cancelPending, setCancelPending] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [shareCopied, setShareCopied] = useState(false)

  // Persisted WhatsApp number, loaded from localStorage on mount.
  // Falls back to whatever the parent passed in via currentUser.whatsapp
  // (which itself comes from whatever they've typed in a post-a-trip /
  // post-a-delivery form during this session). Either source is fine.
  const [savedWhatsapp, setSavedWhatsapp] = useState<string>("")

  // What the user is typing in the inline prompt right now (only relevant
  // when no saved number exists yet).
  const [whatsappInput, setWhatsappInput] = useState<string>("")

  useEffect(() => {
    if (typeof window === "undefined") return
    try {
      const stored = window.localStorage.getItem(WHATSAPP_STORAGE_KEY)
      if (stored && stored.trim()) {
        setSavedWhatsapp(stored.trim())
      }
    } catch {
      // localStorage can throw in private modes / restricted contexts —
      // fail silently and the user will just be prompted again next time.
    }
  }, [])

  // Effective WhatsApp = whatever we have on hand, in priority order:
  //   1. value passed in by the parent for this session
  //   2. value persisted from a previous session
  // If both are empty, the inline prompt below kicks in.
  const effectiveWhatsapp =
    (currentUser.whatsapp && currentUser.whatsapp.trim()) ||
    savedWhatsapp ||
    ""

  const role = determineViewerRole(listing, currentUser.uid)
  const price = listing.kind === "trip" ? listing.pricePi : listing.offerPi
  const date =
    listing.kind === "trip" ? listing.travelDate : listing.deliverBy

  // --- Share (open listings) --------------------------------------------
  // A shareable deep link to this listing. Uses Pi's pi:// scheme so a
  // tapped link opens directly in Pi Browser and lands on the listing via
  // the ?listing handler in app/page.tsx. Set PI_APP_HOST to whatever host
  // the app resolves at inside Pi Browser. Switch it to "gyema.pi" once that
  // domain claim finalizes; until then use the live PiNet subdomain host.
  const PI_APP_HOST = "gyema8841.pinet.com"
  const shareUrl = `https://${PI_APP_HOST}/?listing=${listing.trackingId}`
  const shareText =
    listing.kind === "package"
      ? `Sender needs a delivery: ${listing.fromCity} → ${listing.toCity} on Gyema (${price} π). Open in Pi Browser to accept:`
      : `Traveller heading ${listing.fromCity} → ${listing.toCity} on Gyema, carrying for ${price} π. Open in Pi Browser to offer your parcel:`
  const shareXHref = `https://twitter.com/intent/tweet?text=${encodeURIComponent(
    `${shareText} ${shareUrl}`,
  )}`
  const shareWhatsappHref = `https://wa.me/?text=${encodeURIComponent(
    `${shareText} ${shareUrl}`,
  )}`

  const handleCopyShareLink = async () => {
    const payload = `${shareText} ${shareUrl}`
    try {
      await navigator.clipboard.writeText(payload)
      setShareCopied(true)
      setTimeout(() => setShareCopied(false), 2000)
    } catch {
      // Clipboard API can be blocked in some webviews; fall back to a
      // hidden textarea + execCommand so the copy still succeeds silently
      // instead of surfacing a prompt() dialog.
      try {
        const ta = document.createElement("textarea")
        ta.value = payload
        ta.style.position = "fixed"
        ta.style.opacity = "0"
        document.body.appendChild(ta)
        ta.focus()
        ta.select()
        document.execCommand("copy")
        document.body.removeChild(ta)
        setShareCopied(true)
        setTimeout(() => setShareCopied(false), 2000)
      } catch {
        window.prompt("Copy this link", payload)
      }
    }
  }

  // Whose contact to surface in the Coordinate section. The rule is simply
  // "show the other person", so it keys on poster-vs-matched IDENTITY, not
  // the sender/traveller delivery role (which is independent of who posted
  // and was the source of the earlier bug where a viewer saw their own
  // number):
  //   - viewer is the POSTER   -> show the matched accepter's contact
  //   - viewer is the ACCEPTER -> show the poster's contact
  // For open listings the contact stays locked, so these only surface once
  // the listing is matched and the viewer is one of the two parties.
  const viewerIsPoster = listing.postedById === currentUser.uid

  const otherPartyWhatsapp = viewerIsPoster
    ? listing.matchedWithWhatsapp
    : listing.whatsapp

  const otherPartyUsername = viewerIsPoster
    ? listing.matchedWithUsername
    : listing.postedByUsername

  const whatsappDigits = (otherPartyWhatsapp ?? "").replace(/\D/g, "")
  const whatsappHref = whatsappDigits
    ? `https://wa.me/${whatsappDigits}?text=${encodeURIComponent(
        `Hi! Re: Gyema delivery ${listing.trackingId}. `,
      )}`
    : null

  const piChatHref = "https://chat.pinet.com/conversation-requests"

  // Guest detection — guests are blocked from all write actions
  // (Accept, Mark Complete, Cancel match) since these mutations require
  // a verifiable Pi identity. A guest will see <GuestActionGate> instead.
  //
  // Inlined here rather than imported from pi-network because the sheet
  // receives a structurally-typed currentUser (uid, username, whatsapp?),
  // not a full PiUser — but the uid check is identical.
  const viewerIsGuest = currentUser.uid.startsWith("guest-")

  const handleAccept = async () => {
    // Prefer (in order): what's typed in the inline prompt right now,
    // already-loaded effectiveWhatsapp, currentUser.whatsapp.
    const inlineNumber = whatsappInput.trim()
    const numberToUse = inlineNumber || effectiveWhatsapp

    if (!numberToUse) {
      setActionError(
        "Add your WhatsApp number above to accept this delivery.",
      )
      return
    }

    // Loose validation — at least 9 digits somewhere in the string. Strict
    // formatting (Ghana +233 prefix etc) is V2 polish.
    const digitsOnly = numberToUse.replace(/\D/g, "")
    if (digitsOnly.length < 9) {
      setActionError(
        "That number looks too short. Please enter a valid WhatsApp number.",
      )
      return
    }

    setAcceptPending(true)
    setActionError(null)

    // If the user typed a fresh number in the inline prompt, persist it now
    // so they don't get prompted again on the next Accept.
    if (inlineNumber && inlineNumber !== savedWhatsapp) {
      try {
        window.localStorage.setItem(WHATSAPP_STORAGE_KEY, inlineNumber)
        setSavedWhatsapp(inlineNumber)
      } catch {
        // If we can't persist, still proceed with the Accept — the user
        // will just be re-prompted next time, which is annoying but not broken.
      }
    }

    // 1) Claim the listing FIRST, server-side and authoritative. The accept
    //    route uses the service_role client, so it bypasses the listings RLS
    //    UPDATE policy, which can never authorize the initial claim (at accept
    //    time the accepter is neither the poster nor yet a matched party, so a
    //    client-side update touches 0 rows). We do NOT charge yet: if the
    //    listing is already taken or not open, we stop here with no payment.
    let claimed: Listing | null = null
    try {
      claimed = await acceptListingAsync({
        listingId: listing.id,
        accepterWhatsapp: numberToUse,
      })
    } catch (err) {
      console.error("[gyema] claim error:", err)
      setActionError("Could not accept this listing. Please try again.")
      setAcceptPending(false)
      return
    }
    if (!claimed) {
      setActionError(
        "This listing is no longer available. Someone may have just accepted it.",
      )
      setAcceptPending(false)
      return
    }

    // 2) Connection fee (U2A). The claim is now held in the Pioneer's name.
    //    Charge the fee; if the Pioneer cancels the Pi dialog or the payment
    //    fails, RELEASE the claim so the listing reopens and nobody is charged
    //    for a match that didn't complete.
    try {
      await createU2APayment({
        amount: CONNECTION_FEE_PI,
        memo: `Gyema connection fee · ${listing.trackingId}`,
        metadata: {
          type: "connection_fee",
          app: "gyema",
          listingId: listing.id,
          trackingId: listing.trackingId,
        },
      })
    } catch (err) {
      console.error("[gyema] connection fee payment failed:", err)
      // Roll the claim back so the listing returns to open.
      await releaseListingAsync({ listingId: listing.id })
      const msg = err instanceof Error ? err.message : "Payment failed."
      setActionError(
        msg === "Payment cancelled."
          ? "Payment cancelled, so the match wasn't completed and the listing is open again. You can accept when you're ready to pay the connection fee."
          : `Payment could not be completed: ${msg}. The listing has been released.`,
      )
      setAcceptPending(false)
      return
    }

    // 3) Paid and matched. Reflect the matched listing (contact now unlocks).
    setListing(claimed)
    onListingUpdated?.(claimed)
    setAcceptPending(false)
  }

  const handleConfirmCompletion = async () => {
    if (role !== "sender" && role !== "traveller") return
    setConfirmPending(true)
    setActionError(null)
    try {
      const updated = await confirmCompletionAsync({
        listingId: listing.id,
        role,
      })
      if (!updated) {
        setActionError("Could not confirm completion. Please try again.")
        setConfirmPending(false)
        return
      }
      setListing(updated)
      onListingUpdated?.(updated)
    } catch (err) {
      console.error("[gyema] handleConfirmCompletion error:", err)
      setActionError("Could not confirm completion. Please try again.")
    } finally {
      setConfirmPending(false)
    }
  }

  // Cancel a matched listing. Either party can call this. Destructive —
  // listing transitions to 'expired' and falls into Past Trips/Deliveries.
  // Confirmation prompt before calling so it's never a one-tap mistake.
  const handleCancelMatch = async () => {
    if (role !== "sender" && role !== "traveller") return
    const confirmed = window.confirm(
      "Cancel this match?\n\n" +
        "The listing will be marked as expired and moved to Past " +
        (role === "traveller" ? "Trips" : "Deliveries") +
        ". This cannot be undone.\n\n" +
        "Use this if the deal fell through or the date passed without completing.",
    )
    if (!confirmed) return

    setCancelPending(true)
    setActionError(null)
    try {
      const updated = await cancelMatchedListingAsync({
        listingId: listing.id,
      })
      if (!updated) {
        setActionError(
          "Could not cancel this listing. It may have already been completed or expired.",
        )
        setCancelPending(false)
        return
      }
      setListing(updated)
      onListingUpdated?.(updated)
    } catch (err) {
      console.error("[gyema] handleCancelMatch error:", err)
      setActionError("Could not cancel this listing. Please try again.")
    } finally {
      setCancelPending(false)
    }
  }

  // Whether THIS viewer has already confirmed their side.
  const viewerHasConfirmed =
    (role === "sender" && listing.senderConfirmed) ||
    (role === "traveller" && listing.travellerConfirmed)

  // Status pill shown at the top of the sheet
  const statusBadge = (() => {
    switch (listing.status) {
      case "open":
        return { text: "Open", variant: "secondary" as const }
      case "matched":
        return { text: "Matched", variant: "default" as const }
      case "in_transit":
        return { text: "In transit", variant: "default" as const }
      case "completed":
        return { text: "Completed", variant: "default" as const }
      case "expired":
        return { text: "Expired", variant: "outline" as const }
      default:
        return { text: listing.status, variant: "secondary" as const }
    }
  })()

  // Show the inline WhatsApp prompt to outsider Pioneers viewing an open
  // listing who don't yet have a number on file. Guests are excluded
  // because their action surface is the gate, not the Accept button.
  const showWhatsappPrompt =
    role === "outsider" &&
    listing.status === "open" &&
    !effectiveWhatsapp &&
    !viewerIsGuest

  return (
    <Sheet open onOpenChange={onClose}>
      <SheetContent
        side="bottom"
        className="rounded-t-2xl px-4 pb-6 pt-4 max-h-[90dvh] overflow-y-auto"
      >
        <SheetHeader className="text-left space-y-1 pb-3">
          <div className="flex items-center justify-between">
            <Badge variant={statusBadge.variant} className="text-xs">
              {statusBadge.text}
            </Badge>
            <span className="text-xs font-mono text-muted-foreground">
              {listing.trackingId}
            </span>
          </div>
          <SheetTitle className="text-xl">
            {listing.fromCity} → {listing.toCity}
          </SheetTitle>
        </SheetHeader>

        <div className="space-y-4 pt-2">
          {listing.kind === "package" && (
            <div>
              <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">
                Package
              </p>
              <p className="text-sm">{listing.description}</p>
              <p className="text-xs text-muted-foreground mt-1">
                Size: {listing.size}
              </p>
            </div>
          )}

          {listing.kind === "trip" && listing.notes && (
            <div>
              <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">
                Notes
              </p>
              <p className="text-sm">{listing.notes}</p>
              <p className="text-xs text-muted-foreground mt-1">
                Capacity: {listing.capacity}
              </p>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <p className="text-xs text-muted-foreground uppercase tracking-wide">
                Date
              </p>
              <p className="text-sm font-medium">{formatDate(date)}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground uppercase tracking-wide">
                Posted by
              </p>
              <p className="text-sm font-medium">@{listing.postedByUsername}</p>
            </div>
          </div>

          <div className="flex items-center justify-between border-t pt-4">
            <div>
              <p className="text-xs text-muted-foreground">Price</p>
              <p className="text-2xl font-bold text-primary">{price} π</p>
            </div>
            <p className="text-[11px] text-muted-foreground text-right max-w-[55%]">
              Coordinate payment off-platform · Pi Escrow coming in v2
            </p>
          </div>

          {/* Coordinate section: contact details for the two matched parties.
              Outsiders no longer see this on open listings — contact is now a
              paid unlock gated behind the connection fee in handleAccept. */}
          {(role === "sender" || role === "traveller") &&
            listing.status !== "completed" &&
            listing.status !== "expired" && (
              <div className="space-y-2 pt-1">
                <p className="text-xs text-muted-foreground uppercase tracking-wide">
                  Coordinate
                </p>
                <div className="grid grid-cols-2 gap-2">
                  {whatsappHref ? (
                    <a
                      href={whatsappHref}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block"
                    >
                      <Button
                        variant="outline"
                        className="w-full h-11 text-sm font-semibold"
                      >
                        💬 WhatsApp
                      </Button>
                    </a>
                  ) : (
                    <Button
                      variant="outline"
                      className="w-full h-11 text-sm font-semibold"
                      disabled
                    >
                      💬 WhatsApp
                    </Button>
                  )}
                  <a
                    href={piChatHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block"
                  >
                    <Button
                      variant="outline"
                      className="w-full h-11 text-sm font-semibold"
                    >
                      π Chat in Pi
                    </Button>
                  </a>
                </div>
                <p className="text-[11px] text-muted-foreground leading-relaxed">
                  In Pi Chat, search{" "}
                  <span className="font-mono">@{otherPartyUsername}</span> to
                  start a conversation.
                </p>
              </div>
            )}

          {/* Outsiders on open listings: contact is locked until they accept
              and pay the connection fee. */}
          {role === "outsider" && listing.status === "open" && (
            <div className="space-y-2 pt-1">
              <p className="text-xs text-muted-foreground uppercase tracking-wide">
                Coordinate
              </p>
              <div className="rounded-lg border border-dashed border-primary/40 bg-primary/5 p-3">
                <p className="text-sm font-medium">
                  🔒 Contact unlocks when you accept
                </p>
                <p className="text-[11px] text-muted-foreground mt-1 leading-relaxed">
                  Accept to unlock @{listing.postedByUsername}'s contact, then
                  arrange the delivery and settle payment directly, peer to peer.
                  A flat {CONNECTION_FEE_PI} π fee applies.
                </p>
              </div>
            </div>
          )}

          {/* Share. Only useful while the listing is still open and looking
              for a counterparty. X and WhatsApp prefill the link; Instagram
              has no link-share intent, so Copy lets the user paste it into a
              story, bio, or DM. */}
          {listing.status === "open" && (
            <div className="space-y-2 pt-1">
              <p className="text-xs text-muted-foreground uppercase tracking-wide">
                Share
              </p>
              <div className="grid grid-cols-3 gap-2">
                <a
                  href={shareXHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block"
                >
                  <Button
                    variant="outline"
                    className="w-full h-11 text-xs font-semibold px-1"
                  >
                    𝕏 Post
                  </Button>
                </a>
                <a
                  href={shareWhatsappHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block"
                >
                  <Button
                    variant="outline"
                    className="w-full h-11 text-xs font-semibold px-1"
                  >
                    💬 WhatsApp
                  </Button>
                </a>
                <Button
                  variant="outline"
                  className="w-full h-11 text-xs font-semibold px-1"
                  onClick={handleCopyShareLink}
                >
                  {shareCopied ? "✓ Copied" : "🔗 Copy"}
                </Button>
              </div>
              <p className="text-[11px] text-muted-foreground leading-relaxed">
                Copy the link to paste into your Instagram story, bio, or DM.
                Shared links open this listing in Pi Browser.
              </p>
            </div>
          )}

          {/* Primary action area — depends on viewer role and listing state */}
          <div className="pt-1 space-y-2">
            {/* Guest viewing an open listing: gate the Accept action. */}
            {viewerIsGuest && role === "outsider" && listing.status === "open" && (
              <GuestActionGate
                headline="Accept this delivery on Gyema"
                onSignedIn={onSignedIn}
              />
            )}

            {/* Pioneer outsider viewing an open listing: normal Accept flow. */}
            {!viewerIsGuest && role === "outsider" && listing.status === "open" && (
              <>
                {showWhatsappPrompt && (
                  <div className="space-y-1.5 rounded-lg border border-primary/40 bg-primary/5 p-3">
                    <Label htmlFor="accept-whatsapp" className="text-sm">
                      Add your WhatsApp number to accept this delivery
                    </Label>
                    <Input
                      id="accept-whatsapp"
                      type="tel"
                      inputMode="tel"
                      placeholder="+233 24 123 4567"
                      value={whatsappInput}
                      onChange={(e) => setWhatsappInput(e.target.value)}
                      className="bg-white"
                    />
                    <p className="text-[11px] text-muted-foreground">
                      Saved on this device — you won't have to enter it again.
                    </p>
                  </div>
                )}
                <Button
                  className="w-full h-12 text-base font-semibold"
                  onClick={handleAccept}
                  disabled={acceptPending}
                >
                  {acceptPending ? "Accepting..." : "Accept this delivery"}
                </Button>
                <p className="text-[11px] text-muted-foreground text-center leading-relaxed">
                  A flat {CONNECTION_FEE_PI} π fee unlocks{" "}
                  @{listing.postedByUsername}'s contact. You then settle the
                  delivery and payment with them directly via WhatsApp or Pi Chat.
                </p>
              </>
            )}

            {role === "self_open" && (
              <p className="text-xs text-muted-foreground text-center leading-relaxed">
                This is your listing. Travellers and Senders will be able to
                accept it from their side.
              </p>
            )}

            {/* Party-only actions (Mark Complete, Cancel match). Guests
                shouldn't reach these in practice — they can't be a party
                to a matched listing — but we gate defensively in case a
                historical guest listing is being viewed by a guest session. */}
            {viewerIsGuest &&
              (role === "sender" || role === "traveller") &&
              (listing.status === "matched" ||
                listing.status === "in_transit") && (
                <GuestActionGate
                  headline="Manage this delivery on Gyema"
                  onSignedIn={onSignedIn}
                />
              )}

            {!viewerIsGuest &&
              (role === "sender" || role === "traveller") &&
              (listing.status === "matched" ||
                listing.status === "in_transit") && (
                <>
                  <div className="rounded-lg bg-muted/40 p-3 space-y-1">
                    <p className="text-xs font-semibold">Confirmation status</p>
                    <p className="text-xs text-muted-foreground">
                      Sender: {listing.senderConfirmed ? "✓ confirmed" : "—"}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Traveller:{" "}
                      {listing.travellerConfirmed ? "✓ confirmed" : "—"}
                    </p>
                  </div>
                  <Button
                    className="w-full h-12 text-base font-semibold"
                    onClick={handleConfirmCompletion}
                    disabled={confirmPending || viewerHasConfirmed}
                  >
                    {viewerHasConfirmed
                      ? "You've confirmed — waiting on the other party"
                      : confirmPending
                        ? "Confirming..."
                        : `Mark as completed (as ${role})`}
                  </Button>
                  <p className="text-[11px] text-muted-foreground text-center leading-relaxed">
                    Both parties must confirm before the delivery is marked
                    completed.
                  </p>

                  {/* V1.1.5 — Cancel match. Either party can pull the plug if
                      the deal fell through or the date passed without
                      completion. Destructive: confirms first, then expires. */}
                  <Button
                    variant="outline"
                    className="w-full h-10 text-sm text-destructive hover:bg-destructive/5 hover:text-destructive border-destructive/40"
                    onClick={handleCancelMatch}
                    disabled={cancelPending || confirmPending}
                  >
                    {cancelPending ? "Cancelling..." : "Cancel match"}
                  </Button>
                </>
              )}

            {listing.status === "completed" && (
              <div className="rounded-lg bg-emerald-50 border border-emerald-200 p-4 space-y-1 text-center">
                <div className="text-2xl">✅</div>
                <p className="text-sm font-semibold text-emerald-900">
                  Delivery completed
                </p>
                <p className="text-xs text-emerald-800">
                  Both parties confirmed. Thank you for using Gyema.
                </p>
              </div>
            )}

            {listing.status === "expired" && (
              <div className="rounded-lg bg-muted/40 p-3 text-center">
                <p className="text-xs text-muted-foreground">
                  This listing has expired and is no longer available.
                </p>
              </div>
            )}

            {actionError && (
              <p className="text-xs text-destructive text-center leading-relaxed">
                {actionError}
              </p>
            )}
          </div>

          <Button variant="ghost" className="w-full" onClick={onClose}>
            Close
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  )
}

// Guest-mode gate shown in place of write actions (Accept, Mark Complete,
// Cancel match) when the current viewer is a guest. Mirrors the post-side
// GuestPostGate in home-tab.tsx for consistent UX language across surfaces.
//
// If onSignedIn isn't wired by the parent (legacy callers), the button
// is hidden — guests still see the explanatory message and can dismiss
// the sheet. This keeps the component backward-compatible.
function GuestActionGate({
  headline,
  onSignedIn,
}: {
  headline: string
  onSignedIn?: (user: PiUser) => void
}) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")

  const handleSignIn = async () => {
    if (!onSignedIn) return
    setError("")
    setLoading(true)
    try {
      const user = await signInAndPersist()
      onSignedIn(user)
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Sign-in failed. Please try again."
      console.error("[gyema] Guest sign-in upgrade failed:", err)
      setError(message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <Card className="p-5 space-y-4 border-primary/40 bg-primary/5">
      <div className="space-y-2">
        <h3 className="font-semibold text-base">{headline}</h3>
        <p className="text-sm text-muted-foreground leading-relaxed">
          Accepting on Gyema requires a Pi identity. This keeps every trip and
          delivery traceable to a real Pioneer.
        </p>
      </div>

      {error && (
        <div className="rounded-md bg-red-50 border border-red-200 p-3 text-xs text-red-900">
          {error}
        </div>
      )}

      {onSignedIn && (
        <Button
          className="w-full h-12 text-base font-semibold"
          onClick={handleSignIn}
          disabled={loading}
        >
          {loading ? "Signing in…" : "Sign in with Pi"}
        </Button>
      )}

      <p className="text-[11px] text-muted-foreground text-center">
        You can keep browsing as a guest. Sign-in is only required to act on
        listings.
      </p>
    </Card>
  )
}

function formatDate(iso: string): string {
  if (!iso) return "—"
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      month: "long",
      day: "numeric",
      year: "numeric",
    })
  } catch {
    return iso
  }
}
