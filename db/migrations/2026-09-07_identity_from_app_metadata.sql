-- ===========================================================================
-- 2026-09-07  Identity moves from user_metadata to app_metadata
-- ===========================================================================
--
-- THE FINDING
--
-- The listings RLS policies decide ownership by reading
-- ((auth.jwt() -> 'user_metadata') ->> 'pi_uid').
--
-- user_metadata is the user's OWN metadata. A signed in client writes it with
-- supabase.auth.updateUser({ data: { pi_uid: '<somebody else>' } }), holding
-- nothing but the public anon key and their own session. Supabase then mints
-- their next token with that value in the claim.
--
-- So every policy that reads it is asking the caller who they are and
-- believing the answer. With one updateUser call and a refresh, a Pioneer
-- becomes any other Pioneer for the purposes of row level security: their
-- listings are yours to update, their matches are yours to cancel, and the
-- counterpart contact RPC hands you their phone number.
--
-- app_metadata is written only with the service_role key. A client cannot
-- touch it at any price, and it rides in the same JWT, so a policy reads it
-- exactly the same way and gets a value the caller could not choose.
--
-- WHAT HAS TO BE TRUE BEFORE THIS FILE RUNS
--
-- Every active Pioneer needs app_metadata.pi_uid populated, or their policies
-- will match nothing and the app will behave as though they own no listings.
-- Two things do that, and both ship before this migration:
--
--   1. /api/auth/verify stamps app_metadata on every sign in, before the
--      session is minted, so any fresh login carries the claim.
--   2. scripts/backfill-app-metadata.mjs copies the existing user_metadata
--      identity across for accounts that have not signed in since.
--
-- docs/deploy-order.md has the order: code deploy, backfill, grant baseline,
-- this file, reader migration, catalog check after each.
--
-- WHAT THIS FILE DOES
--
-- Replaces the entire policy set on public.listings with four policies that
-- read app_metadata, and rewrites listing_counterpart_contact to cross check
-- the JWT claim against the pioneers table.
--
-- IT DROPS EVERY EXISTING POLICY ON public.listings, by discovery rather than
-- by name, and prints what it dropped. That is deliberate: the point is that
-- afterwards there is no policy on that table reading a forgeable claim, and
-- that cannot be promised while dropping only the names I happen to know. The
-- notice tells you exactly what went, so an unexpected name is visible rather
-- than silently gone.
--
-- It does not touch guest_jobs, which has no policy admitting anon or
-- authenticated at all: the guest rail is served entirely by service_role.
--
-- IDEMPOTENT. Drop-then-create throughout, and the discovery loop is a no-op
-- on a second run because the four policies it recreates are the four it
-- dropped.
--
-- Applied MANUALLY, per project, Testnet first, Mainnet on an explicit go
-- ahead. Confirm the project breadcrumb before pasting.
--
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. Drop every existing policy on public.listings
--
-- The names on the two networks are not guaranteed to match: Mainnet was hand
-- tightened and Testnet was not, and 2026-08-14 recreated its UPDATE policy by
-- name while leaving the SELECT and DELETE policies untouched from whenever
-- they were first written.
-- ---------------------------------------------------------------------------
do $$
declare
  r record;
  v_count int := 0;
begin
  for r in
    select policyname from pg_policies
     where schemaname = 'public' and tablename = 'listings'
  loop
    execute format('drop policy if exists %I on public.listings', r.policyname);
    raise notice 'dropped policy on listings: %', r.policyname;
    v_count := v_count + 1;
  end loop;
  raise notice 'dropped % policy/policies on public.listings', v_count;
end
$$;


