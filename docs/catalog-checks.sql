-- ===========================================================================
-- Gyema catalog checks: what is actually true in each database
-- ===========================================================================
--
-- READ ONLY. Every statement here is a SELECT against catalog views. Nothing
-- in this file creates, alters, drops, grants or revokes anything, and nothing
-- reads a row of user data: no listing, no guest job, no phone number, no
-- delivery code. If a statement below appears to do anything else, do not run
-- it and say so.
--
-- WHY THIS FILE EXISTS
--
-- docs/security-inventory.md could not answer the database half of Phase 0.
-- The migrations in db/migrations describe what was intended; only the catalog
-- says what is deployed, and the two projects are known to disagree already
-- (the 2026-08-18 dispatch reader migration is on Testnet and not on Mainnet).
-- CLAUDE.md invariant 8 is the same point: verify DDL from catalog state, never
-- from a Success banner.
--
-- Three findings in the inventory have a severity that cannot be settled
-- without these answers:
--
--   S-1  anon reads of public.listings return whatsapp and
--        matched_with_whatsapp. Check 3 and check 4 settle it.
--   S-15 the client supplies posted_by_id on listing creation. Check 5
--        settles whether an INSERT policy pins it to the session.
--   S-2  the last-4 guard has no attempt ceiling. Check 8 shows whether
--        anything at the database layer bounds it. Expectation: nothing does.
--
-- HOW TO RUN IT
--
-- Per project, in the Supabase SQL editor, one statement at a time. Confirm the
-- project breadcrumb in the dashboard before pasting, per CLAUDE.md. The editor
-- does not preserve transaction state across executions, which does not matter
-- here because every statement stands alone.
--
-- HOW TO SEND RESULTS BACK
--
-- Label each block with the network it came from, TESTNET or MAINNET, and paste
-- the result grid under the check number. Where a result is long, the row count
-- plus the rows that differ from the stated expectation is enough.
--
-- Nothing here returns a secret, so the output is safe to paste in full. The
-- one thing to watch: check 2 prints policy bodies, and a policy body is code,
-- not data. It will not contain a key.
--
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- CHECK 1. Row level security, per table
--
-- EXPECTED: one row per table in public. rls_enabled = true on listings,
-- guest_jobs, pioneers and auth_events. A false anywhere is a finding on its
-- own, and on guest_jobs it would be a serious one: every guest route reaches
-- that table with the service_role key precisely because the anon key cannot.
--
-- Also watch rls_forced. It is expected to be false everywhere; true would mean
-- even the table owner is filtered, which nothing here relies on.
-- ---------------------------------------------------------------------------
select
  c.relname                as table_name,
  c.relrowsecurity         as rls_enabled,
  c.relforcerowsecurity    as rls_forced,
  (select count(*) from pg_policies p
    where p.schemaname = 'public' and p.tablename = c.relname) as policy_count
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind = 'r'
order by c.relname;


-- ---------------------------------------------------------------------------
-- CHECK 2. Every policy body, with listings SELECT and DELETE first
--
-- EXPECTED, and this is the one I most want to see:
--
--   listings SELECT   qual is expected to be literally `true`. The
--                     2026-08-14 migration says at its section notes that the
--                     SELECT policy was left untouched, so anyone holding the
--                     anon key can read every column of every row, including
--                     whatsapp and matched_with_whatsapp. If qual is true,
--                     S-1 is confirmed as written.
--
--   listings DELETE   unknown to me. The same note mentions a DELETE policy
--                     without giving its body. A permissive DELETE would be
--                     worse than the SELECT: a delete cannot be undone from
--                     the app. Read this row carefully.
--
--   listings UPDATE   expected to admit the poster and the matched party
--                     (posted_by_id or matched_with_user_id against the
--                     session), which is row level and deliberately cannot
--                     tell which column a request writes. That is why
--                     completion moved into an RPC.
--
--   guest_jobs        expected: NO policy at all, or none that admits anon or
--                     authenticated. The guest rail is served entirely by
--                     service_role, which bypasses RLS.
--
--   gyema_reader_select   expected: ABSENT on both tables once
--                     2026-09-07_dispatch_reader_masked_view.sql is applied,
--                     since it drops them. Present on Testnet before that.
-- ---------------------------------------------------------------------------
select
  tablename,
  policyname,
  cmd,
  permissive,
  roles,
  qual        as using_expression,
  with_check  as with_check_expression
