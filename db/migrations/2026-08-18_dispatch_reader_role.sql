-- ===========================================================================
-- 2026-08-18  Dispatch Reader: least privileged read only role
-- ===========================================================================
--
-- HOW THIS FILE IS USED
--
-- Applied MANUALLY, per project, through the Supabase SQL editor, same as
-- every other file in this directory. There is no automated runner in this
-- repo and nothing reads this directory at build or deploy time. This file is
-- the durable record of what was run and why.
--
-- It creates ONE role, gyema_reader, whose entire capability is SELECT on a
-- named list of columns in exactly two tables, inside transactions the
-- database itself forces to be read only. Nothing else. The role is the
-- credential that scripts/dispatch-reader.mjs carries on the founder laptop.
--
-- WHAT DEPENDS ON IT
--
-- scripts/dispatch-reader.mjs connects as this role and prints the guest
-- dispatch operations brief. Its preflight reads information_schema.columns
-- and refuses to run if any column it needs is not visible. Because
-- information_schema.columns is itself filtered by privilege, a column that
-- was never granted here shows up as a preflight failure rather than as a
-- silently short report. Getting the grant lists in sections 4 and 5 wrong is
-- therefore loud, not quiet.
--
-- THIS FILE IS NOT IDEMPOTENT AS A WHOLE. Section 1 errors with 42710 on a
-- second run; section 6 handles its own re-run with an explicit drop.
-- Expected re-run errors are called out inline. Run it top to bottom, one
-- statement at a time, and read the result of each before moving on: the
-- Supabase SQL editor does not preserve transaction state across executions.
--
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. The role
--
-- Generate a long random password and paste it into the statement below IN
-- THE SQL EDITOR. Do NOT type it into this file. This file is committed; the
-- password is not, and the only other copy belongs in the founder laptop
-- environment variable GYEMA_READER_DATABASE_URL.
--
-- nosuperuser, nocreatedb, nocreaterole: this role administers nothing.
-- noinherit: it does not pick up privileges from any role it may later be
-- granted membership in. Every privilege it holds is one written below.
--
-- Re-running this statement errors 42710 "role gyema_reader already exists".
-- That error is safe to read and ignore; it means section 1 is already done.
-- ---------------------------------------------------------------------------
create role gyema_reader with login password '__REPLACE_WITH_GENERATED_PASSWORD__'
  nosuperuser nocreatedb nocreaterole noinherit;


-- ---------------------------------------------------------------------------
-- 2. Force every session this role opens to be read only
--
-- This is the load bearing line of the whole file. The column grants stop the
-- role from reading what it should not read; this stops it from writing at
-- all, at the database, regardless of what any script does or is later edited
-- to do. An insert, update, delete, or DDL attempt in a gyema_reader session
-- fails with 25006 "cannot execute ... in a read-only transaction".
--
-- The agent boundary in CLAUDE.md says agents never mutate a database. This
-- statement makes that boundary something Postgres enforces on the reader
-- credential rather than something a reviewer has to keep verifying by eye.
--
-- Safe to re-run: ALTER ROLE ... SET overwrites.
-- ---------------------------------------------------------------------------
alter role gyema_reader set default_transaction_read_only = on;


-- ---------------------------------------------------------------------------
-- 3. Connect and schema usage
--
-- Without these the role authenticates and then cannot see the public schema.
-- Safe to re-run: grants are idempotent.
-- ---------------------------------------------------------------------------
grant connect on database postgres to gyema_reader;
grant usage on schema public to gyema_reader;


-- ---------------------------------------------------------------------------
-- 4. Column level SELECT on guest_jobs, 22 columns
--
-- Column level and not table level, deliberately. CLAUDE.md records that a
-- column level revoke cannot subtract from a table wide grant, so a table
-- wide grant here could not be narrowed later without dropping and redoing
-- it. gyema_reader is a fresh role with no table wide grant, so there is
-- nothing for these column grants to fail to subtract from.
--
-- WHAT IS DELIBERATELY ABSENT AND WHY:
--
--   delivery_code_hash      NOT granted. The delivery code space is 4 digits,
--                           so a hash handed to any reader is the code, and a
--                           code the courier already knows is no longer
--                           evidence they reached the door. The report gives
--                           up the ability to mark an in_transit row as coded
--                           versus legacy; delivery_confirmed_by still tells
--                           those apart once a stamp lands. Deliberate trade.
--
--   id                      NOT granted. tracking_id is the operator handle.
--   recipient_name          NOT granted. No line of the brief reads it.
--   contents_note           NOT granted. Package contents are not operations
--                           data and no line of the brief reads them.
--   pickup_landmark         NOT granted. Same reason.
--   dropoff_landmark        NOT granted. Same reason.
--   assigned_courier_whatsapp   NOT granted. The report contacts nobody.
--   remit_cedis, remit_pi, remit_rate, remit_method, remit_ref
--                           NOT granted. Section 8 of the brief sums
--                           quote_cedis, not remit_cedis. Only the nullity of
--                           remit_paid_at decides what is outstanding.
--
-- sender_phone and recipient_phone ARE granted: the last 4 digits are the
-- sender side guard reference the operator works from. The script masks every
-- phone to its trailing 4 digits before printing and never emits a full
-- number.
--
-- Safe to re-run: grants are idempotent.
-- ---------------------------------------------------------------------------
grant select (
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
  sender_phone,
  recipient_phone,
  assigned_courier,
  pickup_confirmed_at,
  pickup_confirmed_by,
  delivery_confirmed_at,
  delivery_confirmed_by,
  delivery_code_attempts,
  remit_paid_at
) on public.guest_jobs to gyema_reader;


