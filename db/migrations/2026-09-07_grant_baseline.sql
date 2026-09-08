-- ===========================================================================
-- 2026-09-07  Grant baseline: one privilege set, both networks
-- ===========================================================================
--
-- READ THIS BEFORE APPLYING. Section 3 removes UPDATE on listings.status from
-- authenticated, and three actions in the app still write that column through
-- the authed client:
--
--   cancelOpenListingAsync     lib/listings-async.ts, status = 'expired'
--   cancelMatchedListingAsync  lib/listings-async.ts, status = 'expired'
--   markInTransitAsync         lib/listings-async.ts, status = 'in_transit'
--
-- Applying this file before those three move to server routes breaks Cancel
-- and Mark as picked up, on whichever network it is applied to. They are the
-- only client side status writes left. Nothing else in this file depends on
-- that work, but section 3 does, so either those routes land first or section
-- 3 waits. See docs/deploy-order.md.
--
-- WHAT THIS FILE IS FOR
--
-- The two networks disagree about privileges. Mainnet was hand tightened:
-- anon holds only SELECT on listings, authenticated holds SELECT and INSERT
-- plus the column UPDATE list from 2026-08-14, and service_role was trimmed on
-- guest_jobs and couriers. Testnet still carries the Supabase defaults, which
-- are table wide grants to anon and authenticated on everything in public.
--
-- Hand tightening does not survive a new table. Both networks now carry tables
-- nothing in this repository references (couriers on both, a2u_payments and
-- legacy_couriers on Testnet), and on Testnet the defaults mean anon can read
-- them. This file replaces "whatever each project accumulated" with one
-- computed baseline that is identical on both, and that a new table joins on
-- the deny side rather than the allow side.
--
-- It also closes S-1. anon and authenticated get column level SELECT on
-- listings with whatsapp and matched_with_whatsapp excluded, so a phone number
-- is no longer readable with the public anon key. The two matched parties get
-- each other's number through a security definer RPC that checks who is
-- asking, which is section 4.
--
-- THE ORDER OF OPERATIONS THAT ACTUALLY WORKS
--
-- Privileges are additive and a column level revoke cannot subtract from a
-- table wide grant: with SELECT held on the whole table, Postgres answers a
-- column level revoke with a WARNING and leaves the column readable. The only
-- mechanism that works is to drop the table wide grant and re-grant per
-- column, which is why section 1 revokes everything before anything is given
-- back. The 2026-08-14 migration learned this the same way and says so.
--
-- HOW THIS FILE IS USED
--
-- Applied MANUALLY, per project, through the Supabase SQL editor. Agents never
-- mutate a database. Testnet first, verified with section 7, Mainnet only on
-- an explicit go ahead. Confirm the project breadcrumb before pasting.
--
-- IDEMPOTENT top to bottom. Every section is a revoke (which does not error
-- when the privilege was never held), a create or replace, or a grant
-- recomputed from the catalog at run time. Re-running it after a column is
-- added does the right thing without an edit.
--
-- WHAT IT DELIBERATELY DOES NOT DO
--
--   It does not touch RLS or any policy. The policies are the other half of
--   the story and they change what the app can do; this file changes only who
--   holds which privilege. One concern per migration.
--
--   It does not touch schema usage, sequences, or the storage schema. anon and
--   authenticated keep USAGE on schema public, which they need to reach
--   anything at all.
--
--   It does not grant DELETE to authenticated. See section 3 for the check.
--
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. Revoke everything from anon and authenticated, on every table and view
--    in public
--
-- Including TRUNCATE, REFERENCES and TRIGGER, which the ALL form covers and
-- which nobody thinks about: TRUNCATE on a table is a delete of every row that
-- leaves no trace in a WHERE clause anyone reviewed, REFERENCES lets a foreign
-- key be pointed at a table and can be used to probe values, and TRIGGER lets
-- a trigger function be attached to somebody else's table.
--
-- This is the line that makes the baseline hold for tables nobody has looked
-- at. couriers, a2u_payments and legacy_couriers are covered here without
-- being named, and so is the next table someone creates in the dashboard.
--
-- The loop is per relation rather than a single ALL TABLES IN SCHEMA statement
-- so the notice tells you exactly what was touched, and so a relation that
-- cannot be revoked from stops the section instead of being skipped quietly.
-- ---------------------------------------------------------------------------
do $$
declare
  r record;
  v_count int := 0;
