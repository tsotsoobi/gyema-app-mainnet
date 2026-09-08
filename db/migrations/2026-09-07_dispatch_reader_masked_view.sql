-- ===========================================================================
-- 2026-09-07  Dispatch Reader: masked phone views, and a bounded role
-- ===========================================================================
--
-- SUPERSEDES db/migrations/2026-08-18_dispatch_reader_role.sql sections 4, 5
-- and 6. That file created gyema_reader and granted it column level SELECT
-- directly on public.guest_jobs and public.listings, including sender_phone
-- and recipient_phone in full. This file takes those grants away and gives
-- the role two masked views instead. Sections 1, 2 and 3 of that file (the
-- role itself, default_transaction_read_only, connect and schema usage) stand
-- unchanged and are re-asserted here so this file is complete on its own.
--
-- WHY THIS EXISTS
--
-- Two reasons, and the second is the one that matters.
--
-- 1. Drift. The 2026-08-18 file was applied to Testnet and never mirrored to
--    Mainnet, so the two projects disagree about what roles and grants exist.
--    This file is written to be applied to BOTH, and to be safe on a project
--    where the 2026-08-18 file never ran.
--
-- 2. The last four digits of sender_phone are a credential on this rail, not
--    an identifier. They are the entire guard on three public routes:
--    app/api/guest/delivery-code (which returns the one time delivery code in
--    plaintext), app/api/guest/confirm-pickup, and app/api/guest/
--    confirm-delivery on its via = "sender" path. scripts/dispatch-reader.mjs
--    masked phones to their trailing four digits, which is the correct
--    instinct for a phone number and the wrong one for this column: it
--    printed the guard for every job in the report. Anywhere that report was
--    pasted, the guard travelled with it.
--
--    So the masking moves into the database, where the script cannot get it
--    wrong, and it masks the TAIL rather than the head. gyema_reader can no
--    longer read a phone number in any form that contains the last four
--    digits, because it can no longer read the phone columns at all.
--
-- HOW THIS FILE IS USED
--
-- Applied MANUALLY, per project, through the Supabase SQL editor, same as
-- every other file in this directory. There is no automated runner in this
-- repo and nothing reads this directory at build or deploy time.
--
-- Testnet first. Verify with section 7 there, then apply the identical file
-- to Mainnet on an explicit go ahead. Confirm the project breadcrumb in the
-- dashboard before pasting, per CLAUDE.md.
--
-- THIS FILE IS IDEMPOTENT TOP TO BOTTOM. Every statement is either a create
-- or replace, a drop if exists followed by a create, an ALTER ROLE ... SET
-- that overwrites, or a grant, which is a no-op when already held. Section 1
-- creates the role only if it is absent and never touches an existing
-- password. Run it top to bottom, one statement at a time, and read the
-- result of each before moving on: the Supabase SQL editor does not preserve
-- transaction state across executions.
--
-- WHAT DEPENDS ON IT
--
-- scripts/dispatch-reader.mjs, which after the matching commit selects from
-- public.guest_jobs_dispatch and public.listings_dispatch and no longer
-- carries a masking function of its own. Its preflight reads
-- information_schema.columns as this role, which is filtered by privilege, so
-- applying this file without the script change (or the reverse) surfaces as a
-- loud preflight failure rather than a quietly short report.
--
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. The role, only if it is absent
--
-- On a project where 2026-08-18 already ran, this block does nothing and
-- leaves the existing password alone. On a project where it never ran, the
-- role is created WITHOUT LOGIN and therefore cannot connect until a password
-- is set by hand:
--
--   alter role gyema_reader with login password '<generated>';
--
-- Run that in the SQL editor, never in this file. This file is committed to a
-- public repository; the password is not, and the only other copy belongs in
-- the founder laptop environment variable GYEMA_READER_DATABASE_URL.
--
-- nosuperuser, nocreatedb, nocreaterole: this role administers nothing.
-- noinherit: it does not pick up privileges from any role it may later be
-- granted membership in. Every privilege it holds is one written below.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'gyema_reader') then
    create role gyema_reader
      nologin nosuperuser nocreatedb nocreaterole noinherit;
    raise notice 'gyema_reader created WITHOUT LOGIN. Set a password by hand before use.';
  else
    raise notice 'gyema_reader already exists. Password left untouched.';
  end if;