from pg_policies
where schemaname = 'public'
order by
  case when tablename = 'listings' and cmd = 'SELECT' then 0
       when tablename = 'listings' and cmd = 'DELETE' then 1
       when tablename = 'listings' then 2
       else 3 end,
  tablename, cmd, policyname;


-- ---------------------------------------------------------------------------
-- CHECK 3. Table wide grants to anon and authenticated
--
-- EXPECTED: rows for listings to anon (SELECT at least) and to authenticated.
-- The 2026-08-14 migration section 5 dropped the table wide UPDATE from
-- authenticated and re-granted it column by column, so authenticated should
-- show SELECT, INSERT and DELETE here but NOT UPDATE. An UPDATE row for
-- authenticated means that section did not take.
--
-- guest_jobs is expected to show NOTHING for anon or authenticated. Any row is
-- a finding: the guest rail's entire safety story is that only service_role
-- reaches that table.
--
-- gyema_reader is expected to appear for guest_jobs_dispatch and
-- listings_dispatch only, and for neither base table, once the 2026-09-07
-- migration is applied.
-- ---------------------------------------------------------------------------
select
  grantee,
  table_name,
  privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and grantee in ('anon', 'authenticated', 'service_role', 'gyema_reader', 'PUBLIC')
order by grantee, table_name, privilege_type;


-- ---------------------------------------------------------------------------
-- CHECK 4. Column level grants, which is where S-1 lives
--
-- EXPECTED: the column privileges granted separately from the table wide ones.
-- Two things to read out of it.
--
--   (a) authenticated should hold UPDATE on a named list of listings columns
--       and nothing beyond it. Look for status, sender_confirmed,
--       traveller_confirmed and completed_at being ABSENT from that list: those
--       are attestation columns and belong to the RPC.
--
--   (b) whatsapp and matched_with_whatsapp. If anon holds SELECT on them here,
--       or holds it table wide from check 3 with no column restriction, then
--       every open listing's phone number is readable by anyone with the
--       public anon key. That is S-1, and the fix is a column level revoke and
--       re-grant (a column revoke cannot subtract from a table wide grant, so
--       the table grant has to be dropped and rebuilt).
--
-- gyema_reader should return ZERO rows for sender_phone and recipient_phone
-- after the 2026-09-07 migration.
-- ---------------------------------------------------------------------------
select
  grantee,
  table_name,
  column_name,
  privilege_type
from information_schema.column_privileges
where table_schema = 'public'
  and grantee in ('anon', 'authenticated', 'gyema_reader')
order by grantee, table_name, privilege_type, column_name;


-- ---------------------------------------------------------------------------
-- CHECK 5. Does anything pin posted_by_id to the session on insert
--
-- This is S-15. lib/listings-async.ts sends posted_by_id, posted_by_username,
-- id, tracking_id, created_at and status from the client, so the only thing
-- that can stop a Pioneer posting as another Pioneer is an INSERT policy whose
-- WITH CHECK ties posted_by_id to the session.
--
-- EXPECTED: one INSERT policy on listings. Read its with_check_expression. If
-- it does not reference posted_by_id against auth.uid() or a jwt claim, then
-- the identity on a listing is whatever the client typed, and S-15 is
-- confirmed rather than theoretical.
-- ---------------------------------------------------------------------------
select
  policyname,
  roles,
  with_check as with_check_expression
from pg_policies
where schemaname = 'public'
  and tablename = 'listings'
  and cmd = 'INSERT';


-- ---------------------------------------------------------------------------
-- CHECK 6. Every security definer function, with search_path and volatility
--
-- EXPECTED: exactly four, all security definer, all with
-- search_path pinned in proconfig:
--
--   guest_bump_delivery_code_attempts(text)      2026-08-13
--   guest_stamp_delivery(text, text)             2026-08-13
--   listing_confirm_completion(text, text)       2026-08-14
--   (plus any Supabase-managed function, which will not be in public)
--
-- mask_phone_head_only(text) from 2026-09-07 should appear in the wider list
-- as NOT security definer, immutable, with search_path pinned. It needs no
-- privileges of its own.
--
-- A security definer function in public with proconfig null is a finding: it
-- runs as its owner with whatever search_path the caller sets.
-- ---------------------------------------------------------------------------
select
  p.proname                                   as function_name,
  pg_get_function_identity_arguments(p.oid)   as arguments,
  p.prosecdef                                 as security_definer,
  case p.provolatile when 'i' then 'immutable'
                     when 's' then 'stable'
                     else 'volatile' end      as volatility,
  p.proconfig                                 as settings,
  pg_get_userbyid(p.proowner)                 as owner
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
order by p.prosecdef desc, p.proname;


