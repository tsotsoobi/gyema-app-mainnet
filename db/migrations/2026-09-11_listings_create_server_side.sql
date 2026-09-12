-- ===========================================================================
-- 2026-09-11  Listing creation moves to a server route
-- ===========================================================================
--
-- THE FINDING (S-15)
--
-- Listing creation was a client side INSERT through the authed client, so the
-- browser composed the whole row. The catalog carries listings_insert_own:
--
--   with check (posted_by_id = ((auth.jwt() -> 'app_metadata') ->> 'pi_uid'))
--
-- That is a good policy and it closed a real hole: one Pioneer could no longer
-- attribute a listing to another Pioneer's uid. It closed ONE COLUMN. The grant
-- behind it is table wide, from 2026-09-07_grant_baseline.sql section 3:
--
--   grant insert on public.listings to authenticated
--
-- so the policy was the only filter on the insert and it filtered one field.
-- Five things were still whatever the client sent, and the first of them
-- crosses a rail boundary:
--
--   1. tracking_id, chosen freely and checked against nothing. No constraint
--      can span public.listings and public.guest_jobs, and BOTH trackers
--      resolve listings before guest jobs, so a listing carrying an existing
--      guest job's code shadowed that delivery on the public tracker. The
--      sender following their parcel saw somebody else's listing. CLAUDE.md
--      invariant 3, the two rails never blend, broken from the Pioneer side.
--   2. matched_with_user_id, so a row could arrive already matched to a victim
--      and show up in their My Activity carrying a phone number its author
--      chose.
--   3. posted_by_username, which the policy does not mention at all, so a
--      Pioneer could post under their own uid and another Pioneer's name.
--   4. status, settable to completed or in_transit at insert, bypassing every
--      transition guard the routes in app/api/listings exist to enforce.
--   5. created_at, future datable, and the open feed orders by it descending.
--
-- WHAT THIS FILE DOES
--
-- Section 1 revokes INSERT on public.listings from authenticated. Creation is
-- app/api/listings/create, which runs with the service_role key, so the route
-- keeps working and nothing else can insert a listing at all. This is what
-- makes the route the only path rather than the preferred one.
--
-- Section 2 is A NO-OP ON BOTH NETWORKS, and is kept rather than deleted.
--
-- An earlier version of this file said the unique index on tracking_id was
-- missing, on the grounds that nothing in db/migrations/ or
-- docs/catalog-checks.sql creates or checks one. That was a statement about
-- this repository and it was read as a statement about the database. It is
-- wrong: public.listings already carries listings_tracking_id_key, a unique
-- index on tracking_id, on both networks. The table predates version control,
-- so its absence from these files says nothing about its absence from the
-- catalog. Invariant 8 in the other direction: a file is not catalog state,
-- and neither is the lack of one.
--
-- So listing-against-listing collisions were never possible, and section 3c
-- will find no duplicates. The guard in section 2 tests for that exact index
-- name, so the CREATE never fires.
--
-- ORDER, AND IT MATTERS
--
-- DEPLOY THE CODE FIRST. Section 1 removes the grant the currently deployed
-- browser bundle relies on, so applying it before app/api/listings/create is
-- live means posting a trip or a package fails with 42501 on whichever network
-- it is applied to. The reverse order is safe: the route uses service_role,
-- which no grant in this file touches, so it works before and after.
--
-- Per CLAUDE.md this is applied BY HAND through the Supabase dashboard, with
-- the project breadcrumb confirmed, Testnet first, Mainnet only on an explicit
-- go ahead. Verify from catalog state, never from the Success banner.

-- ---------------------------------------------------------------------------
-- Section 1. Revoke INSERT on listings from authenticated
-- ---------------------------------------------------------------------------
--
-- A column level revoke cannot subtract from a table wide grant, which is the
-- lesson recorded in the 2026-08-14 migration. This is the table wide grant
-- itself, so revoking it is the whole job: there is no column list to unpick.

revoke insert on public.listings from authenticated;

-- Anon never held it. Asserted rather than assumed, because this file is
-- written to be safe on a project whose grants have drifted.
revoke insert on public.listings from anon;

-- ---------------------------------------------------------------------------
-- Section 2. One tracking ID, one row. NO-OP: the index already exists.
-- ---------------------------------------------------------------------------
--
-- listings_tracking_id_key is already on both networks, and the guard below
-- tests for that name, so this block does nothing and is safe to run. It is a
-- NO-OP rather than a CONFLICT, and the difference is worth being precise
-- about: a conflict would be this file trying to create an index that exists,
-- which raises and stops the script. The guard means the CREATE is never
-- reached.
--
-- It stays in the file for one reason. This migration is written to be safe on
-- a project whose catalog has drifted, and the two networks have drifted
-- before. If some future project is missing the index, this builds it; if it
-- has it, this costs one catalog lookup.
--
-- HAD the index been missing and there been duplicate tracking IDs, the CREATE
-- would fail with a duplicate key error rather than misfiring. Section 3c lists
-- them. That path is now hypothetical on both networks.
--
-- CONCURRENTLY is deliberately NOT used. It cannot run inside a transaction
-- block, and the Supabase SQL editor does not preserve transaction state across
-- executions (CLAUDE.md), so the safe thing in a dashboard is the plain form.

do $$
begin
  if not exists (
    select 1 from pg_indexes
     where schemaname = 'public'
       and tablename = 'listings'
       and indexname = 'listings_tracking_id_key'
  ) then
    execute 'create unique index listings_tracking_id_key
               on public.listings (tracking_id)';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Section 3. Verification, from catalog state
