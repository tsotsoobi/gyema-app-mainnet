# Deploy order

Four migrations, one backfill script and a branch of code changes. They
interlock, and the order is not interchangeable: several combinations break
something a person can see.

Testnet first, verified in the Pi Browser, then Mainnet on an explicit go ahead
per change. Every SQL statement is applied by hand through the Supabase
dashboard with the project breadcrumb confirmed, per CLAUDE.md. Nothing here is
applied by an agent, and Mainnet is read only to agents throughout.

## Status: applied, both networks

**All four migrations are applied and catalog verified on both networks.**
Testnet on 7 September 2026, Mainnet on 8 September 2026, with a catalog check
after each file rather than a reading of the Success banner, per invariant 8.
The ceiling was additionally confirmed live on Testnet on 7 September by a
sender card counting down to "9 tries left before it locks".

What follows is kept as the record of the order and the reasoning, not as work
outstanding. Anything below written in the future tense describes a step that
has already run.

---

## The sequence, per network

| # | Step | What it is |
|---|---|---|
| 1 | Code deploy | merge `hardening`, wait for a Production deployment |
| 2 | Backfill | `npm run backfill:app-metadata` |
| 3 | Catalog check | `docs/catalog-checks.sql` |
| 4 | Grant baseline | `db/migrations/2026-09-07_grant_baseline.sql` |
| 5 | Catalog check | again |
| 6 | Identity migration | `db/migrations/2026-09-07_identity_from_app_metadata.sql` |
| 7 | Catalog check | again |
| 8 | Last-4 ceiling | `db/migrations/2026-09-07_last4_attempt_ceiling.sql` |
| 9 | Reader migration | `db/migrations/2026-09-07_dispatch_reader_masked_view.sql` |
| 10 | Catalog check | last one |
| 11 | Pi Browser | the checks no query can answer |

The blocker from the previous version of this document is gone: the three status
transitions are server routes now (`cancel-open`, `cancel-matched`,
`mark-in-transit`), so the grant baseline applies unmodified with `status` out of
the UPDATE grant.

---

### 1. Deploy the code

Merge the `hardening` branch and wait for a new Production deployment to appear.
Per CLAUDE.md the merge gate is both facts: `main` fast forwards on `git pull`
**and** a Production deployment shows up. A green branch build is not a merge.

Code first, because the code tolerates the old database state and the new one:

- reads name their columns, which the current wide grant permits;
- the counterpart RPC is called only for a matched listing by a party to it, and
  `getCounterpartContactAsync` returns null if the function does not exist yet,
  so the contact button simply does not render;
- the status routes use the service_role key, which is unaffected by grants;
- the last-4 ceiling reads `last4_attempts` off the row.

  **This bullet was wrong and is corrected rather than deleted, because it was
  relied on.** It claimed that until the column existed the read was undefined
  and the guard treated it as zero, so the code tolerated the old database
  state. That would hold for a `select("*")`. All three sender-side routes name
  `last4_attempts` in an explicit column list, and PostgREST answers an unknown
  column with 42703 rather than with a null, so the select fails and the route
  returns `lookup_failed`. Deploying that code ahead of this migration would
  have taken revealing a delivery code, confirming pickup and confirming
  delivery out of service, rather than degrading them.

  It did not happen: the migration was applied on 7 September and the code
  reached production behind it. The ordering constraint was real in the
  opposite direction from the one written here, and it is recorded so a future
  reader does not lean on the same false tolerance.

The reverse order is what breaks. Apply the grant baseline first and every
listing read in the deployed app is a `select("*")` against a column level
grant, so the feed, My Activity and the public tracker empty out at once.

**One deliberate regression to know about:** the Pi access token is no longer
persisted, so a cold app start re-authenticates with the Pi SDK rather than
replaying a stored credential. In Pi Browser that is the same one tap the
Pioneer already makes; outside Pi Browser there is no restore at all, which was
already true of everything else there.

### 2. Backfill app_metadata

```
NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
  node scripts/backfill-app-metadata.mjs           # dry run first
  node scripts/backfill-app-metadata.mjs --apply
```

Take both values from **the network you are working on** and confirm which that
is: the script prints the project ref back before it does anything. Dry run
first, always. It prints counts only, never a uid, username or email.

