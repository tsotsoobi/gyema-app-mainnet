-- ===========================================================================
-- 2026-09-07  An attempt ceiling for the sender side last-4 guard
-- ===========================================================================
--
-- THE FINDING (S-2)
--
-- Three public routes are guarded by the tracking ID plus the last four digits
-- of the sender's phone:
--
--   /api/guest/delivery-code    returns the one time delivery code, in plain
--   /api/guest/confirm-pickup   stamps the pickup
--   /api/guest/confirm-delivery on its via = "sender" path, stamps delivery
--
-- Four digits is ten thousand values, and there was no attempt counter and no
-- rate limit on any of them. A few minutes of scripted requests against one
-- tracking ID wins, and the prize is the delivery code, a pickup confirmation
-- and a delivery sign off on a package the attacker never touched.
--
-- The asymmetry is what makes it look unintended rather than accepted: the
-- COURIER code path, in the same file as one of these guards, has had a five
-- attempt ceiling enforced by an atomic RPC since 2026-08-13. The sender side
-- guarding the same job had nothing.
--
-- WHAT THIS ADDS
--
-- One counter column and one RPC to increment it, mirroring
-- guest_bump_delivery_code_attempts exactly, because the concurrency problem
-- is exactly the same: a read-modify-write from a route lets two simultaneous
-- wrong guesses cost one attempt between them, which is precisely the shape an
-- attacker would use.
--
-- The ceiling itself lives in the routes (lib/last4-guard.ts), not here. This
-- file provides the counter and the means to increment it safely.
--
-- WHY TEN AND NOT FIVE
--
-- The courier's five is a code they were told once and are typing at a door.
-- The sender's four digits are their own phone number, and the ways to get
-- them wrong are mundane: a number stored with a country code they did not
-- type it with, an old phone, a typo on a small screen in the sun. Ten is
-- still 1 in 1000 for a blind guess, and a sender who burns ten on their own
-- number has a support conversation rather than a lockout they cannot explain.
--
-- No decay, no reset on success, deliberately. A window that reopens is a
-- window an attacker waits for; a counter that resets on success is a counter
-- an attacker resets. Ten attempts per job, for the life of the job. When a
-- legitimate sender exhausts them, the operator can zero the column by hand
-- after checking who they are, which is the right amount of friction for a
-- rare event.
--
-- IDEMPOTENT. add column if not exists, create or replace, and grants that are
-- no-ops when already held.
--
-- Applied MANUALLY, per project, Testnet first, Mainnet on an explicit go
-- ahead. Confirm the project breadcrumb before pasting.
--
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. The counter
--
-- not null default 0 so every existing row starts with a full budget and no
-- route has to treat null as zero.
-- ---------------------------------------------------------------------------
alter table public.guest_jobs
  add column if not exists last4_attempts integer not null default 0;

comment on column public.guest_jobs.last4_attempts is
  'Failed sender side last-4 guard attempts for this job. Ceiling enforced in lib/last4-guard.ts. No reset on success and no decay: an operator zeroes it by hand after identifying the sender.';


-- ---------------------------------------------------------------------------
-- 2. The atomic increment
--
-- Returns the NEW value so the caller knows how many are left without a second
-- read, and so two concurrent failures cannot both read the same old value.
--
-- Mirrors guest_bump_delivery_code_attempts from 2026-08-13 down to the shape
-- of the return, because the routes that call them sit next to each other and
-- a difference between them would be a difference someone has to hold in their
-- head.
--
-- security definer with search_path pinned, EXECUTE revoked from public, anon
-- and authenticated and granted to service_role alone (CLAUDE.md invariant 2).
-- The routes reach it with the service_role key; nothing else may.
-- ---------------------------------------------------------------------------
create or replace function public.guest_bump_last4_attempts(p_tracking_id text)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_attempts integer;
begin
  update public.guest_jobs
     set last4_attempts = last4_attempts + 1
   where tracking_id = p_tracking_id
     and phone_verified = true
  returning last4_attempts into v_attempts;

  -- No row: an unverified draft or a tracking ID that does not exist. The
  -- caller is refusing that request anyway; returning null lets it say so
  -- without inventing a count.
  return v_attempts;
end
$$;

revoke all on function public.guest_bump_last4_attempts(text)
  from public, anon, authenticated;

grant execute on function public.guest_bump_last4_attempts(text)
  to service_role;


-- ---------------------------------------------------------------------------
-- 3. Verification, per CLAUDE.md invariant 8
--
-- (a) The column exists, is not null, and defaults to 0.
--
--     select column_name, data_type, is_nullable, column_default
--       from information_schema.columns
--      where table_schema = 'public' and table_name = 'guest_jobs'
--        and column_name = 'last4_attempts';
--
-- (b) The function is security definer with search_path pinned, and only
--     service_role can execute it. Expect prosecdef true, proconfig carrying
--     search_path, and an ACL naming service_role and the owner, with no anon
--     and no authenticated.
--
--     select p.proname, p.prosecdef, p.proconfig, p.proacl
--       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--      where n.nspname = 'public' and p.proname = 'guest_bump_last4_attempts';
--
-- (c) Existing jobs all start with a full budget. Expect every row at 0 the
--     first time this runs.
--
--     select last4_attempts, count(*)
--       from public.guest_jobs group by last4_attempts order by last4_attempts;
--
-- (d) The behavioural check, after the code deploy: on the public tracker,
--     enter a wrong last 4 for a job you own eleven times. The first ten
--     answer "wrong number", the eleventh says the guard is locked, and the
--     column reads 10. Then check the RIGHT number is also refused, because
--     that is the point of a ceiling and it is the part that surprises people.
--
--     To release a genuine sender afterwards, having identified them by some
--     other means:
--
--       update public.guest_jobs set last4_attempts = 0
--        where tracking_id = 'GYM-XXXXXX';
--
--     Run it with RETURNING and read the row back, per invariant 8.
--
-- ROLLBACK. Dropping the ceiling restores an unlimited guessing surface on a
-- guard that hands out a delivery code, so treat it as incident response:
--
--   drop function if exists public.guest_bump_last4_attempts(text);
--   alter table public.guest_jobs drop column if exists last4_attempts;
--
-- ===========================================================================