end
$$;


-- ---------------------------------------------------------------------------
-- 2. Session bounds on the role
--
-- default_transaction_read_only is re-asserted from 2026-08-18 because it is
-- the load bearing line of that file and this one has to stand alone. An
-- insert, update, delete or DDL attempt in a gyema_reader session fails with
-- 25006 "cannot execute ... in a read-only transaction", at the database,
-- regardless of what any script is later edited to do.
--
-- statement_timeout is new. The report is fourteen small indexed selects; ten
-- seconds is roughly two orders of magnitude of headroom. Its job is not
-- performance, it is that a credential on a laptop cannot be used to sit on a
-- production database with a runaway scan.
--
-- idle_in_transaction_session_timeout is new for the same reason: a reader
-- session that opens a transaction and stops cannot hold it open.
--
-- lock_timeout is belt and braces on a role that already cannot write.
--
-- Safe to re-run: ALTER ROLE ... SET overwrites.
-- ---------------------------------------------------------------------------
alter role gyema_reader set default_transaction_read_only = on;
alter role gyema_reader set statement_timeout = '10s';
alter role gyema_reader set idle_in_transaction_session_timeout = '30s';
alter role gyema_reader set lock_timeout = '5s';


-- ---------------------------------------------------------------------------
-- 3. Connect and schema usage
--
-- Without these the role authenticates and then cannot see the public schema.
-- Safe to re-run: grants are idempotent.
-- ---------------------------------------------------------------------------
grant connect on database postgres to gyema_reader;
grant usage on schema public to gyema_reader;


-- ---------------------------------------------------------------------------
-- 4. The masking function
--
-- Masks the TAIL, never the head. Given 0244123456 it returns
-- "024*** (10 digits)": enough for the operator to see the network prefix and
-- that a number is present and plausible, and not enough to satisfy any last
-- four guard.
--
-- Three digits of head, not four: four would be a habit worth not forming on
-- a rail where "the last four" is a credential, and three is what identifies
-- a Ghanaian network prefix.
--
-- The digit count is included because a sender who typed fewer than four
-- digits creates a job whose guard can never be satisfied (see
-- app/api/guest/confirm-pickup/route.ts, which returns guard_failed when
-- fewer than four digits are stored). The operator needs to be able to see
-- that case in the report. It is reported as a count, never as the digits.
--
-- SHORT NUMBERS SHOW NO DIGITS AT ALL. Below eight digits the head and the
-- guard overlap: on a stored value of 1234 the last four ARE 1234, so showing
-- three of them would hand over three quarters of the guard and leave ten
-- guesses. Anything under eight digits reports only its length. A real Ghana
-- number is ten digits local or twelve with the country code, so this affects
-- malformed values only, which is exactly where the operator needs a count and
-- nothing more.
--
-- NO FINGERPRINT, deliberately. An md5 or sha of the number would let the
-- operator spot two jobs from one sender, and would also let anyone holding
-- the report recover the number by exhausting a nine or ten digit space in
-- seconds. Whatever value a fingerprint has, it is not worth handing out a
-- recoverable digest of every sender's phone number.
--
-- immutable and strict: it depends on nothing but its argument, and a null in
-- gives a null out without entering the body.
--
-- search_path is pinned and set to a schema nothing can be planted in, per
-- CLAUDE.md invariant 2. The function is NOT security definer; it needs no
-- privileges of its own.
--
-- Safe to re-run: create or replace.
-- ---------------------------------------------------------------------------
create or replace function public.mask_phone_head_only(raw text)
returns text
language sql
immutable
strict
parallel safe
set search_path = pg_catalog, pg_temp
as $$
  select case
    when length(regexp_replace(raw, '[^0-9]', '', 'g')) = 0
      then '(none)'
    when length(regexp_replace(raw, '[^0-9]', '', 'g')) < 4
      then '(unusable, ' || length(regexp_replace(raw, '[^0-9]', '', 'g')) || ' digits)'
    when length(regexp_replace(raw, '[^0-9]', '', 'g')) < 8
      then '(short, ' || length(regexp_replace(raw, '[^0-9]', '', 'g')) || ' digits)'
    else
      left(regexp_replace(raw, '[^0-9]', '', 'g'), 3)
      || repeat('*', greatest(length(regexp_replace(raw, '[^0-9]', '', 'g')) - 3, 0))
      || ' (' || length(regexp_replace(raw, '[^0-9]', '', 'g')) || ' digits)'
  end