-- ---------------------------------------------------------------------------
-- CHECK 7. EXECUTE grants on those functions
--
-- EXPECTED: for the three security definer functions, service_role and nothing
-- else. The 2026-08-14 migration revokes from public, anon and authenticated
-- explicitly, on the stated grounds that otherwise anyone holding the anon key
-- could POST to /rest/v1/rpc/listing_confirm_completion directly.
--
-- An anon or authenticated row against any of the three is the most serious
-- single result this file can produce: it means a stamp can be written from
-- the public key without going through a route at all.
--
-- proacl null means default privileges, which for a function is EXECUTE to
-- PUBLIC. On a security definer function that is the same finding.
-- ---------------------------------------------------------------------------
select
  p.proname                                 as function_name,
  pg_get_function_identity_arguments(p.oid) as arguments,
  p.prosecdef                               as security_definer,
  coalesce(array_to_string(p.proacl, E'\n'), '(null: EXECUTE to PUBLIC)') as acl
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'guest_bump_delivery_code_attempts',
    'guest_stamp_delivery',
    'listing_confirm_completion',
    'mask_phone_head_only'
  )
order by p.proname;


-- ---------------------------------------------------------------------------
-- CHECK 8. Is anything at the database layer bounding the last-4 guard
--
-- EXPECTED: delivery_code_attempts exists on guest_jobs with a default of 0,
-- and there is NO equivalent counter for the sender side guard. That is S-2:
-- the courier code path has a five attempt ceiling and the three routes guarded
-- by the last four digits of sender_phone have nothing.
--
-- This check is here so the absence is recorded from the catalog rather than
-- inferred from reading routes.
-- ---------------------------------------------------------------------------
select
  column_name,
  data_type,
  column_default,
  is_nullable
from information_schema.columns
where table_schema = 'public'
  and table_name = 'guest_jobs'
  and (column_name like '%attempt%'
    or column_name like '%lock%'
    or column_name like '%guard%'
    or column_name in ('phone_verified', 'verified_at', 'delivery_code_hash'))
order by column_name;


-- ---------------------------------------------------------------------------
-- CHECK 9. Did each migration file's objects actually land
--
-- One row per object the four migration files create, with a present flag.
-- Read it as a checklist, per network.
--
-- EXPECTED on TESTNET, before 2026-09-07 is applied: everything present except
-- the four objects from 2026-09-07.
--
-- EXPECTED on MAINNET, today: the 2026-08-13 and 2026-08-14 objects present,
-- and the 2026-08-18 dispatch reader objects ABSENT, which is the drift.
--
-- EXPECTED on BOTH, after 2026-09-07 is applied: every 2026-09-07 row present,
-- and gyema_reader_select policies absent (that file drops them).
-- ---------------------------------------------------------------------------
select '2026-08-13' as migration, 'column guest_jobs.delivery_code_hash' as object,
  exists (select 1 from information_schema.columns
           where table_schema='public' and table_name='guest_jobs'
             and column_name='delivery_code_hash') as present
union all
select '2026-08-13', 'column guest_jobs.delivery_code_attempts',
  exists (select 1 from information_schema.columns
           where table_schema='public' and table_name='guest_jobs'
             and column_name='delivery_code_attempts')
union all
select '2026-08-13', 'function guest_bump_delivery_code_attempts',
  exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
           where n.nspname='public' and p.proname='guest_bump_delivery_code_attempts')
union all
select '2026-08-13', 'function guest_stamp_delivery',
  exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
           where n.nspname='public' and p.proname='guest_stamp_delivery')
union all
select '2026-08-14', 'function listing_confirm_completion',
  exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
           where n.nspname='public' and p.proname='listing_confirm_completion')
