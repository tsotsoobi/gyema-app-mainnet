-- ===========================================================================
-- 2026-08-13  Phase 3: one-time delivery code
-- ===========================================================================
--
-- HOW THIS FILE IS USED
--
-- Applied MANUALLY, per project, through the Supabase SQL editor. Testnet
-- first; Mainnet at mirror time. There is no automated runner in this repo,
-- no migration table, and nothing reads this directory at build or deploy
-- time. This file is the durable record of what was run and why, so that the
-- schema the routes assume can be reconstructed and reviewed from the repo
-- rather than from memory or from a dashboard's history.
--
-- Run it top to bottom. Every statement is safe to re-run: the column adds
-- are IF NOT EXISTS, the functions are CREATE OR REPLACE, and the grants are
-- idempotent.
--
-- WHAT DEPENDS ON IT
--
-- app/api/guest/confirm-delivery/route.ts calls both functions by name. Until
-- they exist, the courier path fails: a wrong code returns update_failed
-- instead of counting an attempt, and a correct code cannot stamp at all.
--
-- Section 4 is a verification query, not a change. Run it and read the output
-- before trusting the delivered gate in section 3.
--
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. Columns
--
-- Section 1 was applied to Testnet by hand ahead of this file. On any project
-- where that has not happened, these statements do the work. Kept here so the
-- file is a complete account of the schema the delivery code needs. Re-running
-- where the columns already exist is a no-op.
--
-- delivery_code_hash is nullable and that nullity is load-bearing, not
-- incidental: it is the discriminator the whole feature branches on. A null
-- hash means a job that predates the delivery code, and those keep the
-- original single-stamp delivery rule. Backfilling this column would
-- retroactively demand a courier stamp on jobs whose couriers were never
-- given a code, stranding them in in_transit permanently. Do not backfill.
-- ---------------------------------------------------------------------------
alter table guest_jobs
  add column if not exists delivery_code_hash text null;

alter table guest_jobs
  add column if not exists delivery_code_attempts integer not null default 0;