$$;

comment on function public.mask_phone_head_only(text) is
  'Head only phone mask for the dispatch reader. Never emits the trailing four digits, which are the sender side guard on the public guest routes.';


-- ---------------------------------------------------------------------------
-- 5. The two views
--
-- drop then create rather than create or replace, because create or replace
-- refuses any change to the column list and this file has to be safe to run
-- over an earlier version of itself.
--
-- security_invoker is left at its default of OFF (section 6 asserts it
-- explicitly where the server supports it). The views therefore read their
-- base tables with the OWNER's rights, which is what lets section 7 take away
-- every base table grant gyema_reader holds. The role reads the views and has
-- no path to the tables underneath them at all: not to sender_phone, not to
-- delivery_code_hash, not to the remit_* settlement columns.
--
-- ROW CAP. Each view carries its own LIMIT. This is the row cap on the role:
-- it is enforced by the view, not by the script, so no edit to the script and
-- no hand typed query at the psql prompt can lift it. 2000 is far above
-- present volume on either network.
--
-- A saturated view is a silent truncation, which is exactly the failure
-- CLAUDE.md invariant 8 warns about, so check for it rather than assume it:
--
--   select count(*) from public.guest_jobs_dispatch;
--
-- A result of exactly 2000 means the cap is binding and the report is short.
-- Raise the cap here, in this file, and mirror it to both networks.
--
-- The ORDER BY inside each view is what makes the cap mean "the most recent
-- 2000 rows" rather than an arbitrary 2000.
-- ---------------------------------------------------------------------------
drop view if exists public.guest_jobs_dispatch;
create view public.guest_jobs_dispatch as
  select
    tracking_id,
    status,
    created_at,
    updated_at,
    phone_verified,
    verified_at,
    pickup_area,
    dropoff_area,
    package_size,
    when_pref,
    scheduled_date,
    quote_cedis,
    payment_type,
    public.mask_phone_head_only(sender_phone)    as sender_phone_masked,
    public.mask_phone_head_only(recipient_phone) as recipient_phone_masked,
    assigned_courier,
    pickup_confirmed_at,
    pickup_confirmed_by,
    delivery_confirmed_at,
    delivery_confirmed_by,
    delivery_code_attempts,
    remit_paid_at
  from public.guest_jobs
  order by created_at desc
  limit 2000;

comment on view public.guest_jobs_dispatch is
  'Dispatch reader view of guest_jobs. Phones are head masked and the raw columns are unreachable through it. Capped at the most recent 2000 rows.';

drop view if exists public.listings_dispatch;
create view public.listings_dispatch as
  select
    tracking_id,
    kind,
    status,
    created_at,
    from_city,
    to_city,
    posted_by_username,
    archived_at
  from public.listings
  order by created_at desc
  limit 2000;

comment on view public.listings_dispatch is
  'Dispatch reader view of listings, sighting columns only. No whatsapp, no posted_by_id, no matched_with_* columns, no prices. Capped at the most recent 2000 rows.';


-- ---------------------------------------------------------------------------
-- 6. Pin security_invoker off explicitly, where the server supports it
--
-- Off is the default, so this changes nothing today. It is written down
-- because the whole privilege model in section 7 depends on it: if a later
-- hand turns security_invoker on, gyema_reader loses its reads (it has no
-- base table grants) rather than gaining anything, but the failure would be
-- confusing without this line to point at.
--
-- Guarded on server_version_num because the option does not exist before
-- Postgres 15 and ALTER VIEW would error there.
-- ---------------------------------------------------------------------------
do $$
begin
  if current_setting('server_version_num')::int >= 150000 then
    execute 'alter view public.guest_jobs_dispatch set (security_invoker = false)';
    execute 'alter view public.listings_dispatch  set (security_invoker = false)';
  else
    raise notice 'server is older than 15, security_invoker not set (default is already off)';
  end if;