begin
  for r in
    select c.relname, c.relkind
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relkind in ('r', 'v', 'm', 'p')
     order by c.relname
  loop
    execute format('revoke all privileges on public.%I from anon', r.relname);
    execute format('revoke all privileges on public.%I from authenticated', r.relname);
    v_count := v_count + 1;
  end loop;
  raise notice 'revoked all privileges from anon and authenticated on % relations', v_count;
end
$$;


-- ---------------------------------------------------------------------------
-- 1a. Make the NEXT object start denied too
--
-- FOUND LIVE ON TESTNET, 7 September. Section 1 revokes the Supabase defaults
-- from every relation that exists when it runs. It says nothing about the next
-- one. The two dispatch views in
-- db/migrations/2026-09-07_dispatch_reader_masked_view.sql are created after
-- this file, so they were born with anon and authenticated holding everything
-- on them, and the catalog check caught it after the fact.
--
-- A Supabase project ships with default privileges that grant anon and
-- authenticated on tables created in schema public. ALTER DEFAULT PRIVILEGES
-- rewrites that rule, so an object created later starts with nobody on it and
-- has to be granted deliberately. That is the posture this whole file is
-- arguing for, applied to the future rather than only the present.
--
-- FOR ROLE postgres: default privileges are per creating role, not global.
-- postgres is what the SQL editor and the dashboard create objects as, which
-- covers every object either of us will make. If something is created by
-- another role its own defaults apply, which is why verification (i) below
-- lists every role that has defaults rather than checking only this one.
--
-- FUNCTIONS ARE NOT COVERED HERE, AND THAT IS A MEASUREMENT, NOT AN OVERSIGHT.
--
-- EXECUTE on a new function defaults to PUBLIC rather than to anon, so the
-- obvious statement to write is:
--
--   alter default privileges for role postgres in schema public
--     revoke all on functions from public;
--
-- On PostgreSQL 17 that statement succeeds, records nothing in pg_default_acl,
-- and changes nothing: a function created afterwards still has a null proacl,
-- which means EXECUTE to PUBLIC, and has_function_privilege('anon', fn,
-- 'execute') still returns true. Measured on 7 September against postgres
-- 17-alpine, three ways (revoke all on functions, revoke execute on functions,
-- revoke execute on routines), before writing this paragraph. The tables and
-- sequences statements above were measured the same way and DO work.
--
-- So a new function is still callable through PostgREST with the public key
-- the moment it is created. That is the shape of the rls_auto_enable finding
-- on Mainnet, and the control for it is not a default: it is the explicit
-- revoke and grant that every function in db/migrations already carries, per
-- CLAUDE.md invariant 2. Write them on the same day you write the function:
--
--   revoke all on function public.your_function(args) from public, anon, authenticated;
--   grant execute on function public.your_function(args) to service_role;
--
-- docs/catalog-checks.sql check 12 is the net that catches a miss: it lists
-- every security definer function in public that PUBLIC can execute, and the
-- expected answer is zero rows.
--
-- WHAT THIS WILL DO TO YOU LATER, so it is not a surprise: create a table in
-- the dashboard and the app cannot read it until you grant it. That is the
-- intended outcome, and it is the difference between a new object being
-- exposed by default and being deliberately opened.
--
-- Safe to re-run: ALTER DEFAULT PRIVILEGES is declarative, not incremental.
-- ---------------------------------------------------------------------------
alter default privileges for role postgres in schema public
  revoke all on tables from anon, authenticated;

alter default privileges for role postgres in schema public
  revoke all on sequences from anon, authenticated;


-- ---------------------------------------------------------------------------
-- 2. anon: column level SELECT on listings, phones excluded
--
-- This is the S-1 fix. The open listings feed and the public track lookup both
-- read listings with the anon key, and both used select("*"), which returned
-- whatsapp and matched_with_whatsapp to anyone who asked. The matching code
-- change replaces those with explicit column lists; this makes the database
-- refuse the old query rather than trusting the client to have been updated.
--
-- Computed from information_schema rather than hard coded, so a column added
-- later is included automatically and a column that exists on one project and
-- not the other does not break the file. The two exclusions are named, and the
-- block refuses to run if it cannot resolve a list, because a null v_cols
-- would otherwise produce a grant of nothing and a silently broken feed.
--
-- NOTE for whoever adds a column later: a new column becomes anon readable the
-- next time this file runs. If it holds anything private, add it to the
-- exclusion list in the same commit that adds the column.
-- ---------------------------------------------------------------------------
do $$
declare
  v_cols text;
