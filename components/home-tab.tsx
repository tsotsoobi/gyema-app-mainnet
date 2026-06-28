"use client"

import { useState, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  type Listing,
  type PackageSize,
} from "@/lib/listings"
import {
  createPackageAsync,
  createTripAsync,
  getOpenListingsAsync,
} from "@/lib/listings-async"
import { isGuest, type PiUser, type UserRole } from "@/lib/pi-network"
import { ListingDetailSheet } from "./listing-detail-sheet"
import { GuestPostGate } from "./guest-post-gate"

// Bounded city list for normalized origin/destination matching.
// Start with the Accra beachhead; grow as corridors open. Keeping this
// constrained is what makes local-first board surfacing possible: free
// text ("accra"/"Accra"/"Acra") would never match a "near me" filter.
const GHANA_CITIES = [
  "Accra", "Tema", "Kasoa", "Kumasi", "Koforidua", "Cape Coast",
  "Takoradi", "Nkawkaw", "Obuasi", "Tarkwa", "Ho", "Hohoe",
  "Sunyani", "Techiman", "Tamale", "Berekum", "Kintampo", "Goaso",
  "Bechem", "Yendi", "Sefwi Wiawso", "Bibiani", "Bolgatanga", "Bawku",
  "Wa", "Jirapa", "Dambai", "Jasikan", "Damongo", "Salaga",
  "Nalerigu", "Walewale",
] as const

interface HomeTabProps {
  role: UserRole
  user: PiUser
  refreshKey: number
  onListingCreated: () => void
  onSignedIn: (user: PiUser) => void
}

export function HomeTab({ role, user, refreshKey, onListingCreated, onSignedIn }: HomeTabProps) {
  if (role === "traveller") {
    return (
      <TravellerHome
        user={user}
        refreshKey={refreshKey}
        onCreated={onListingCreated}
        onSignedIn={onSignedIn}
      />
    )
  }
  return (
    <SenderHome
      user={user}
      refreshKey={refreshKey}
      onCreated={onListingCreated}
      onSignedIn={onSignedIn}
    />
  )
}