end
$$;


-- ---------------------------------------------------------------------------
-- 7. Take the base tables away, give the views
--
-- The revokes are the point of this file. After them, gyema_reader holds no
-- privilege of any kind on public.guest_jobs or public.listings, so the
-- column level grants from 2026-08-18 sections 4 and 5 are gone whether or
-- not that file was ever applied here. revoke is idempotent and does not
-- error when the privilege was never held.
--
-- The row level policies from 2026-08-18 section 6 go with them. They were
-- written for a role reading the tables directly; a role that cannot see the
-- tables has nothing for a policy to filter. Leaving them in place would be a
-- policy that looks load bearing and is not.
--
-- CREATE POLICY has no IF NOT EXISTS form, so the original file dropped
-- before creating. Here only the drop remains.
--
-- Note the asymmetry that is deliberate: this file never touches the
-- table wide grants held by anon, authenticated or service_role. Narrowing
-- anon's read of public.listings is a real and separate finding (the listings
-- SELECT policy is still `true`, see 2026-08-14 section notes), and it would
-- change what the app itself can read. It does not belong in a migration
-- about an operator credential.
-- ---------------------------------------------------------------------------
drop policy if exists gyema_reader_select on public.guest_jobs;
drop policy if exists gyema_reader_select on public.listings;

revoke all on public.guest_jobs from gyema_reader;
revoke all on public.listings   from gyema_reader;

grant select on public.guest_jobs_dispatch to gyema_reader;
grant select on public.listings_dispatch   to gyema_reader;


-- ---------------------------------------------------------------------------
-- 8. Verification, per CLAUDE.md invariant 8
--
-- DDL reports Success whether or not it did what was intended, so verify from
-- catalog state, not from the banner. Run each of these after applying, on
-- each network, and read the result.
--
-- (a) The role's session bounds. Expect four rows in rolconfig:
--     default_transaction_read_only=on, statement_timeout=10s,
--     idle_in_transaction_session_timeout=30s, lock_timeout=5s.
--
--     select rolname, rolcanlogin, rolconfig
--       from pg_roles
--      where rolname = 'gyema_reader';
--
-- (b) What the role can reach. Expect exactly two rows, both SELECT, both on
--     a view, and NEITHER on guest_jobs or listings.
--
--     select table_name, privilege_type
--       from information_schema.role_table_grants
--      where grantee = 'gyema_reader'
--      order by table_name, privilege_type;
--
-- (c) The phone columns specifically. Expect ZERO rows. A row here means the
--     revoke in section 7 did not take and the report can still print a
--     guard.
--
--     select table_name, column_name, privilege_type
--       from information_schema.column_privileges
--      where grantee = 'gyema_reader'
--        and column_name in ('sender_phone', 'recipient_phone');
--
-- (d) The mask itself. Expect "024*** (10 digits)", and in particular expect
--     the trailing 3456 to be absent from the output.
--
--     select public.mask_phone_head_only('0244123456');
--
-- (e) The row cap is not silently binding. A result below 2000 is healthy; a
--     result of exactly 2000 means the report is truncated and the cap in
--     section 5 needs raising on both networks.
--
--     select count(*) from public.guest_jobs_dispatch;
--
-- (f) The old policies are gone. Expect zero rows.
--
--     select tablename, policyname
--       from pg_policies
--      where policyname = 'gyema_reader_select';
--
-- ROLLBACK, if this file needs undoing. It restores nothing from 2026-08-18
-- on purpose: re-granting the phone columns is the thing this file exists to
-- prevent, so an undo should stop at removing what was added here and be
-- followed by a decision, not by a paste of the superseded file.
--
--   revoke all on public.guest_jobs_dispatch from gyema_reader;
--   revoke all on public.listings_dispatch   from gyema_reader;
--   drop view if exists public.guest_jobs_dispatch;
--   drop view if exists public.listings_dispatch;
--   drop function if exists public.mask_phone_head_only(text);
--
-- ===========================================================================