begin
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position)
    into v_cols
    from information_schema.columns
   where table_schema = 'public'
     and table_name = 'listings'
     and column_name not in ('whatsapp', 'matched_with_whatsapp');

  if v_cols is null then
    raise exception 'listings: no columns resolved, refusing to grant';
  end if;

  execute format('grant select (%s) on public.listings to anon', v_cols);
  raise notice 'anon: column level SELECT granted on listings, phones excluded';
end
$$;


-- ---------------------------------------------------------------------------
-- 3. authenticated: SELECT the same way, INSERT, and a two column UPDATE
--
-- SELECT excludes the same two columns. A signed in Pioneer reads their own
-- listings through this grant (getListingsByUserAsync), and their own listing
-- carries their own phone number, so this does take something away from them:
-- they can no longer read it back from the row. Neither the app nor the UI
-- needs it, and the counterparty number they DO need arrives through section
-- 4's RPC, which checks that they are a party to the listing first. The
-- alternative is a per row column privilege, which Postgres does not have.
--
-- INSERT is table wide. It has to be: the client writes most columns on
-- create, and what stops a Pioneer inserting a row as somebody else is the
-- INSERT policy's WITH CHECK, not the grant. That policy is out of scope here
-- and is finding S-15, still open.
--
-- A table wide INSERT implies insert on whatsapp and matched_with_whatsapp
-- too, which is why section 7 check (b) expects two INSERT rows rather than
-- none. Insert is the right shape for whatsapp (a poster writes their own
-- number when they create the listing) and harmless for
-- matched_with_whatsapp: a poster can pre-set a value on their own unmatched
-- row, and the accept route overwrites it with service_role when someone
-- actually claims it. Neither column is readable or updatable afterwards.
--
-- DELETE is NOT granted. Checked before writing this: there is no delete of a
-- listing anywhere in the app. lib/listings-async.ts has no .delete() call,
-- and a repository wide grep for .delete( finds only the toast timeout map in
-- hooks/use-toast.ts and its shadcn copy. Cancel is an UPDATE to status,
-- Remove is an UPDATE to archived_at, and neither removes a row. On Mainnet
-- authenticated already had no DELETE grant, which is why the delete policy
-- there is dead: the policy admits the poster and the grant admits nobody.
-- This file makes both networks match Mainnet's behaviour, deliberately. If a
-- delete action is ever added, it needs its own migration and its own thought
-- about whether a hard delete is right on a table with a counterparty.
--
-- UPDATE is exactly two columns: archived_at and archived_by_matched_at, the
-- per user archive written by archiveListingAsync.
--
-- WHAT IS NOT IN THAT LIST, AND WHAT IT COSTS:
--
--   status                     Three actions still write it from the client:
--                              cancelOpenListingAsync, cancelMatchedListingAsync
--                              and markInTransitAsync. They will fail with
--                              42501 until they move to server routes. This is
--                              the tradeoff named at the top of the file. Until
--                              then, any signed in Pioneer with a REST client
--                              can move any row they can update to any status,
--                              including expiring somebody else's open listing
--                              if the UPDATE policy admits them to the row.
--   posted_by_id               Identity. Never writable by a client.
--   matched_with_user_id       Who claimed it. Written by the accept route
--                              with service_role, never by the claimer.
--   whatsapp                   A phone number, and on a matched row it is the
--   matched_with_whatsapp      counterparty's. Not a field either party edits.
--   sender_confirmed           Attestations. Already denied by 2026-08-14 and
--   traveller_confirmed        written only inside listing_confirm_completion.
--   completed_at
--
-- Everything else on the table is now denied too, which is a change from
-- 2026-08-14: that migration denied three columns and left the rest open,
-- including status and posted_by_id, and said so honestly in its header. This
-- inverts it to an allow list.
-- ---------------------------------------------------------------------------
do $$
declare
  v_cols text;
  v_missing text;
begin
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position)
    into v_cols
    from information_schema.columns
   where table_schema = 'public'
     and table_name = 'listings'
     and column_name not in ('whatsapp', 'matched_with_whatsapp');

  if v_cols is null then
    raise exception 'listings: no columns resolved, refusing to grant';
  end if;

  execute format('grant select (%s) on public.listings to authenticated', v_cols);
  execute 'grant insert on public.listings to authenticated';

  -- The two archive columns, named and checked. A missing column here means
  -- the schema moved and the grant would silently give less than intended.
  select string_agg(c, ', ')
    into v_missing
    from unnest(array['archived_at', 'archived_by_matched_at']) c
   where not exists (
     select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'listings'
        and column_name = c
   );

  if v_missing is not null then
    raise exception 'listings: expected column(s) % not found, refusing to grant UPDATE', v_missing;
  end if;

  execute 'grant update (archived_at, archived_by_matched_at) on public.listings to authenticated';
  raise notice 'authenticated: SELECT (phones excluded), INSERT, UPDATE on the two archive columns. No DELETE.';