// Traveller view: Available Jobs feed + collapsible Register a Trip form
function TravellerHome({
  user,
  refreshKey,
  onCreated,
  onSignedIn,
}: {
  user: PiUser
  refreshKey: number
  onCreated: () => void
  onSignedIn: (user: PiUser) => void
}) {
  const [showForm, setShowForm] = useState(false)
  const [selected, setSelected] = useState<Listing | null>(null)
  const [listings, setListings] = useState<Listing[]>([])
  const [fromCity, setFromCity] = useState("")
  const [toCity, setToCity] = useState("")
  const [travelDate, setTravelDate] = useState("")
  const [capacity, setCapacity] = useState<PackageSize | "">("")
  const [price, setPrice] = useState("")
  const [notes, setNotes] = useState("")
  const [whatsapp, setWhatsapp] = useState("")
  const [submitted, setSubmitted] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    let cancelled = false
    getOpenListingsAsync().then((all) => {
      if (cancelled) return
      setListings(all.filter((l) => l.kind === "package" && l.postedById !== user.uid))
    })
    return () => {
      cancelled = true
    }
  }, [user.uid, refreshKey])

  const valid =
    fromCity.trim() &&
    toCity.trim() &&
    travelDate &&
    capacity &&
    price &&
    whatsapp.trim()

  const handleSubmit = async () => {
    if (!valid || submitting) return
    setSubmitting(true)
    try {
      const listing = await createTripAsync({
        fromCity: fromCity.trim(),
        toCity: toCity.trim(),
        travelDate,
        capacity: capacity as PackageSize,
        pricePi: parseFloat(price),
        notes: notes.trim(),
        postedById: user.uid,
        postedByUsername: user.username,
        whatsapp: whatsapp.trim(),
      })
      if (!listing) {
        alert("Could not register your trip. Check your connection and try again.")
        return
      }
      setSubmitted(listing.trackingId)
      setFromCity("")
      setToCity("")
      setTravelDate("")
      setCapacity("")
      setPrice("")
      setNotes("")
      setWhatsapp("")
      setShowForm(false)
      onCreated()
    } catch (e) {
      console.error("[gyema] Could not register trip:", e)
      alert("Could not register your trip. Check your connection and try again.")
    } finally {
      setSubmitting(false)
    }
  }

  // The traveller's WhatsApp number to pass to the detail sheet so they can
  // accept deliveries. Reuses the value typed into the Register-a-Trip form
  // if available; otherwise defers (Accept will prompt them to add one).
  const travellerWhatsapp = whatsapp.trim() || undefined

  if (submitted) {
    return (
      <div className="px-4 py-4 space-y-3">
        <Card className="p-6 space-y-3 text-center bg-green-50 border-green-200">
          <div className="text-4xl">✅</div>
          <h2 className="text-lg font-semibold text-green-900">Trip registered!</h2>
          <p className="text-sm text-green-800">
            Senders heading your way can now see your route.
          </p>
          <div className="bg-white rounded-lg p-3 mt-3">
            <p className="text-xs text-muted-foreground">Your tracking ID</p>
            <p className="text-lg font-bold font-mono text-primary">{submitted}</p>
          </div>
          <Button variant="outline" onClick={() => setSubmitted(null)} className="w-full mt-2">
            Done
          </Button>
        </Card>
      </div>
    )
  }

  return (
    <div className="px-4 py-4 space-y-3" data-refresh={refreshKey}>
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Available Jobs</h2>
        <Badge variant="secondary" className="text-xs">
          {listings.length} open
        </Badge>
      </div>

      {listings.length === 0 ? (
        <Card className="p-8 text-center space-y-2">
          <div className="text-4xl">📭</div>
          <p className="text-sm font-medium">No open jobs right now</p>
          <p className="text-xs text-muted-foreground">
            Check back soon. Senders post deliveries throughout the day.
          </p>
        </Card>
      ) : (
        <div className="space-y-2">
          {listings.map((l) => (
            <button
              key={l.id}
              onClick={() => setSelected(l)}
              className="w-full text-left"
            >
              <Card className="p-4 space-y-2 hover:border-primary transition-colors">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold text-sm truncate">
                      {l.fromCity} → {l.toCity}
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
                      {l.kind === "package" ? l.description : ""}
                    </p>
                  </div>
                  <div className="gyema-gold-gradient rounded-md px-2.5 py-1 text-xs font-bold text-amber-950 whitespace-nowrap">
                    {l.kind === "package" ? l.offerPi : 0} π
                  </div>
                </div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span>📅 {formatDate(l.kind === "package" ? l.deliverBy : "")}</span>
                  <span>·</span>
                  <span>📦 {l.kind === "package" ? l.size : ""}</span>
                  <span>·</span>
                  <span className="font-mono text-[10px]">{l.trackingId}</span>
                </div>
              </Card>
            </button>
          ))}
        </div>
      )}

      <Button
        variant={showForm ? "outline" : "default"}
        className="w-full h-12 text-base font-semibold"
        onClick={() => setShowForm(!showForm)}
      >
        {showForm ? "Cancel" : "✈️ Register a Trip"}
      </Button>

      {showForm && (
        isGuest(user) ? (
          <GuestPostGate context="trip" onSignedIn={onSignedIn} />
        ) : (
          <Card className="p-4 space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="t-from">From City</Label>
                <Select value={fromCity} onValueChange={setFromCity}>
                  <SelectTrigger id="t-from">
                    <SelectValue placeholder="Select city" />
                  </SelectTrigger>
                  <SelectContent>
                    {GHANA_CITIES.map((city) => (
                      <SelectItem key={city} value={city}>
                        {city}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="t-to">To City</Label>
                <Select value={toCity} onValueChange={setToCity}>
                  <SelectTrigger id="t-to">
                    <SelectValue placeholder="Select city" />
                  </SelectTrigger>
                  <SelectContent>
                    {GHANA_CITIES.map((city) => (
                      <SelectItem key={city} value={city}>
                        {city}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="t-date">Travel Date</Label>
              <Input
                id="t-date"
                type="date"
                value={travelDate}
                onChange={(e) => setTravelDate(e.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="t-capacity">Capacity</Label>
              <Select value={capacity} onValueChange={(v) => setCapacity(v as PackageSize)}>
                <SelectTrigger id="t-capacity">
                  <SelectValue placeholder="How much can you carry?" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="envelope">Envelope / documents</SelectItem>
                  <SelectItem value="small">Small (under 2 kg)</SelectItem>
                  <SelectItem value="medium">Medium (2–10 kg)</SelectItem>
                  <SelectItem value="large">Large (10 kg+)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="t-price">Your Price (π Pi)</Label>
              <Input
                id="t-price"
                type="number"
                inputMode="decimal"
                min="0"
                step="0.1"
                placeholder="10"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="t-notes">Notes (optional)</Label>
              <Textarea
                id="t-notes"
                placeholder="e.g. leaving morning, fragile items welcome"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={2}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="t-whatsapp">WhatsApp Number</Label>
              <Input
                id="t-whatsapp"
                type="tel"
                inputMode="tel"
                placeholder="+233 24 123 4567"
                value={whatsapp}
                onChange={(e) => setWhatsapp(e.target.value)}
              />
              <p className="text-[11px] text-muted-foreground">
                Senders will use this to coordinate with you.
              </p>
            </div>

            <Button
              className="w-full h-12 text-base font-semibold"
              onClick={handleSubmit}
              disabled={!valid || submitting}
            >
              {submitting ? "Registering..." : "Register Trip"}
            </Button>
          </Card>
        )
      )}

      <Card className="p-4 bg-amber-50 border-amber-200">
        <p className="text-xs text-amber-900 leading-relaxed">
          ⚠️ Inspect packages before accepting. Never carry sealed items you can't
          verify, cash, or anything illegal. Gyema is not responsible for the
          contents of packages.
        </p>
      </Card>

      {selected && (
        <ListingDetailSheet
          listing={selected}
          currentUser={{
            uid: user.uid,
            username: user.username,
            whatsapp: travellerWhatsapp,
          }}
          onClose={() => setSelected(null)}
          onSignedIn={onSignedIn}
          onListingUpdated={(updated) => {
            setListings((prev) =>
              updated.status === "open"
                ? prev.map((l) => (l.id === updated.id ? updated : l))
                : prev.filter((l) => l.id !== updated.id),
            )
            setSelected(updated)
          }}
        />
      )}
    </div>
  )
}

// Sender view: Available Trips feed + collapsible Post a Delivery form
function SenderHome({
  user,
  refreshKey,
  onCreated,
  onSignedIn,
}: {
  user: PiUser
  refreshKey: number
  onCreated: () => void
  onSignedIn: (user: PiUser) => void
}) {
  const [showForm, setShowForm] = useState(false)
  const [selected, setSelected] = useState<Listing | null>(null)
  const [description, setDescription] = useState("")
  const [size, setSize] = useState<PackageSize | "">("")
  const [fromCity, setFromCity] = useState("")
  const [toCity, setToCity] = useState("")
  const [deliverBy, setDeliverBy] = useState("")
  const [offer, setOffer] = useState("")
  const [whatsapp, setWhatsapp] = useState("")
  const [submitted, setSubmitted] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [trips, setTrips] = useState<Listing[]>([])

  useEffect(() => {
    let cancelled = false
    getOpenListingsAsync().then((all) => {
      if (cancelled) return
      setTrips(all.filter((l) => l.kind === "trip" && l.postedById !== user.uid))
    })
    return () => {
      cancelled = true
    }
  }, [user.uid, refreshKey])

  const valid =
    description.trim() &&
    size &&
    fromCity.trim() &&
    toCity.trim() &&
    deliverBy &&
    offer &&
    whatsapp.trim()

  const handleSubmit = async () => {
    if (!valid || submitting) return
    setSubmitting(true)
    try {
      const listing = await createPackageAsync({
        description: description.trim(),
        size: size as PackageSize,
        fromCity: fromCity.trim(),
        toCity: toCity.trim(),
        deliverBy,
        offerPi: parseFloat(offer),
        postedById: user.uid,
        postedByUsername: user.username,
        whatsapp: whatsapp.trim(),
      })
      if (!listing) {
        alert("Could not post your delivery. Check your connection and try again.")
        return
      }
      setSubmitted(listing.trackingId)
      setDescription("")
      setSize("")
      setFromCity("")
      setToCity("")
      setDeliverBy("")
      setOffer("")
      setWhatsapp("")
      setShowForm(false)
      onCreated()
    } catch (e) {
      console.error("[gyema] Could not post delivery:", e)
      alert("Could not post your delivery. Check your connection and try again.")
    } finally {
      setSubmitting(false)
    }
  }

  const senderWhatsapp = whatsapp.trim() || undefined

  if (submitted) {
    return (
      <div className="px-4 py-4 space-y-3">
        <Card className="p-6 space-y-3 text-center bg-green-50 border-green-200">
          <div className="text-4xl">✅</div>
          <h2 className="text-lg font-semibold text-green-900">Delivery posted!</h2>
          <p className="text-sm text-green-800">
            Travellers heading your way can now see this job.
          </p>
          <div className="bg-white rounded-lg p-3 mt-3">
            <p className="text-xs text-muted-foreground">Your tracking ID</p>
            <p className="text-lg font-bold font-mono text-primary">{submitted}</p>
          </div>
          <Button variant="outline" onClick={() => setSubmitted(null)} className="w-full mt-2">
            Done
          </Button>
        </Card>
      </div>
    )
  }

  return (
    <div className="px-4 py-4 space-y-3" data-refresh={refreshKey}>
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Available Trips</h2>
        <Badge variant="secondary" className="text-xs">
          {trips.length} open
        </Badge>
      </div>

      {trips.length === 0 ? (
        <Card className="p-8 text-center space-y-2">
          <div className="text-4xl">✈️</div>
          <p className="text-sm font-medium">No travellers right now</p>
          <p className="text-xs text-muted-foreground">
            Travellers register routes throughout the day. Post your delivery and a match will find you.
          </p>
        </Card>
      ) : (
        <div className="space-y-2">
          {trips.map((l) => (
            <button
              key={l.id}
              onClick={() => setSelected(l)}
              className="w-full text-left"
            >
              <Card className="p-4 space-y-2 hover:border-primary transition-colors">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold text-sm truncate">
                      {l.fromCity} → {l.toCity}
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
                      {l.kind === "trip" ? l.notes || "Available for delivery" : ""}
                    </p>
                  </div>
                  <div className="gyema-gold-gradient rounded-md px-2.5 py-1 text-xs font-bold text-amber-950 whitespace-nowrap">
                    {l.kind === "trip" ? l.pricePi : 0} π
                  </div>
                </div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span>📅 {formatDate(l.kind === "trip" ? l.travelDate : "")}</span>
                  <span>·</span>
                  <span>📦 {l.kind === "trip" ? l.capacity : ""}</span>
                  <span>·</span>
                  <span className="font-mono text-[10px]">{l.trackingId}</span>
                </div>
              </Card>
            </button>
          ))}
        </div>
      )}

      <Button
        variant={showForm ? "outline" : "default"}
        className="w-full h-12 text-base font-semibold"
        onClick={() => setShowForm(!showForm)}
      >
        {showForm ? "Cancel" : "📦 Post a Delivery"}
      </Button>

      {showForm && (
        isGuest(user) ? (
          <GuestPostGate context="package" onSignedIn={onSignedIn} />
        ) : (
          <Card className="p-4 space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="desc">Package Description</Label>
              <Textarea
                id="desc"
                placeholder="e.g. sealed box of phone accessories"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="size">Package Size</Label>
              <Select value={size} onValueChange={(v) => setSize(v as PackageSize)}>
                <SelectTrigger id="size">
                  <SelectValue placeholder="Select size" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="envelope">Envelope / documents</SelectItem>
                  <SelectItem value="small">Small (under 2 kg)</SelectItem>
                  <SelectItem value="medium">Medium (2–10 kg)</SelectItem>
                  <SelectItem value="large">Large (10 kg+)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="from">From City</Label>
                <Select value={fromCity} onValueChange={setFromCity}>
                  <SelectTrigger id="from">
                    <SelectValue placeholder="Select city" />
                  </SelectTrigger>
                  <SelectContent>
                    {GHANA_CITIES.map((city) => (
                      <SelectItem key={city} value={city}>
                        {city}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="to">To City</Label>
                <Select value={toCity} onValueChange={setToCity}>
                  <SelectTrigger id="to">
                    <SelectValue placeholder="Select city" />
                  </SelectTrigger>
                  <SelectContent>
                    {GHANA_CITIES.map((city) => (
                      <SelectItem key={city} value={city}>
                        {city}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="deadline">Deadline</Label>
              <Input
                id="deadline"
                type="date"
                value={deliverBy}
                onChange={(e) => setDeliverBy(e.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="offer">Your Offer (π Pi)</Label>
              <Input
                id="offer"
                type="number"
                inputMode="decimal"
                min="0"
                step="0.1"
                placeholder="5"
                value={offer}
                onChange={(e) => setOffer(e.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="s-whatsapp">WhatsApp Number</Label>
              <Input
                id="s-whatsapp"
                type="tel"
                inputMode="tel"
                placeholder="+233 24 123 4567"
                value={whatsapp}
                onChange={(e) => setWhatsapp(e.target.value)}
              />
              <p className="text-[11px] text-muted-foreground">
                Travellers will use this to coordinate with you.
              </p>
            </div>

            <Button
              className="w-full h-12 text-base font-semibold"
              onClick={handleSubmit}
              disabled={!valid || submitting}
            >
              {submitting ? "Posting..." : "Post Delivery Request"}
            </Button>
          </Card>
        )
      )}

      <Card className="p-4 bg-amber-50 border-amber-200">
        <p className="text-xs text-amber-900 leading-relaxed">
          ⚠️ Never send illegal items, cash, or anything you wouldn't trust a stranger
          with. Gyema is not responsible for the contents of packages.
        </p>
      </Card>

      {selected && (
        <ListingDetailSheet
          listing={selected}
          currentUser={{
            uid: user.uid,
            username: user.username,
            whatsapp: senderWhatsapp,
          }}
          onClose={() => setSelected(null)}
          onSignedIn={onSignedIn}
          onListingUpdated={(updated) => {
            setTrips((prev) =>
              updated.status === "open"
                ? prev.map((l) => (l.id === updated.id ? updated : l))
                : prev.filter((l) => l.id !== updated.id),
            )
            setSelected(updated)
          }}
        />
      )}
    </div>
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