-- ---------------------------------------------------------------------------
--
-- Run each of these and READ THE RESULT. Invariant 8: a Success banner is not
-- evidence, and a DDL statement that matched nothing still reports success.

-- 3a. authenticated must hold SELECT and UPDATE on listings, and NOT INSERT.
--     Expect no row with privilege_type = 'INSERT'.
--
-- select grantee, privilege_type
--   from information_schema.role_table_grants
--  where table_schema = 'public' and table_name = 'listings'
--    and grantee in ('anon', 'authenticated')
--  order by grantee, privilege_type;

-- 3b. The unique index must exist. Expect exactly one row.
--
-- select indexname, indexdef
--   from pg_indexes
--  where schemaname = 'public' and tablename = 'listings'
--    and indexname = 'listings_tracking_id_key';

-- 3c. Duplicates, if section 2 refused to build. Expect zero rows, and expect
--     them trivially: listings_tracking_id_key has been enforcing this all
--     along, so this query cannot return a row unless that index was dropped.
--     Run this BEFORE re-attempting section 2, and resolve by hand: a
--     tracking ID is printed on dispatch messages, so which row keeps it is a
--     judgement call and not something a migration should make.
--
-- select tracking_id, count(*), array_agg(id order by created_at)
--   from public.listings
--  group by tracking_id
-- having count(*) > 1;

-- 3d. service_role must STILL hold INSERT, or the route cannot write either.
--     Expect a row with privilege_type = 'INSERT'. Check this in the same
--     sitting as 3a: 3a alone proves creation is closed, not that it works.
--
-- select privilege_type
--   from information_schema.role_table_grants
--  where table_schema = 'public' and table_name = 'listings'
--    and grantee = 'service_role';

-- 3e. The INSERT policy listings_insert_own is left in place on purpose. It
--     governs a grant nobody holds any more, so it does nothing today, and it
--     is the thing that would still pin posted_by_id if the grant were ever
--     restored by a future migration that was not thinking about this one.
--     Expect it to still be there.
--
-- select polname, pg_get_expr(polwithcheck, polrelid) as with_check
--   from pg_policy
--  where polrelid = 'public.listings'::regclass and polcmd = 'a';

-- 3f. Cross rail collisions. Expect zero rows. Nothing in the database can
--     enforce this, which is why the route checks both tables when it mints.
--
-- select l.tracking_id
--   from public.listings l
--   join public.guest_jobs g on g.tracking_id = l.tracking_id;

-- ---------------------------------------------------------------------------
-- Noted for later, NOT done here: S-24, a redundant index
-- ---------------------------------------------------------------------------
--
-- public.listings also carries listings_tracking_idx, a plain btree on
-- tracking_id. listings_tracking_id_key is a UNIQUE index on the same column,
-- and a unique index serves every lookup a plain one would, so the plain one
-- earns nothing and costs a write on every insert and update.
--
-- DELIBERATELY NOT DROPPED IN THIS FILE. Dropping an index is a performance
-- change on a live table and it has nothing to do with closing S-15. Mixing
-- them would mean a rollback of this migration either leaves the index gone or
-- restores a hole to put it back, and neither is a choice anybody should be
-- making under pressure. It is also the kind of thing that wants its own
-- before-and-after on query plans rather than a line buried in a security fix.
--
-- When it is done, it is one statement and it belongs on its own:
--
--   drop index if exists public.listings_tracking_idx;
--
-- Confirm first that nothing depends on it by name, and that it is not backing
-- a constraint:
--
--   select indexname, indexdef from pg_indexes
--    where schemaname = 'public' and tablename = 'listings';
--   select conname, conindid::regclass from pg_constraint
--    where conrelid = 'public.listings'::regclass;

-- ---------------------------------------------------------------------------
-- The deploy sequence, per network
-- ---------------------------------------------------------------------------
--
-- Testnet first and in full, then Mainnet on an explicit go ahead. The two
-- steps are not interchangeable and step 1 is not optional.
--
--   1. CODE. Merge fix/listings-server-side-create and wait for a new
--      Production deployment. The merge gate is both facts: main fast forwards
--      on git pull AND a Production deployment appears. A green branch build is
--      not a merge.
--
--      The code is safe with the grant still in place. The route uses
--      service_role, and nothing else changed about how a listing is read.
--
--   2. PI BROWSER. Post a trip and post a package, fully closing and reopening
--      the browser first because it caches the bundle hard. Both must succeed
--      and both must come back with a GYM- tracking ID. This proves the route
--      works BEFORE the grant is taken away, which is the point of doing it
--      between the two steps rather than after them.
--
--   3. MIGRATION. Apply this file, by hand, breadcrumb confirmed. Section 1 is
--      two statements; section 2 does nothing.
--
--   4. CATALOG. Run 3a and 3b above and READ THEM. 3a is the one that matters:
--      no INSERT row for anon or authenticated.
--
--   5. PI BROWSER AGAIN. Post one more trip. It must still succeed, which is
--      what proves the route rather than the grant was carrying creation. If
--      it fails here and passed at step 2, the revoke caught something that
--      still inserts from the client and the rollback at the end of this file
--      puts it back while that is worked out.
--
-- Only after all five pass on Testnet is Mainnet asked for, and it runs the
-- same five in the same order against its own project.

-- ---------------------------------------------------------------------------
-- Rollback
-- ---------------------------------------------------------------------------
--
-- Restores a hole rather than a feature, so treat it as incident response.
-- Only needed if app/api/listings/create is rolled back with it.
--
-- grant insert on public.listings to authenticated;
-- drop index if exists public.listings_tracking_id_key;