-- ---------------------------------------------------------------------------
-- 2. Atomic wrong-code counter
--
-- One statement, so two concurrent wrong guesses cost two attempts rather
-- than sharing one. Returns the NEW count, or null if no verified row matched
-- (the route then falls back to its own read + 1 and still refuses).
-- ---------------------------------------------------------------------------
create or replace function public.guest_bump_delivery_code_attempts(
  p_tracking_id text
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_attempts integer;
begin
  update guest_jobs
     set delivery_code_attempts = delivery_code_attempts + 1,
         updated_at = now()
   where tracking_id = p_tracking_id
     and phone_verified = true
  returning delivery_code_attempts into v_attempts;

  return v_attempts;
end;
$$;


-- ---------------------------------------------------------------------------
-- 3. Stamp one side of a coded delivery, and close it once both sides are in
--
-- guest_jobs carries ONE (delivery_confirmed_at, delivery_confirmed_by) pair,
-- so a coded job records both stamps in it:
--
--   first stamp   delivery_confirmed_by = 'sender' or 'courier_code'
--   second stamp  delivery_confirmed_by = 'sender+courier_code', status flips
--                 to 'delivered'
--
-- The composite is always written in that exact order regardless of who
-- stamped first, so the app compares by equality and never parses.
-- delivery_confirmed_at is set by whichever stamp lands first and is NEVER
-- overwritten: it keeps meaning "when this delivery was first signed off".
--
-- SELECT ... FOR UPDATE is the point of this function. Sender and courier can
-- stamp concurrently, and a read-modify-write from the route would let the
-- second write clobber the first, losing a stamp and stranding the job in
-- in_transit forever.
--
-- CODED JOBS ONLY. A row with a null delivery_code_hash returns no row and is
-- left entirely alone, so jobs predating this feature keep the single-stamp
-- rule and the exact write path they have always had.
--
-- Returns no row (not an error) when the job is missing, unverified, uncoded,
-- or no longer in_transit. The route reports that as state_changed.
-- ---------------------------------------------------------------------------
create or replace function public.guest_stamp_delivery(
  p_tracking_id text,
  p_via text
)
returns table (
  delivery_confirmed_at timestamptz,
  delivery_confirmed_by text,
  status text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job guest_jobs%rowtype;
  v_by text;
  v_at timestamptz;
  v_status text;
begin
  -- The route validates this too. Duplicated here because this function is
  -- the thing that actually writes, and an unrecognised via must never fall
  -- through to a stamp.
  if p_via not in ('sender', 'courier_code') then
    raise exception 'guest_stamp_delivery: invalid via %', p_via;
  end if;

  select * into v_job
    from guest_jobs
   where tracking_id = p_tracking_id
     and phone_verified = true
   for update;

  if not found then return; end if;
  if v_job.delivery_code_hash is null then return; end if;
  if v_job.status <> 'in_transit' then return; end if;

  if v_job.delivery_confirmed_by is null then
    v_by := p_via;
  elsif v_job.delivery_confirmed_by in (p_via, 'sender+courier_code') then
    -- This side already stamped. Idempotent: return current state unchanged.
    v_by := v_job.delivery_confirmed_by;
  else
    v_by := 'sender+courier_code';
  end if;

  v_at := coalesce(v_job.delivery_confirmed_at, now());

  if v_by = 'sender+courier_code' then
    update guest_jobs
       set delivery_confirmed_at = v_at,
           delivery_confirmed_by = v_by,
           status = 'delivered',
           updated_at = now()
     where tracking_id = p_tracking_id;
    v_status := 'delivered';
  else
    -- One stamp only: record it and leave status alone. A coded job does not
    -- reach delivered on a single side.
    update guest_jobs
       set delivery_confirmed_at = v_at,
           delivery_confirmed_by = v_by,
           updated_at = now()
     where tracking_id = p_tracking_id;
    v_status := v_job.status::text;
  end if;

  return query select v_at, v_by, v_status;
end;
$$;


-- ---------------------------------------------------------------------------
-- 4. Lock both functions to service_role
--
-- NOT optional, and not a tidiness measure. Postgres grants EXECUTE on new
-- functions to PUBLIC, and PostgREST exposes public-schema functions to the
-- anon and authenticated roles. Without these revokes, anyone holding the
-- anon key could POST to /rest/v1/rpc/guest_stamp_delivery with a tracking ID
-- and close a delivery outright, code and last-4 guards bypassed entirely.
-- Both functions are security definer, so they would run with the owner's
-- rights while doing it.
--
-- The routes reach these through the service_role admin client only
-- (lib/supabase-admin.ts), same as every other guest write.
-- ---------------------------------------------------------------------------
revoke all on function public.guest_bump_delivery_code_attempts(text)
  from public, anon, authenticated;
revoke all on function public.guest_stamp_delivery(text, text)
  from public, anon, authenticated;

grant execute on function public.guest_bump_delivery_code_attempts(text)
  to service_role;
grant execute on function public.guest_stamp_delivery(text, text)
  to service_role;


-- ---------------------------------------------------------------------------
-- 5. Verification (read-only, changes nothing)
--
-- Nothing in the application code writes guest_jobs.status = 'in_transit' or
-- 'delivered', so something outside the repo moves those. If that something
-- is a trigger keyed on delivery_confirmed_at, it will fire on the FIRST
-- stamp of a coded job and mark it delivered before the second side arrives,
-- defeating the both-stamps gate in section 3 without any error surfacing.
--
-- Run this and read the output. If a trigger of that shape exists, it needs
-- "and new.delivery_code_hash is null" added to its condition, so the RPC
-- above owns the delivered flip for coded rows and the trigger keeps owning
-- it for legacy rows.
--
--   select tgname, pg_get_triggerdef(oid)
--     from pg_trigger
--    where tgrelid = 'guest_jobs'::regclass
--      and not tgisinternal;
--
-- Confirm the grants took, while you are here. Expect service_role only:
--
--   select p.proname, p.proacl
--     from pg_proc p
--     join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public'
--      and p.proname in (
--            'guest_stamp_delivery',
--            'guest_bump_delivery_code_attempts'
--          );
-- ---------------------------------------------------------------------------