end
$$;


-- ---------------------------------------------------------------------------
-- 4. listing_counterpart_contact: the only way a phone number reaches a client
--
-- Returns the OTHER party's whatsapp on one listing, and only to a caller who
-- is one of the two parties on that listing. Nothing else: not the number of a
-- listing you are not on, not your own number back, and not anything on an
-- unmatched row, where there is no counterparty to name.
--
-- IDENTITY COMES FROM THE pioneers TABLE, NOT FROM THE JWT.
--
-- This is the load bearing decision in the whole file and it is worth being
-- explicit about. The obvious implementation reads
-- ((auth.jwt() -> 'user_metadata') ->> 'pi_uid'), which is what the existing
-- listings UPDATE policy does. user_metadata is the user's own metadata: a
-- signed in client can write it with supabase.auth.updateUser({ data: ... })
-- using nothing but the anon key and their own session. A pi_uid read from
-- there is therefore a value the caller chose, and a function that trusted it
-- would hand any Pioneer any other Pioneer's phone number for the cost of one
-- updateUser call.
--
-- So this function maps auth.uid(), which is the Supabase user id inside a
-- signed token and cannot be forged by the holder, to a pi_uid through
-- public.pioneers, which only service_role writes (lib/supabase-admin.ts).
--
-- That the existing UPDATE policy has the weakness this function avoids is a
-- separate finding and a separate migration. It is recorded here rather than
-- fixed here because changing a policy changes what the app can do, and this
-- file changes only privileges.
--
-- security definer because the caller has no SELECT privilege on the whatsapp
-- columns at all after sections 2 and 3, which is the point: the function is
-- the only path, and it decides.
--
-- search_path pinned per CLAUDE.md invariant 2. EXECUTE revoked from public
-- and anon, granted to authenticated and service_role only. anon must not hold
-- it: an anonymous caller has no pioneer row, so the function would return
-- nothing, but a function that returns phone numbers should not be reachable
-- from the public key at all.
--
-- Returns zero rows rather than raising on every refusal, so a caller learns
-- nothing from the difference between "not your listing", "no such listing"
-- and "not matched yet".
-- ---------------------------------------------------------------------------
create or replace function public.listing_counterpart_contact(p_listing_id text)
returns table (counterparty_role text, counterparty_username text, whatsapp text)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_pi_uid text;
  v_listing public.listings%rowtype;
begin
  if p_listing_id is null then
    return;
  end if;

  -- Who is asking, resolved server side.
  select p.pi_uid
    into v_pi_uid
    from public.pioneers p
   where p.supabase_user_id::text = auth.uid()::text
   order by p.created_at asc
   limit 1;

  if v_pi_uid is null then
    return;
  end if;

  select * into v_listing
    from public.listings l
   where l.id = p_listing_id;

  if not found then
    return;
  end if;

  -- No counterparty exists until someone has claimed the listing.
  if v_listing.matched_with_user_id is null then
    return;
  end if;

  if v_listing.posted_by_id = v_pi_uid then
    return query
      select 'matched'::text,
             v_listing.matched_with_username,
             v_listing.matched_with_whatsapp;
  elsif v_listing.matched_with_user_id = v_pi_uid then
    return query
      select 'poster'::text,
             v_listing.posted_by_username,
             v_listing.whatsapp;
  end if;

  -- Caller is neither party. Zero rows, no error, nothing learned.
  return;
end
$$;

comment on function public.listing_counterpart_contact(text) is
  'Returns the other party whatsapp on one matched listing, to that listing''s poster or matched party only. Identity resolved from public.pioneers via auth.uid(), never from user_metadata, which the user can write.';