-- ---------------------------------------------------------------------------
-- 5. Column level SELECT on listings, 8 columns
--
-- Section 9 of the brief is a read only sighting list of the Pioneer rail:
-- rows created in the last 48 hours, with poster username, kind, and route.
-- No analysis, and nothing in the report ever adds a Pioneer number to a
-- Guest number. The two rails never blend.
--
-- archived_at is granted so an archived listing cannot read as an active one
-- in the sighting list. whatsapp, posted_by_id, price_pi, offer_pi, notes,
-- description, capacity, size, travel_date, deliver_by, completed_at and the
-- matched_with_* columns are NOT granted: no line of the brief reads them.
--
-- Safe to re-run: grants are idempotent.
-- ---------------------------------------------------------------------------
grant select (
  tracking_id,
  kind,
  status,
  created_at,
  from_city,
  to_city,
  posted_by_username,
  archived_at
) on public.listings to gyema_reader;


-- ---------------------------------------------------------------------------
-- 6. Row level security policies
--
-- guest_jobs has RLS enabled with no policy that admits this role, so the
-- grants in section 4 on their own produce a successful query returning ZERO
-- rows. That failure mode is silent: an empty report reads exactly like a
-- quiet day. These two policies are what make the grants above actually
-- return rows.
--
-- Both policies are FOR SELECT only and are scoped TO gyema_reader
-- explicitly, so they widen nothing for anon, authenticated, service_role, or
-- any other role. Postgres combines permissive policies with OR, so adding a
-- policy for one named role cannot subtract from or alter what an existing
-- policy already allows for a different role.
--
-- USING (true) means gyema_reader reads every row of these two tables. That
-- is the intent: the dispatch brief is an operator view of the whole guest
-- queue and the whole 48 hour Pioneer sighting window. The narrowing that
-- protects data here is the column list in sections 4 and 5, not a row
-- predicate.
--
-- If RLS happens to be disabled on either table, its policy sits inert and
-- the column grant alone governs. Creating it anyway means the report does
-- not break on the day RLS is switched on.
--
-- CREATE POLICY has no IF NOT EXISTS form, so each create is preceded by a
-- guarded drop to make section 6 re-runnable. Each drop names the same policy
-- name and the same table as the create immediately below it, and removes
-- nothing else.
-- ---------------------------------------------------------------------------
drop policy if exists gyema_reader_select on public.guest_jobs;

create policy gyema_reader_select
  on public.guest_jobs
  for select
  to gyema_reader
  using (true);

drop policy if exists gyema_reader_select on public.listings;

create policy gyema_reader_select
  on public.listings
  for select
  to gyema_reader
  using (true);


-- ---------------------------------------------------------------------------
-- 7. Verification (read only, changes nothing)
--
-- Run every one of these and read the output. CLAUDE.md is explicit that a
-- Success banner is not evidence and that DDL is verified by querying catalog
-- state. None of the four queries below writes anything.
--
-- 7a. The role exists and administers nothing. Expect one row, with
--     rolcanlogin true and rolsuper, rolcreatedb, rolcreaterole, rolinherit
--     all false.
--
--   select rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolinherit
--     from pg_roles
--    where rolname = 'gyema_reader';
--
-- 7b. The read only default took. Expect rolconfig to contain
--     default_transaction_read_only=on. A null rolconfig means section 2 did
--     not apply and the credential can write.
--
--   select rolname, rolconfig
--     from pg_roles
--    where rolname = 'gyema_reader';
--
-- 7c. The column grants are exactly what sections 4 and 5 asked for. Expect
--     30 rows: 22 on guest_jobs, 8 on listings, every privilege_type SELECT.
--     Any row naming delivery_code_hash is a mistake and must be revoked.
--     CLAUDE.md points at this view for exactly this class of question.
--
--   select table_name, column_name, privilege_type
--     from information_schema.column_privileges
--    where grantee = 'gyema_reader'
--    order by table_name, column_name;
--
-- 7d. Both policies exist, are SELECT only, and name gyema_reader and nobody
--     else. Expect two rows, each with cmd = SELECT, roles = {gyema_reader},
--     and qual = true.
--
--   select schemaname, tablename, policyname, cmd, roles, qual
--     from pg_policies
--    where policyname = 'gyema_reader_select'
--    order by tablename;
--
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- 8. Rollback, if this role is ever retired
--
-- Not part of applying the file. Recorded so the removal is one known
-- sequence rather than something reconstructed under pressure. Order matters:
-- the role cannot be dropped while it still holds privileges.
--
--   drop policy if exists gyema_reader_select on public.guest_jobs;
--   drop policy if exists gyema_reader_select on public.listings;
--   revoke all on public.guest_jobs from gyema_reader;
--   revoke all on public.listings from gyema_reader;
--   revoke all on schema public from gyema_reader;
--   revoke all on database postgres from gyema_reader;
--   drop role gyema_reader;
--
-- ---------------------------------------------------------------------------