-- ---------------------------------------------------------------------------
-- 2. The four policies
--
-- Every one of them reads ((auth.jwt() -> 'app_metadata') ->> 'pi_uid'). The
-- expression is written out in each policy rather than wrapped in a helper
-- function, so section 4's check can look for the string "user_metadata" in
-- policy bodies and mean something.
--
-- SELECT stays open. It is what makes the marketplace browsable without an
-- account and what makes a tracking ID resolve for a recipient who will never
-- sign in. The phone columns are no longer readable through it: the grant
-- baseline gives anon and authenticated column level SELECT with whatsapp and
-- matched_with_whatsapp excluded, so "open" here means the columns a stranger
-- may see, not every column.
--
-- INSERT pins posted_by_id to the caller. This closes S-15, which was open
-- because nothing anywhere checked it: lib/listings-async.ts sends
-- posted_by_id from the client, and until now a Pioneer could post a listing
-- under another Pioneer's uid. It is worth being clear that the check is only
-- as good as the claim, which is exactly why it had to wait for app_metadata.
--
-- UPDATE admits the poster and the matched party, as before. It stays row
-- level and still cannot see WHICH column a request writes, which is why the
-- grant baseline reduces authenticated's UPDATE to the two archive columns and
-- why status transitions and completion live in routes and RPCs.
--
-- DELETE admits the poster and nobody else. authenticated holds no DELETE
-- grant after the grant baseline, so this policy authorises nothing today: a
-- privilege and a policy both have to say yes. It is written anyway rather
-- than left absent, because a policy that says "the poster, if anyone" is a
-- better thing to find here later than no policy and a grant somebody adds in
-- a hurry.
-- ---------------------------------------------------------------------------

create policy "listings_select_public"
  on public.listings
  for select
  using (true);

create policy "listings_insert_own"
  on public.listings
  for insert
  to authenticated
  with check (
    posted_by_id = ((auth.jwt() -> 'app_metadata') ->> 'pi_uid')
  );

create policy "listings_update_parties"
  on public.listings
  for update
  to authenticated
  using (
    posted_by_id = ((auth.jwt() -> 'app_metadata') ->> 'pi_uid')
    or matched_with_user_id = ((auth.jwt() -> 'app_metadata') ->> 'pi_uid')
  )
  with check (
    posted_by_id = ((auth.jwt() -> 'app_metadata') ->> 'pi_uid')
    or matched_with_user_id = ((auth.jwt() -> 'app_metadata') ->> 'pi_uid')
  );

create policy "listings_delete_poster"
  on public.listings
  for delete
  to authenticated
  using (
    posted_by_id = ((auth.jwt() -> 'app_metadata') ->> 'pi_uid')
  );


-- ---------------------------------------------------------------------------
-- 3. listing_counterpart_contact: two checks, not one
--
-- Replaces the version from db/migrations/2026-09-07_grant_baseline.sql, which
-- resolved the caller through public.pioneers alone. That was the right call
-- while the JWT claim was forgeable. Now that app_metadata is not, the claim
-- is the primary check and the pioneers lookup stays as a second one.
--
-- Both must agree. They are written by different paths at different times:
-- app_metadata is stamped by /api/auth/verify at sign in, the pioneers row is
-- written when the Pioneer is first provisioned. A disagreement means one of
-- them is stale or wrong, and the honest answer to "which one is right" is not
-- to guess but to return nothing, which is what a refusal looks like here
-- anyway.
--
-- The cost is real and worth naming: a Pioneer whose pi_uid rotated on Testnet
-- between the stamp and the pioneers row can be refused their counterparty's
-- number until they sign in again, which restamps app_metadata from the
-- canonical uid. Pi rotating uids across sessions is documented behaviour on
-- Testnet (see lib/supabase-admin.ts), so this will happen. Refusing a phone
-- number until the next sign in is the right side to err on.
--
-- Everything else is unchanged: security definer, search_path pinned, EXECUTE
-- to authenticated and service_role only, zero rows for every refusal so the
-- caller cannot tell "not a party" from "no such listing" from "not matched".
-- ---------------------------------------------------------------------------
create or replace function public.listing_counterpart_contact(p_listing_id text)
returns table (counterparty_role text, counterparty_username text, whatsapp text)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_claim_uid text;
  v_pioneer_uid text;
  v_listing public.listings%rowtype;