revoke all on function public.listing_counterpart_contact(text) from public, anon;
grant execute on function public.listing_counterpart_contact(text) to authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 5. service_role: full privileges on every table and view in public
--
-- Every API route in this repository reaches the database as service_role, and
-- the guest rail exists only because that role can read a table the anon key
-- cannot touch at all. Mainnet was hand trimmed on guest_jobs and couriers,
-- which is the kind of tightening that reads as safe and is not: the routes
-- are the only caller, they are already gated by their own auth checks, and a
-- missing grant surfaces as Postgres 42501 and a silent failure in a guest
-- flow, which is exactly the failure mode /api/listings/accept and
-- /api/guest/create both carry warnings about in their headers.
--
-- So service_role is restored to full on both networks and the two projects
-- stop disagreeing. If a specific route should not reach a specific table, the
-- place to say so is the route, in code that can be read and tested, not a
-- grant nobody can see from the repository.
-- ---------------------------------------------------------------------------
do $$
declare
  r record;
  v_count int := 0;
begin
  for r in
    select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relkind in ('r', 'v', 'm', 'p')
     order by c.relname
  loop
    execute format('grant all privileges on public.%I to service_role', r.relname);
    v_count := v_count + 1;
  end loop;
  raise notice 'service_role: all privileges granted on % relations', v_count;
end
$$;


-- ---------------------------------------------------------------------------
-- 6. rls_auto_enable: take EXECUTE away from PUBLIC
--
-- Found on Mainnet, absent from Testnet, referenced nowhere in this
-- repository. Whatever it does, a function called rls_auto_enable that any
-- role can execute is reachable through PostgREST with the anon key, and its
-- name says it changes row level security.
--
-- The loop handles every overload and does nothing on a project where the
-- function does not exist, so this file stays safe on Testnet.
--
-- This revokes from PUBLIC only. If the function turns out to be Supabase
-- platform tooling with a legitimate caller, that caller holds its own grant
-- and is unaffected; if nothing can execute it afterwards, nothing was calling
-- it. Section 7 check (f) reports what is left.
-- ---------------------------------------------------------------------------
do $$
declare
  r record;
  v_count int := 0;
begin
  for r in
    select p.oid::regprocedure as sig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = 'rls_auto_enable'
  loop
    execute format('revoke all on function %s from public', r.sig);
    v_count := v_count + 1;
    raise notice 'revoked EXECUTE from PUBLIC on %', r.sig;
  end loop;
  if v_count = 0 then
    raise notice 'rls_auto_enable not present on this project, nothing to revoke';
  end if;
end
$$;