This must land **after** the code deploy and **before** the identity migration.
After, because `/api/auth/verify` writes `app_metadata` on every sign in and the
backfill is only for accounts that have not signed in since. Before, because the
identity migration's policies read `app_metadata`, and an account without it
matches nothing: their listings vanish from My Activity until they sign in
again.

Read the two counts that matter. **"no identity to copy"** is fine and expected
for any account that never completed a sign in. **"app_metadata already differs"**
is worth looking at by hand: most likely an old rotated `pi_uid`, possibly
somebody who edited their own metadata. The script keeps `app_metadata` and
writes nothing in that case, and it will not name them, by design.

### 3. Catalog check

Run `docs/catalog-checks.sql` and keep the output. This is the "before" for the
next three steps.

### 4. Grant baseline

`db/migrations/2026-09-07_grant_baseline.sql`, one statement at a time, reading
each result. Expect five notices: the revoke count, the anon grant, the
authenticated grant, the service_role count, and either the `rls_auto_enable`
revoke (Mainnet) or "not present on this project" (Testnet).

Then its own section 7 checks (a) through (g). Note (a) expects **exactly one**
row (`authenticated / listings / INSERT`) and (b) expects **exactly two**, both
`INSERT`. Zero rows in (b) would mean a poster cannot write their own number
when they create a listing.

### 5. Catalog check

What must have changed:

- `check_03b_table_grants_catalog`: for anon and authenticated, one row only.
- `check_04b_column_grants_catalog`: `whatsapp` and `matched_with_whatsapp` with
  `INSERT` only, never SELECT or UPDATE. `authenticated` UPDATE on listings is
  exactly `archived_at` and `archived_by_matched_at`.
- `check_07_function_acls`: `listing_counterpart_contact` present, security
  definer, `search_path` pinned, EXECUTE to `authenticated` and `service_role`.
- `check_12_public_execute`: zero rows. On Mainnet this is where
  `rls_auto_enable` disappears.
- `check_13_unreferenced_tables`: no anon or authenticated grant on `couriers`,
  `a2u_payments` or `legacy_couriers`.

### 6. Identity migration

`db/migrations/2026-09-07_identity_from_app_metadata.sql`.

It **drops every existing policy on `public.listings`** and creates four, by
discovery rather than by name, and prints what it dropped. Read those notices:
an unexpected policy name going away is something to know about, and the whole
point is that afterwards nothing on that table reads a claim the user can write.

Do not run this before step 2. An account with no `app_metadata.pi_uid` matches
no policy: they can browse, and their own listings look like somebody else's.

### 7. Catalog check

The one that matters is the migration's own section 4(a): **no policy anywhere in
`public` may reference `user_metadata`. Zero rows.** Then 4(b), the same for
functions, then 4(c), exactly four policies on listings, then 4(d), the INSERT
policy pinning `posted_by_id`, which is S-15 closed.

### 8. Last-4 attempt ceiling

`db/migrations/2026-09-07_last4_attempt_ceiling.sql`. Independent of the other
three: one column and one RPC. Its section 3 has the verification, including the
statement for releasing a genuine sender who has locked themselves out.

Applied 7 September on Testnet, 8 September on Mainnet.

An earlier version of this section said the deployed code tolerated the column
being absent, reading it as undefined and treating it as zero. It does not.
The three sender-side routes name `last4_attempts` in an explicit select list,
so an absent column is a 42703 and the route answers `lookup_failed`. This file
is a hard prerequisite for that code, not an enhancement to it. See the
corrected bullet in step 1.

### 9. Reader migration

`db/migrations/2026-09-07_dispatch_reader_masked_view.sql`. Independent of
everything above: the `gyema_reader` role, two views and the masking function.

Ordering inside the pair: this file drops the `gyema_reader_select` policies and
revokes the role's base table grants, and the deployed `scripts/dispatch-reader.mjs`
already reads the views. So on Testnet, where the 2026-08-18 file was applied,
the dispatch report is broken between step 1 and here. It is a hand run operator
tool, so that is scheduling rather than an outage, but do not run a report in
between and read the preflight failure as a mystery.

On Mainnet the 2026-08-18 file was never applied, so this is the first time the
role exists there. It is created WITHOUT LOGIN and cannot connect until you set
a password by hand. Do that only if you want the dispatch report against
Mainnet, and set `GYEMA_READER_CA_CERT` to the **Mainnet** CA first: the script
refuses to connect without a verified certificate and the two networks do not
share one.