begin
  if p_listing_id is null then
    return;
  end if;

  -- Check one: the JWT claim, which only the service_role key can write.
  v_claim_uid := ((auth.jwt() -> 'app_metadata') ->> 'pi_uid');
  if v_claim_uid is null then
    return;
  end if;

  -- Check two: the pioneers row for this Supabase user. Written by a different
  -- path at a different time, so agreement between the two is worth something.
  select p.pi_uid
    into v_pioneer_uid
    from public.pioneers p
   where p.supabase_user_id::text = auth.uid()::text
   order by p.created_at asc
   limit 1;

  if v_pioneer_uid is null or v_pioneer_uid is distinct from v_claim_uid then
    return;
  end if;

  select * into v_listing
    from public.listings l
   where l.id = p_listing_id;

  if not found then
    return;
  end if;

  if v_listing.matched_with_user_id is null then
    return;
  end if;

  if v_listing.posted_by_id = v_claim_uid then
    return query
      select 'matched'::text,
             v_listing.matched_with_username,
             v_listing.matched_with_whatsapp;
  elsif v_listing.matched_with_user_id = v_claim_uid then
    return query
      select 'poster'::text,
             v_listing.posted_by_username,
             v_listing.whatsapp;
  end if;

  return;
end
$$;

comment on function public.listing_counterpart_contact(text) is
  'Returns the other party whatsapp on one matched listing, to that listing''s poster or matched party only. Identity is the app_metadata pi_uid claim, cross checked against public.pioneers via auth.uid(). Never user_metadata, which the user can write.';

revoke all on function public.listing_counterpart_contact(text) from public, anon;
grant execute on function public.listing_counterpart_contact(text) to authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 4. Verification, per CLAUDE.md invariant 8
--
-- (a) THE ONE THAT MATTERS. No policy anywhere in public may reference
--     user_metadata. Expect ZERO rows, on both networks.
--
--     select tablename, policyname, cmd
--       from pg_policies
--      where schemaname = 'public'
--        and (coalesce(qual, '') like '%user_metadata%'
--          or coalesce(with_check, '') like '%user_metadata%');
--
-- (b) And no function either. Expect ZERO rows. A security definer function
--     reading user_metadata would be the same hole wearing a different hat.
--
--     prokind = 'f' matters: pg_get_functiondef raises on an aggregate, and
--     Supabase projects carry a few in public. Measured that the hard way.
--
--     select p.proname
--       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--      where n.nspname = 'public'
--        and p.prokind = 'f'
--        and pg_get_functiondef(p.oid) like '%user_metadata%';
--
-- (c) The four policies, and only these four, on listings. Expect exactly four
--     rows: listings_select_public (SELECT), listings_insert_own (INSERT),
--     listings_update_parties (UPDATE), listings_delete_poster (DELETE), each
--     one carrying app_metadata except the SELECT, whose qual is true.
--
--     select policyname, cmd, roles, qual, with_check
--       from pg_policies
--      where schemaname = 'public' and tablename = 'listings'
--      order by cmd, policyname;
--
-- (d) The INSERT policy actually pins the poster. Expect true. This is S-15,
--     and it is the one line that decides whether a Pioneer can post as
--     somebody else.
--
--     select with_check like '%posted_by_id%'
--        and with_check like '%app_metadata%' as pins_poster
--       from pg_policies
--      where schemaname = 'public' and tablename = 'listings' and cmd = 'INSERT';
--
-- (e) The RPC is the two check version and still service_role plus
--     authenticated only.
--
--     select p.prosecdef, p.proconfig, p.proacl,
--            pg_get_functiondef(p.oid) like '%app_metadata%' as reads_app_metadata,
--            pg_get_functiondef(p.oid) like '%pioneers%'     as checks_pioneers
--       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--      where n.nspname = 'public' and p.proname = 'listing_counterpart_contact'
--        and p.prokind = 'f';
--
-- (f) The behavioural check, which no query can answer: sign in on this
--     network in Pi Browser and confirm you can still see your own listings in
--     My Activity, post a new one, and read a counterparty's number on a
--     matched listing. If My Activity is empty for an account that has
--     listings, that account has no app_metadata.pi_uid: run the backfill, or
--     sign out and in again.
--
-- ROLLBACK. Restoring the previous policies means restoring a set that reads a
-- claim the user can write, so treat it as incident response. If the app is
-- broken because accounts lack app_metadata, the fix is the backfill script,
-- not a rollback: put the identity where it belongs rather than going back to
-- trusting a field the caller controls.
--
-- ===========================================================================