-- ---------------------------------------------------------------------------
-- 7. Verification, per CLAUDE.md invariant 8
--
-- DDL reports Success whether or not it did what was intended. Run each of
-- these after applying, on each network, and read the result. Or run
-- docs/catalog-checks.sql, which covers all of it in one document.
--
-- (a) Table wide privileges left to anon and authenticated. Expect EXACTLY
--     ONE row: authenticated, listings, INSERT, which section 3 grants on
--     purpose. Anything else, and in particular any SELECT or UPDATE row,
--     means section 1 did not take, and a table wide grant makes every column
--     grant below it irrelevant.
--
--     select grantee, table_name, privilege_type
--       from information_schema.role_table_grants
--      where table_schema = 'public'
--        and grantee in ('anon', 'authenticated');
--
-- (b) The phone columns are unreadable. Expect exactly TWO rows, both
--     privilege_type INSERT, both for authenticated: whatsapp and
--     matched_with_whatsapp. Those are implied by the table wide INSERT in
--     (a), not granted separately, and they are what lets a poster write
--     their own number when they create a listing.
--
--     A row with privilege_type SELECT or UPDATE is the failure this file
--     exists to prevent. Zero rows would also be wrong: it would mean
--     authenticated cannot insert a listing with a phone number at all.
--
--     select grantee, table_name, column_name, privilege_type
--       from information_schema.column_privileges
--      where table_schema = 'public'
--        and grantee in ('anon', 'authenticated')
--        and column_name in ('whatsapp', 'matched_with_whatsapp')
--      order by column_name;
--
-- (c) What authenticated may write on listings. Expect exactly two rows,
--     archived_at and archived_by_matched_at, both UPDATE. A status row means
--     section 3 did not take.
--
--     select column_name, privilege_type
--       from information_schema.column_privileges
--      where table_schema = 'public' and table_name = 'listings'
--        and grantee = 'authenticated' and privilege_type = 'UPDATE'
--      order by column_name;
--
-- (d) The RPC exists, is security definer, has search_path pinned, and is
--     executable by authenticated and service_role and nobody else.
--
--     select p.proname, p.prosecdef, p.proconfig, p.proacl
--       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--      where n.nspname = 'public' and p.proname = 'listing_counterpart_contact';
--
-- (e) service_role reaches every table. Expect one row per relation in public,
--     each with the full privilege set.
--
--     select table_name, count(*) as privilege_count
--       from information_schema.role_table_grants
--      where table_schema = 'public' and grantee = 'service_role'
--      group by table_name order by table_name;
--
-- (f) rls_auto_enable. On Mainnet expect proacl to no longer carry an entry
--     for PUBLIC (an "=X/" element with nothing before the equals sign). On
--     Testnet expect zero rows.
--
--     select p.oid::regprocedure as signature, p.proacl
--       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--      where n.nspname = 'public' and p.proname = 'rls_auto_enable';
--
--     Measured on the fixture: the ACL went from carrying a bare "=X/postgres"
--     element (that empty name before the equals sign is PUBLIC) to
--     {postgres=X/postgres} alone.
--
-- (g) The three unreferenced tables are now closed to the public key. Expect
--     ZERO rows for anon on any of them.
--
--     select grantee, table_name, privilege_type
--       from information_schema.role_table_grants
--      where table_schema = 'public'
--        and table_name in ('couriers', 'a2u_payments', 'legacy_couriers')
--        and grantee in ('anon', 'authenticated');
--
-- (i) DEFAULT PRIVILEGES. What a newly created object will start with.
--
--     select pg_get_userbyid(defaclrole) as creating_role,
--            n.nspname                   as schema,
--            case defaclobjtype when 'r' then 'tables'
--                               when 'S' then 'sequences'
--                               when 'f' then 'functions'
--                               when 'T' then 'types'
--                               else defaclobjtype::text end as object_type,
--            defaclacl                   as default_acl
--       from pg_default_acl d
--       join pg_namespace n on n.oid = d.defaclnamespace
--      order by creating_role, schema, object_type;
--
--     Read it for the postgres row in schema public: no anon and no
--     authenticated on tables or sequences. There will be no functions row,
--     for the reason given in section 1a.
--
--     Read it also for any OTHER creating role that appears. Defaults are per
--     role: a role not listed here still carries the built in defaults, which
--     for functions means EXECUTE to PUBLIC. If objects are ever created as
--     something other than postgres, that role needs the same three statements.
--
-- (j) The proof, which takes ten seconds and is worth more than reading an
--     ACL. In the SQL editor, on the network you just applied to:
--
--     create table public.zzz_default_privilege_probe (id int);
--     select grantee, privilege_type
--       from information_schema.role_table_grants
--      where table_schema = 'public'
--        and table_name = 'zzz_default_privilege_probe'
--        and grantee in ('anon', 'authenticated');
--     drop table public.zzz_default_privilege_probe;
--
--     Expect zero rows in the middle statement. Before section 1a, that same
--     probe returns anon and authenticated holding everything, which is how
--     the two dispatch views ended up readable with the public key.
--
--     The same probe for a function, which is expected to show the opposite
--     and is here so the gap is visible rather than assumed:
--
--     create function public.zzz_probe() returns int language sql as 'select 1';
--     select has_function_privilege('anon', 'public.zzz_probe()', 'execute');
--     drop function public.zzz_probe();
--
--     Expect TRUE. A new function is executable by the public key until it is
--     explicitly revoked. That is why every function in db/migrations carries
--     its own revoke and grant.
--
-- (h) The one behavioural check that needs the app, not the catalog: sign in
--     on the network you just applied to, inside Pi Browser, open a matched
--     listing, and confirm the counterparty's WhatsApp button still works.
--     That exercises section 4 end to end. If it shows nothing, the RPC
--     returned zero rows, and the first thing to check is whether the caller
--     has a row in public.pioneers.
--
-- ROLLBACK. There is no clean undo, because the state this replaces was two
-- different accumulations rather than a design. To restore the previous
-- Testnet behaviour specifically:
--
--   grant all on public.listings to anon, authenticated;   -- the default
--
-- and to restore Mainnet's:
--
--   grant select, insert on public.listings to authenticated;
--   grant select on public.listings to anon;
--   -- then re-run section 4 of db/migrations/2026-08-14_listing_completion_rls.sql
--
-- Both restore the phone number exposure this file exists to close, so treat a
-- rollback as an incident response step rather than a routine one.
--
-- ===========================================================================
