# Deploy order

Two migrations and one code change are ready. They interlock, and the order is
not interchangeable: applying either migration before the code that matches it
breaks something a person can see.

Testnet first, verified in the Pi Browser, then Mainnet on an explicit go ahead
per change. Every SQL statement is applied by hand through the Supabase
dashboard with the project breadcrumb confirmed, per CLAUDE.md. Nothing here is
applied by an agent, and Mainnet is read only to agents throughout.

---

## Blocker: three status writes have to move first

`db/migrations/2026-09-07_grant_baseline.sql` section 3 takes UPDATE on
`listings.status` away from `authenticated`. Three actions still write that
column straight from the browser through the authed client:

| Function | File | Writes |
|---|---|---|
| `cancelOpenListingAsync` | `lib/listings-async.ts` | `status = 'expired'` |
| `cancelMatchedListingAsync` | `lib/listings-async.ts` | `status = 'expired'` |
| `markInTransitAsync` | `lib/listings-async.ts` | `status = 'in_transit'` |

Applying the grant baseline before those move to server routes breaks Cancel and
Mark as picked up on whichever network it was applied to, with a Postgres 42501
the UI currently surfaces as a generic failure.

They are not written yet, and they are not mine to write unreviewed: a status
transition is the shape of change CLAUDE.md says an agent drafts and the founder
reviews line by line. Three routes, each deriving the caller from their session
token and each guarded to the states the transition is legal from, mirroring
`/api/listings/accept` and `/api/listings/release`. That is the next piece of
work, and it is small.

Until it lands there are two options, and the second is the one I would take:

- **Hold the whole grant baseline.** Simple, and it leaves the phone numbers
  readable with the anon key for however long that takes.
- **Split it.** Sections 1, 2, 4, 5 and 6 close S-1, shut the three unreferenced
  tables, add the RPC and take `rls_auto_enable` off PUBLIC, and none of them
  touch `status`. Section 3 grants SELECT, INSERT and the archive UPDATE, which
  the app needs, so it cannot simply be skipped: run section 3 with `status`
  added to the UPDATE grant now, then re-run the file unmodified once the three
  routes ship. Both runs are idempotent. The interim state is no worse than
  today, because `status` is writable today.

Whichever you choose, say so before I write anything further, because it changes
what the routes have to do.

The reader migration has no such dependency and can go on its own.

---

## The sequence, per network

Run it top to bottom on Testnet. Do not start Mainnet until Testnet's step 6
passes and you have said go.

### 1. Deploy the code

Merge the `hardening` branch and wait for a new Production deployment to appear.
Per CLAUDE.md the merge gate is both facts: `main` fast forwards on `git pull`
**and** a Production deployment shows up (Vercel list, or
`gh api repos/<owner>/<repo>/deployments` with status `success`). A green branch
build is not a merge.

Code first, because the code is compatible with both the old grants and the new
ones. It names its columns, which the current wide grant permits, and it calls
the RPC only when the viewer is a party to a matched listing, which fails
harmlessly until the function exists (`getCounterpartContactAsync` returns null
on error, and the contact button simply does not render).

The reverse order is what breaks: apply the grant baseline first and every
listing read in the deployed app is a `select("*")` against a column level
grant, so the feed, My Activity and the public tracker all empty out at once.

### 2. Grant baseline

Paste `db/migrations/2026-09-07_grant_baseline.sql` into the SQL editor, one
statement at a time, reading each result. Expect five notices: the revoke count,
the anon grant, the authenticated grant, the service_role count, and either the
`rls_auto_enable` revoke (Mainnet) or "not present on this project" (Testnet).

Then run the file's own section 7 checks (a) through (g).

### 3. Catalog check

Run `docs/catalog-checks.sql` and read the result against its `expected` block.
What must have changed since the last run:

- `check_03_table_grants` and `check_03b`: for anon and authenticated, exactly
  one row, `authenticated / listings / INSERT`.
- `check_04_column_grants` and `check_04b`: `whatsapp` and
  `matched_with_whatsapp` appear with `INSERT` only, never SELECT or UPDATE.
  `authenticated` UPDATE on listings is exactly `archived_at` and
  `archived_by_matched_at`.