union all
select '2026-08-14', 'policy: posters and matched parties can update',
  exists (select 1 from pg_policies
           where schemaname='public' and tablename='listings'
             and policyname ilike '%matched parties%')
union all
select '2026-08-18', 'role gyema_reader',
  exists (select 1 from pg_roles where rolname='gyema_reader')
union all
select '2026-08-18', 'policy gyema_reader_select on guest_jobs (superseded, expect false after 2026-09-07)',
  exists (select 1 from pg_policies
           where schemaname='public' and tablename='guest_jobs'
             and policyname='gyema_reader_select')
union all
select '2026-09-07', 'function mask_phone_head_only',
  exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
           where n.nspname='public' and p.proname='mask_phone_head_only')
union all
select '2026-09-07', 'view guest_jobs_dispatch',
  exists (select 1 from information_schema.views
           where table_schema='public' and table_name='guest_jobs_dispatch')
union all
select '2026-09-07', 'view listings_dispatch',
  exists (select 1 from information_schema.views
           where table_schema='public' and table_name='listings_dispatch')
union all
select '2026-09-07', 'gyema_reader has no grant on base table guest_jobs',
  not exists (select 1 from information_schema.role_table_grants
               where grantee='gyema_reader' and table_name='guest_jobs')
order by migration, object;


-- ---------------------------------------------------------------------------
-- CHECK 10. The reader role's session bounds
--
-- EXPECTED after 2026-09-07: rolconfig carries
-- default_transaction_read_only=on, statement_timeout=10s,
-- idle_in_transaction_session_timeout=30s, lock_timeout=5s. rolcanlogin true
-- on a project where the role is in use, false on one where the role was just
-- created and no password has been set.
--
-- rolsuper, rolcreatedb, rolcreaterole and rolinherit are all expected false.
-- ---------------------------------------------------------------------------
select
  rolname,
  rolcanlogin,
  rolsuper,
  rolcreatedb,
  rolcreaterole,
  rolinherit,
  rolconfig
from pg_roles
where rolname = 'gyema_reader';


-- ---------------------------------------------------------------------------
-- CHECK 11. Table inventory and row counts, for schema drift between networks
--
-- EXPECTED: the same table list on both networks. Counts will differ and that
-- is fine; the list should not. A table on one and not the other is drift that
-- nothing in db/migrations accounts for.
--
-- reltuples is the planner's estimate, not a count. It is used here on purpose:
-- an estimate needs no scan, and an exact count of a live table is not
-- something this file should ask for.
-- ---------------------------------------------------------------------------
select
  c.relname                       as table_name,
  c.relkind                       as kind,
  c.reltuples::bigint             as approx_rows,
  (select count(*) from information_schema.columns col
    where col.table_schema = 'public' and col.table_name = c.relname) as column_count
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind in ('r', 'v')
order by c.relkind, c.relname;


-- ---------------------------------------------------------------------------
-- CHECK 12. Extensions and anything else with EXECUTE to PUBLIC in public
--
-- EXPECTED: nothing surprising. This is a sweep rather than a targeted check:
-- any function in the public schema that is security definer and executable by
-- PUBLIC is reachable through PostgREST with the anon key, whoever wrote it and
-- whenever. Zero rows is the good answer.
-- ---------------------------------------------------------------------------
select
  p.proname                                 as function_name,
  pg_get_function_identity_arguments(p.oid) as arguments,
  pg_get_userbyid(p.proowner)               as owner
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.prosecdef
  and (p.proacl is null or array_to_string(p.proacl, ',') like '%=X/%')
  and array_to_string(coalesce(p.proacl, '{}'), ',') not like '%service_role=X%'
order by p.proname;


-- ===========================================================================
-- After running these
--
-- Paste results back per network. The four answers that change what happens
-- next, in order:
--
--   1. Check 2, listings SELECT qual and DELETE qual. Settles S-1 and tells me
--      whether there is a delete hole nobody has looked at.
--   2. Check 4, whether anon can read whatsapp and matched_with_whatsapp.
--   3. Check 7, whether anything other than service_role holds EXECUTE on the
--      three security definer functions.
--   4. Check 9, the per network checklist, which turns the drift from a guess
--      into a list.
--
-- None of the fixes those imply are written yet, and none should be applied
-- from this file. Migrations go in db/migrations, one concern each, Testnet
-- first.
-- ===========================================================================