### 10. Catalog check

- `check_09_migration_objects`: every `2026-09-07` row present, both
  `gyema_reader_select` rows false, both "gyema_reader holds nothing on base
  table" rows true.
- `check_10_reader_role`: the four session settings.
- `check_04b`: `gyema_reader` holds nothing on `sender_phone` or
  `recipient_phone`.
- Section 8(d) of the reader migration:
  `select public.mask_phone_head_only('0244123456');` answers
  `024******* (10 digits)`, with `3456` nowhere in it.

### 11. Check it in the Pi Browser

The catalog cannot tell you the app works. Fully close and reopen Pi Browser
first, since it caches the bundle hard, and confirm the resolved domain is this
network's production host.

1. Signed out: the listings feed loads.
2. Track a known tracking ID: status shows.
3. Sign in. **This is the app_metadata path**: it stamps the claim before
   minting the session.
4. My Activity loads your listings. If it is empty for an account that has
   listings, that account has no `app_metadata.pi_uid`: re-run the backfill, or
   sign out and in again.
5. Open a matched listing: **the counterparty's WhatsApp button is there and
   opens the right number**. This exercises the RPC end to end.
6. Post a listing with a WhatsApp number. It saves. (Exercises the INSERT
   policy pinning `posted_by_id`.)
7. Cancel an open listing. (Exercises `/api/listings/cancel-open`, one of the
   three transitions that moved server side.)
8. On a matched listing as the **traveller**, Mark as picked up. As the sender
   on the same listing, confirm the button is not offered: the party is derived
   from the listing's kind now, not from the UI.
9. Archive a past listing from My Activity. (The only UPDATE authenticated may
   still write.)
10. Accept a listing and pay the connection fee. (Exercises the bound payment
    routes: approve and complete now require a session and check the payment
    against the listing you just claimed.)
11. On the public tracker for a guest job, enter a wrong last 4 a few times and
    watch the attempts count down, then the right one and confirm it works.

Steps 4, 5, 6 and 10 are the ones these changes can break.

### 12. Then Mainnet

Not before Testnet's step 11 passes and you have said go, per change. A go ahead
for the grant baseline is not a go ahead for the identity migration.

---

## If something goes wrong

**The feed or My Activity is empty after step 4.** The deployed code is older
than the grants: it is still asking for `*`. Confirm which commit is deployed.
Fix forward by redeploying rather than restoring the wide grant.

**My Activity is empty for one account after step 6.** That account has no
`app_metadata.pi_uid`. Re-run the backfill, or have them sign out and in. Do not
roll the policies back: that returns to trusting a field the caller controls.

**Sign in fails with a configuration error after step 1.** The salt guard is
refusing `PIONEER_PASSWORD_SALT`: absent, a placeholder, under 32 characters, or
too few distinct characters. The message says which. Generate one with
`openssl rand -hex 32`, per network, and redeploy. **The two networks must not
share a salt.**

**The WhatsApp button is missing on a matched listing.** In order: does
`listing_counterpart_contact` exist (catalog check 6), does `authenticated` hold
EXECUTE (check 7), does the signed in Pioneer have a row in `public.pioneers`
matching their `auth.uid()`, and does that row's `pi_uid` equal their
`app_metadata.pi_uid`. The RPC requires both to agree and returns nothing when
they do not, which on Testnet can happen after a `pi_uid` rotation: signing in
again restamps it.

**Cancel or Mark as picked up fails.** These are routes now. Check the Vercel
function logs rather than the database: a 401 means no session, a 403 on
mark-in-transit means the caller is not the traveller for that listing's kind.

**A payment is refused after step 1.** The approve and complete routes now
require a session and check the payment against a listing claimed by that
caller. A refusal is logged server side with a specific reason
(`amount_mismatch`, `listing_not_claimed_by_caller`, `unknown_payment_type`);
the client gets a generic one on purpose.

**The dispatch report fails preflight.** The reader migration and the script
disagree about which network is which. The failure names the missing columns.

Rollbacks are in each migration's own verification section. Every one of them
restores something these files exist to close, so treat a rollback as incident
response, not routine.