- `check_06_functions` and `check_07_function_acls`:
  `listing_counterpart_contact` present, security definer, `search_path` pinned,
  EXECUTE to `authenticated` and `service_role` only.
- `check_12_public_execute`: zero rows on both networks. On Mainnet this is
  where `rls_auto_enable` disappears.
- `check_13_unreferenced_tables`: no anon or authenticated grant on
  `couriers`, `a2u_payments` or `legacy_couriers`.

### 4. Reader migration

Paste `db/migrations/2026-09-07_dispatch_reader_masked_view.sql`. Independent of
everything above: it touches only the `gyema_reader` role, two views and the
masking function.

Note the ordering inside the pair: this file drops the `gyema_reader_select`
policies and revokes the role's base table grants, and
`scripts/dispatch-reader.mjs` on the deployed branch already reads the views. So
on Testnet, where the 2026-08-18 file was applied, the reader is broken between
step 1 and this step. It is a hand run operator tool, so that gap is a
scheduling detail rather than an outage, but do not run a report in between and
read the preflight failure as a mystery.

On Mainnet the 2026-08-18 file was never applied, so this is the first time the
role exists there. It is created WITHOUT LOGIN and cannot connect until you set
a password by hand. Do that only if you actually want to run the dispatch report
against Mainnet, and set `GYEMA_READER_CA_CERT` to the Mainnet CA first, since
the script now refuses to connect without a verified certificate and the two
networks do not share one.

### 5. Catalog check again

Re-run `docs/catalog-checks.sql`. What must have changed:

- `check_09_migration_objects`: every `2026-09-07` row present, both
  `gyema_reader_select` rows false, both "gyema_reader holds nothing on base
  table" rows true.
- `check_10_reader_role`: the four session settings.
- `check_04b`: `gyema_reader` holds nothing on `sender_phone` or
  `recipient_phone`.
- Run the migration's own section 8(d) as well:
  `select public.mask_phone_head_only('0244123456');` should answer
  `024******* (10 digits)`. The trailing `3456` must not appear anywhere in it.

### 6. Check it in the Pi Browser

The catalog cannot tell you the app still works. On the network you just
changed, fully close and reopen Pi Browser first, since it caches the bundle
hard, and confirm the resolved domain is that network's production host.

1. Open the app signed out. The listings feed loads.
2. Track a known tracking ID. Status shows.
3. Sign in. My Activity loads your listings.
4. Open a matched listing. **The counterparty's WhatsApp button is there and
   opens the right number.** This is the one that exercises the new RPC end to
   end. If it is missing, the RPC returned zero rows: check that your Pioneer
   has a row in `public.pioneers`, since identity resolves through that table
   and not through the JWT.
5. Post a listing with a WhatsApp number. It saves.
6. Archive a listing from My Activity. It disappears from your side.

Steps 4 and 6 are the two the grant baseline can break. Step 6 is the archive
UPDATE, which is the only column pair `authenticated` may still write.

### 7. Then Mainnet

Not before Testnet's step 6 passes and you have said go, per change. A go ahead
for the grant baseline is not a go ahead for the reader migration.

---

## If something goes wrong

**The feed or My Activity is empty after step 2.** The deployed code is older
than the grants: it is still asking for `*`. Confirm which commit is deployed.
The fastest fix is forward, redeploying the right commit, rather than restoring
the wide grant.

**The WhatsApp button is missing on a matched listing.** In order: does
`listing_counterpart_contact` exist (catalog check 6), does `authenticated` hold
EXECUTE (check 7), and does the signed in Pioneer have a row in
`public.pioneers` with a `supabase_user_id` matching their `auth.uid()`.

**Cancel or Mark as picked up fails with a permission error.** Section 3 was
applied before the three routes shipped. See the blocker above.

**The dispatch report fails preflight.** The reader migration and the script
disagree about which network is which. The failure names the missing columns and
points at the migration.

Rollback for the grant baseline is in its section 7. Both rollback paths restore
the phone number exposure the file exists to close, so treat one as incident
response, not routine.
