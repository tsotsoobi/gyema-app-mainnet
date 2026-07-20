# Gyema

**Peer-to-peer delivery on Pi Network, built in Ghana for the world.**

Gyema connects two sides of every delivery: **Senders** with packages to move, and **Travellers** already making the trip. Pi is the payment rail. This is the Mainnet app, live on Pi Mainnet and served in Pi Browser via gyema8841.pinet.com. The Testnet repo ([tsotsoobi/gyema-app](https://github.com/tsotsoobi/gyema-app)) is the identical-code staging mirror.

- Production: [gyema-app-mainnet.vercel.app](https://gyema-app-mainnet.vercel.app), in Pi Browser at gyema8841.pinet.com
- V2 escrow contracts: [tsotsoobi/gyema-contracts](https://github.com/tsotsoobi/gyema-contracts)
- Company: [Pi Logistics Ltd.](https://pillgh.com)

---

## Architecture

### Stack

- **Frontend:** Next.js (App Router) on Vercel
- **Auth & data:** Supabase (Postgres, asymmetric ECC P-256 JWT signing)
- **Identity provider:** Pi Network SDK (`Pi.authenticate` → Pi Platform `/v2/me`)
- **V2 escrow (in development):** Soroban smart contracts on Pi Mainnet (Protocol 23+)

### Pi → Supabase auth bridge

The non-trivial piece. Pi issues access tokens for Pioneers; Supabase requires its own JWTs signed with ECC P-256. The bridge reconciles the two:

```
Pi.authenticate(scopes)
      │
      ▼
POST /api/auth/verify   ──▶  Pi Platform /v2/me   (verifies access token)
      │
      ▼
findOrCreatePioneerUser  (keyed on pi_username, not pi_uid — see notes below)
      │
      ▼
Supabase Admin API       (provisions auth user with synthetic email + deterministic password)
      │
      ▼
generatePioneerSession   (in-memory; no localStorage)
```

Key files:
- `lib/pi-platform.ts` — Pi `/v2/me` verification
- `lib/supabase-admin.ts` — Supabase admin-API provisioning
- `app/api/auth/verify/route.ts` — bridge endpoint
- `lib/pi-network.ts` — client-side Pi SDK wrapper
- `lib/supabase.ts` — Supabase client

### Why username-keyed reconciliation

Pi Testnet rotates `pi_uid` values across sessions for the same Pioneer (~0.16% rate observed at production scale). `pi_username` is the stable identity anchor. `findOrCreatePioneerUser` resolves identity in three tiers: indexed lookup on `pi_username` (primary), indexed lookup on `pi_uid` (legacy compat), then a `listUsers` fallback that defends against schema drift. The function returns the **canonical** `pi_uid` stored in the Pioneer row, which `generatePioneerSession` must use — passing the rotated session-time uid would authenticate against the wrong `auth.users` record.

This is the kind of platform-level behavior that's not documented and only surfaces under real user load. It's worth flagging for anyone building on Pi: **never key user reconciliation on `pi_uid`**.

### Supabase Auth storage

Supabase Auth users are provisioned with synthetic non-routable emails (`pi-{uid}@gyema.local`, using the IETF-reserved `.local` TLD) and deterministic HMAC-SHA256-derived passwords keyed by a server secret. The actual auth gate is Pi KYC; Supabase Auth is session storage.

### Observability

Every auth bridge call writes to an `auth_events` table with:
- `pi_uid_prefix`, `pi_username`, `supabase_user_id_prefix`
- `user_created` (true on first-time provisioning)
- `error_message`, `elapsed_ms`
- `metadata` jsonb (including `pi_uid_rotated` diagnostic flag)

Recent 7-day metrics: ~1,100 events, ~45 new Pioneers/day, 0 errors, 0.36% pi_uid rotation rate, avg latency 829–1,784 ms.

---

## V2 — On-chain escrow

V1 uses `Pi.createPayment()` for delivery payments. V2 introduces a three-pot escrow with rider performance bonds and admin-arbitrated dispute resolution, deployed as Soroban smart contracts on Pi Mainnet.

Design highlights (full source at [gyema-contracts](https://github.com/tsotsoobi/gyema-contracts)):
- **Customer-confirms-primary release** with 24h rider timeout fallback
- **Atomic two-sided funding** — customer fee and rider bond move in a single transaction
- **Either-party dispute** within the confirmation window
- **Explicit `Allocation` resolution** — admin must supply amounts that sum to exactly the pot
- **Self-deal blocked** at contract level
- 762 lines of Rust, 12 passing tests, full CI green

The v2 escrow contract is deployed and fully proven on Pi Testnet. Mainnet deployment waits on the Pi Core Team opening Soroban to third-party apps. The gyema.pi domain claim is submitted and pending (deadline December 19, 2026).

---

## Roles and flows

Two roles, toggled in the app header:

- **Sender** — posts a delivery (package, route, fee in Pi)
- **Traveller** — posts a trip and accepts matching deliveries

Listings persist server-side via Supabase. Tracking IDs are issued as `GYM-XXXXXX`.

---

## Repository layout

```
gyema-app/
├── app/
│   ├── api/auth/verify/route.ts   ← Pi → Supabase auth bridge
│   ├── layout.tsx
│   └── page.tsx
├── components/
│   ├── sign-in.tsx
│   ├── app-header.tsx
│   ├── bottom-nav.tsx
│   ├── home-tab.tsx
│   ├── trips-tab.tsx
│   ├── track-tab.tsx
│   ├── profile-tab.tsx
│   ├── listing-detail-sheet.tsx
│   ├── welcome-sheet.tsx
│   └── ui/                        ← shadcn primitives
├── lib/
│   ├── pi-network.ts              ← client-side Pi SDK wrapper
│   ├── pi-platform.ts             ← Pi /v2/me verification
│   ├── supabase.ts                ← Supabase client
│   ├── supabase-admin.ts          ← admin-API provisioning
│   └── listings.ts
└── package.json
```

---

## Environment

Production requires these Vercel environment variables:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `PI_API_KEY`
- `PIONEER_PASSWORD_SALT`

Mainnet vs. Testnet is controlled in the Pi Developer Portal app configuration; the frontend reads it from the Pi SDK at runtime.

---

## Status

- **Network:** Pi Mainnet (Protocol 26)
- **First completed delivery:** GYM-2A2DB5, Nungua to Ridge, July 2026 ([public tracker](https://gyema8841.pinet.com/track/GYM-2A2DB5))

---

## Related

- [gyema-contracts](https://github.com/tsotsoobi/gyema-contracts) — Soroban escrow contracts (V2)
- [Pi Logistics Ltd.](https://pillgh.com) — the company behind Gyema

---

## License

Copyright © 2026 Pi Logistics Ltd. All rights reserved.
