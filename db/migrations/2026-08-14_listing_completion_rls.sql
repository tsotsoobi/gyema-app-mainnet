-- ===========================================================================
-- 2026-08-14  Listing completion: server-derived party, and the F17/F18 fix
-- ===========================================================================
--
-- HOW THIS FILE IS USED
--
-- Applied MANUALLY, per project, through the Supabase SQL editor. Testnet
-- first (mshuowwtxoyblgffjkyz); Mainnet at mirror time (ctjupacsnzyubnykmmev).
-- There is no automated runner in this repo, no migration table, and nothing
-- reads this directory at build or deploy time. This file is the durable
-- record of what was run and why, so that the schema and the policies the
-- routes assume can be reconstructed and reviewed from the repo rather than
-- from memory or from a dashboard's history.
--
-- Every statement is safe to re-run: the function is CREATE OR REPLACE, the
-- policy is dropped by name before it is created, the grant block recomputes
-- itself from the live column list, and the grants and revokes are idempotent.
--
-- APPLY IT IN TWO PASSES. This is not a style preference, it is a deployment
-- ordering constraint, and running it straight through before the app change
-- ships takes completion offline for every Pioneer:
--
--   PASS A  sections 2 and 3.  Purely additive. Creates the function and
--           locks its grants. Nothing calls it yet, nothing changes behaviour.
--           Safe to run at any time, including right now.
--
--   PASS B  sections 4 and 5.  Restrictive. Section 4 removes the
--           authenticated role's ability to write the attestation columns
--           directly, so it must not run until app/api/listings/
--           confirm-completion/route.ts is DEPLOYED. Run it early and the
--           existing client's confirmCompletionAsync starts failing silently:
--           the UPDATE is refused at the grant layer, the sheet shows
--           "Could not confirm completion", and no delivery can be closed.
--
-- Section 5 (the policy replacement) has no dependency on the route and can
-- be pulled forward into pass A if F18 needs closing before the route ships.
-- It is grouped with pass B only because both are restrictive changes and
-- want the same round of manual testing.
--
-- Section 1 and section 6 are read-only. Section 1 is a pre-flight: run it
-- and read the output BEFORE running anything else. Section 6 is the
-- verification and the manual test checklist. Neither changes anything.
--
--
-- WHAT THIS FIXES
--
-- F17. lib/listings-async.ts confirmCompletionAsync took `role` as a client
-- argument and wrote the role-named boolean through the authed client. The
-- listings UPDATE policy is row-level: its clauses admit the poster and the
-- matched party to the row, and neither clause can distinguish which of the
-- two attestation columns is being written. One party could therefore set
-- both flags and close a delivery alone. The policy cannot fix this — no
-- row-level policy can — so the fix has two halves: the write moves behind a
-- server route that derives the caller from their session token (section 2's
-- function is what that route calls), and the authenticated role loses the
-- grant to write those columns at all (section 4), so the hole is unreachable
-- rather than merely unused by our own client.
--
-- F18. Testnet's UPDATE policy carried a third clause,
-- (status = 'open' AND matched_with_user_id IS NULL), absent on Mainnet.
-- It authorises a write by identity of the ROW rather than identity of the
-- CALLER, so any holder of a session could expire, rewrite or otherwise
-- update any open listing they did not post. Section 5 drops it and leaves
-- both projects with byte-identical policy text.
--
--
-- WHAT IS DELIBERATELY LEFT OPEN
--
-- `status` stays writable by the authenticated role. Three shipped functions
-- depend on it — cancelMatchedListingAsync, markInTransitAsync and
-- cancelOpenListingAsync all write status through the authed client — and
-- revoking it would break all three.
--
-- The consequence, stated plainly rather than left to be discovered: a party
-- to a row can still write status = 'completed' directly, bypassing the
-- route. What they cannot do is produce the attestations that are supposed
-- to accompany it. Such a row is visibly missing sender_confirmed and/or
-- traveller_confirmed, and completed_at is null, because section 4 denies
-- them all three columns. That is a detectable inconsistency, not a forged
-- completion — section 6 carries the query that finds them. A full status
-- lockdown (routing every state transition through definer functions) is a
-- larger change and is deliberately out of scope for this migration.
--
--
-- WHAT DEPENDS ON THIS FILE
--
-- app/api/listings/confirm-completion/route.ts calls
-- public.listing_confirm_completion by name, through the service_role admin
-- client (lib/supabase-admin.ts), passing the listing id and the pi_uid it
-- read from the caller's verified session token. Until section 2 exists the
-- route cannot stamp anything. Its contract is described at section 2.
--
--
-- WHAT THIS MUST NOT BREAK
--
-- Every remaining write to public.listings through the authed (non-admin)
-- client, all of which were surveyed before this file was written:
--
--   createTripAsync / createPackageAsync   INSERT. Governed by the separate
--     policy "Authenticated users create their own listings", whose WITH
--     CHECK binds posted_by_id to the jwt pi_uid. This file must not touch
--     that policy, and must not disable or re-enable RLS on the table.
--     INSERT privilege is distinct from UPDATE privilege, so section 4 does
--     not affect creation.
--
--   cancelOpenListingAsync   UPDATE status='expired', guarded to status
--     'open'. THIS IS THE HIGHEST-RISK WRITE IN THE FILE. It is the only
--     authed write that touches an open row, so on Testnet it may currently
--     be authorised by the clause section 5 removes rather than by the
--     poster clause. Both clauses read
--     ((auth.jwt() -> 'user_metadata') ->> 'pi_uid'), which matches the
--     shape the app issues (app/api/auth/verify writes pi_uid into
--     user_metadata), so the poster clause should carry it — but "should"
--     is not "does". Test 1 in section 6 exists solely to prove it, and it
--     must pass on Testnet before this file is run on Mainnet.
--
--   cancelMatchedListingAsync   UPDATE status='expired', guarded to
--     'matched'/'in_transit'. Rides the poster or matched clause; the
--     status guard puts it out of reach of the dropped clause. Unaffected.
--
--   markInTransitAsync   UPDATE status='in_transit', guarded to 'matched'.
--     Same. Unaffected.
--
--   archiveListingAsync   UPDATE archived_at or archived_by_matched_at,
--     guarded to 'expired'/'completed'. Same. Section 4 leaves both archive
--     columns writable.
--
-- The service_role paths (app/api/listings/accept, app/api/listings/release,
-- app/api/cron/expire-stale-listings) bypass RLS entirely and hold their own
-- grants. Section 4 revokes from `authenticated` specifically and never from
-- PUBLIC — a revoke from PUBLIC would take the cron and the routes down with
-- it, and would also disarm the definer function in section 2.
--
-- The SELECT policy (currently `true`) and the DELETE policy are untouched.
--
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. Pre-flight (read-only, changes nothing)
--
-- Run this section first, on the project you are about to change, and read
-- the output. It captures the state this file assumes. If any of it differs
-- from what is recorded below, STOP and reconcile before continuing.
--
-- Captured by hand from both projects on 14 Aug 2026, and what section 5
-- assumes:
--
--   Policy name, both projects:
--     "Posters and matched parties can update their listings"
--
--   Role list, both projects: {authenticated}. Verified 14 Aug 2026.
--
--   UPDATE USING, Testnet — three OR'd clauses:
--     posted_by_id        = ((auth.jwt() -> 'user_metadata') ->> 'pi_uid')
--     matched_with_user_id = ((auth.jwt() -> 'user_metadata') ->> 'pi_uid')
--     (status = 'open' AND matched_with_user_id IS NULL)
--
--   UPDATE USING, Mainnet — the first two clauses only.
--   UPDATE WITH CHECK, both — the first two clauses, same JWT shape.
--
-- (a) The full policy set on listings, including the role list each policy
--     targets. The UPDATE policy's `roles` column must read {authenticated}
--     exactly, on both projects. That is the verified state this file was
--     written against, and it is what section 5 recreates. Anything else —
--     {public}, an extra role, a missing one — means the policy has been
--     changed since 14 Aug 2026 by something outside this repo. STOP and
--     reconcile; do not run section 5 over an unexplained role list.
--
--   select polname,
--          polcmd,
--          polroles::regrole[]                as roles,
--          pg_get_expr(polqual, polrelid)     as using_expr,
--          pg_get_expr(polwithcheck, polrelid) as check_expr
--     from pg_policy
--    where polrelid = 'public.listings'::regclass
--    order by polcmd, polname;
--
-- (b) The column list section 4 will operate on. Section 4 recomputes this
--     itself at run time, so this is for your eyes, not for the statement.
--
--   select ordinal_position, column_name, data_type, is_generated
--     from information_schema.columns
--    where table_schema = 'public' and table_name = 'listings'
--    order by ordinal_position;
--
-- (c) Who currently holds UPDATE on the table, and at what granularity.
--     Expect a table-wide grant to anon, authenticated and service_role —
--     the Supabase default. Section 4's shape depends on this being
--     table-wide; see the warning there.
--
--   select grantee, privilege_type
--     from information_schema.table_privileges
--    where table_schema = 'public' and table_name = 'listings'
--      and privilege_type = 'UPDATE'
--    order by grantee;
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- 2. Stamp one party's completion attestation, and close the delivery once
--    both are in                                              [PASS A]
--
-- CONTRACT, for the route that calls this:
--
--   select * from public.listing_confirm_completion(p_listing_id, p_pi_uid);
--
--   Returns the listing row in two cases: a successful stamp, and a repeat
--   call by a party who has already stamped (see IDEMPOTENCY in the body).
--   The route cannot tell those apart and does not need to — both mean "this
--   party's attestation is on the record", which is exactly what the sheet
--   renders.
--
--   Returns NO ROW when nothing was stamped. No row is not an error and
--   carries no detail: it covers "no such listing", "caller is neither
--   party", "the listing was never matched or is expired", and "the listing
--   is completed without this party's attestation" identically,
--   deliberately, so the function never tells a caller anything about a row
--   they have no part in. If the route wants to distinguish those cases for
--   its own error copy, it may follow up with a READ through the admin
--   client — never a second write.
--
-- THERE IS NO ROLE OR PARTY PARAMETER, HERE OR ANYWHERE ABOVE IT. The caller
-- supplies a listing id and the pi_uid the route read from their verified
-- session token, and nothing else. Which of the two attestation columns gets
-- written is derived here, from the row:
--
--   kind = 'package'   a Sender posted asking for delivery, so the poster is
--                      the SENDER and the matched party is the TRAVELLER.
--   kind = 'trip'      a Traveller posted offering capacity, so the poster is
--                      the TRAVELLER and the matched party is the SENDER.
--
-- That is the same rule as determineViewerRole in
-- components/listing-detail-sheet.tsx, which stays as it is — it drives which
-- button the sheet shows. It is no longer authoritative for anything. If
-- these two ever disagree, THIS one is right and the sheet is cosmetic.
--
-- An inversion of that mapping records the wrong party's attestation, with no
-- error surfacing anywhere: the write succeeds and the row looks plausible.
-- It is the failure this whole change exists to prevent. Read it twice.
--
-- WHY THE COMPLETION TRANSITION IS COMPUTED INSIDE THE UPDATE STATEMENT.
-- The code being replaced read sender_confirmed/traveller_confirmed on one
-- line and wrote on another. Two concurrent confirmations both read (false,
-- false), both conclude the other side has not confirmed, and both write only
-- their own flag — so the row ends up (true, true) with status still
-- 'matched' and completed_at null, stranded, with no sweeper to heal it (the
-- cron only touches status='open'). That is the same class of bug the guest
-- rail hit, and the reason guest_stamp_delivery exists.
--
-- The flags themselves are never lost here, because after this change each
-- party writes a DIFFERENT column. What is lost is the transition. So unlike
-- guest_stamp_delivery this function needs no SELECT ... FOR UPDATE: the
-- whole decision is expressed as CASE expressions inside a single UPDATE. In
-- READ COMMITTED, a statement that blocks on a concurrently-updated row
-- re-evaluates both its WHERE clause and its SET expressions against the new
-- row version once the lock is released, so the second confirmation of a pair
-- sees the first one's committed flag and flips the row to completed.
--
-- The SELECT below is therefore NOT a read-modify-write. It reads only
-- posted_by_id, matched_with_user_id and kind — facts that decide which
-- branch to take — and never the flags the branch writes. The identity fact
-- it relies on is re-asserted in the UPDATE's WHERE clause, so a concurrent
-- release (app/api/listings/release, which clears matched_with_user_id) can
-- never let a stale read authorise a stamp.
--
-- completed_at is coalesced, never overwritten: it keeps meaning "when this
-- delivery was first closed".
--
-- Idempotent, and idempotent the visible way. A party who has already
-- stamped gets the current row back without a write, whether the delivery is
-- still matched or has since completed. That case is answered explicitly in
-- the body rather than being allowed to fall through the status guard, which
-- would return no row and be indistinguishable from a refusal.
-- ---------------------------------------------------------------------------
create or replace function public.listing_confirm_completion(
  p_listing_id text,
  p_pi_uid     text
)
returns setof public.listings
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_listing  public.listings%rowtype;
  v_is_poster boolean;
  v_is_sender boolean;
begin
  if p_listing_id is null or p_pi_uid is null or p_pi_uid = '' then
    return;
  end if;

  select * into v_listing
    from listings
   where id = p_listing_id;

  if not found then return; end if;

  -- Never matched, or dead. There is no attestation to record and no state
  -- worth reporting. Same guard the replaced TypeScript carried.
  if v_listing.status in ('open', 'expired') then return; end if;

  -- Which party is calling. Poster is checked first; the two can never be
  -- the same Pioneer (the accept route refuses a self-accept with
  -- .neq("posted_by_id", uid)), so the order is a formality, not a tiebreak.
  if v_listing.posted_by_id = p_pi_uid then
    v_is_poster := true;
  elsif v_listing.matched_with_user_id = p_pi_uid then
    v_is_poster := false;
  else
    -- Caller is a party to nothing here. Say nothing about the row.
    return;
  end if;

  -- Which attestation that party owns. See the mapping note above.
  if v_listing.kind = 'package' then
    v_is_sender := v_is_poster;
  else
    v_is_sender := not v_is_poster;
  end if;

  -- IDEMPOTENCY. This party has already stamped. Hand back the row as it
  -- stands and write nothing.
  --
  -- It covers two arrivals that are otherwise indistinguishable from a
  -- refusal, because both would fall through to the status guard below and
  -- return no row — the same empty answer the function gives a stranger:
  --
  --   retry while still matched      a double tap, a resubmitted request,
  --                                  a client that lost the response
  --   retry after completion         the counterparty confirmed in between,
  --                                  so the row is now 'completed'
  --
  -- Neither is an error and neither should read as one. The replaced
  -- TypeScript handled the second case by re-selecting the row (the
  -- status = 'completed' branch it carried); this restores that, and covers
  -- the first case too, which that code did not.
  --
  -- THIS IS WHY THE STATUS GUARD IS SPLIT. The 'open'/'expired' half runs
  -- early, above, because those rows have no parties to derive. The
  -- 'completed' half must run AFTER the derivation, below, or a completed
  -- row would never reach this branch and the retry-after-completion case
  -- could not be answered.
  --
  -- The row is re-read rather than returned from v_listing so the caller
  -- gets committed current state, not the snapshot taken at the top of this
  -- function.
  if (v_is_sender and v_listing.sender_confirmed)
     or ((not v_is_sender) and v_listing.traveller_confirmed) then
    return query select * from listings where id = p_listing_id;
    return;
  end if;

  -- Only a live delivery can be stamped. By this line the row is 'matched',
  -- 'in_transit' or 'completed', and the caller has NOT stamped it, so this
  -- rejects exactly one thing: a completed row missing this party's
  -- attestation. That is the shape a status written around the route leaves
  -- behind (see "WHAT IS DELIBERATELY LEFT OPEN" in the header). Refusing it
  -- is deliberate — the fix for such a row is to look at it, not to
  -- back-fill an attestation onto a delivery already marked closed.
  if v_listing.status not in ('matched', 'in_transit') then return; end if;

  if v_is_sender then
    return query
    update listings
       set sender_confirmed = true,
           status = case when traveller_confirmed
                         then 'completed' else status end,
           completed_at = case when traveller_confirmed
                               then coalesce(completed_at, now())
                               else completed_at end
     where id = p_listing_id
       and status in ('matched', 'in_transit')
       and ((v_is_poster and posted_by_id = p_pi_uid)
            or ((not v_is_poster) and matched_with_user_id = p_pi_uid))
    returning *;
  else
    return query
    update listings
       set traveller_confirmed = true,
           status = case when sender_confirmed
                         then 'completed' else status end,
           completed_at = case when sender_confirmed
                               then coalesce(completed_at, now())
                               else completed_at end
     where id = p_listing_id
       and status in ('matched', 'in_transit')
       and ((v_is_poster and posted_by_id = p_pi_uid)
            or ((not v_is_poster) and matched_with_user_id = p_pi_uid))
    returning *;
  end if;
end;
$$;


-- ---------------------------------------------------------------------------
-- 3. Lock the function to service_role                        [PASS A]
--
-- NOT optional, and not a tidiness measure. Postgres grants EXECUTE on new
-- functions to PUBLIC, and PostgREST exposes public-schema functions to the
-- anon and authenticated roles. Without these revokes, anyone holding the
-- anon key could POST to /rest/v1/rpc/listing_confirm_completion with a
-- listing id and ANY pi_uid — including the counterparty's, which is not a
-- secret; it is on the row — and stamp that party's attestation for them.
-- The function is security definer, so it would run with the owner's rights
-- while doing it, and it would sail past both the policy and section 4's
-- column grants. The identity check in section 2 is only as good as this
-- revoke: the function trusts p_pi_uid completely, because the ONLY caller
-- that can reach it is a server route that read that uid from a verified
-- session token.
--
-- Same reasoning, same shape, as section 4 of 2026-08-13_delivery_code.sql.
-- ---------------------------------------------------------------------------
revoke all on function public.listing_confirm_completion(text, text)
  from public, anon, authenticated;

grant execute on function public.listing_confirm_completion(text, text)
  to service_role;


-- ---------------------------------------------------------------------------
-- 4. Take the attestation columns away from the authenticated role
--                                                             [PASS B]
--
-- DO NOT RUN THIS UNTIL app/api/listings/confirm-completion/route.ts IS
-- DEPLOYED. See the two-pass note in the header.
--
-- This is the half of the F17 fix that holds even against a client we did not
-- write. Moving the write into a route stops OUR client from setting the
-- other party's flag; this stops anyone from doing it with a REST call and an
-- anon key plus a session.
--
-- WHY THIS IS NOT A BARE `revoke update (cols) ... from authenticated`.
-- That is what you would expect to write, and against the Supabase default it
-- does nothing at all. Privileges are additive, and a column-level revoke
-- cannot subtract from a table-wide grant: with UPDATE held on the whole
-- table, Postgres reports "no privileges could be revoked for column ..." as
-- a WARNING, not an error, and the columns stay writable. The migration would
-- appear to succeed and F17 would be untouched. The only mechanism that works
-- is to drop the table-wide grant and re-grant every column that is meant to
-- stay writable.
--
-- The block recomputes that list from information_schema at run time rather
-- than hard-coding it, so it cannot silently miss a column that exists on one
-- project and not the other, and so re-running it after a future column is
-- added does the right thing without an edit. Generated columns are excluded
-- because they cannot be updated at all.
--
-- WHAT IT DENIES, exactly and only:
--   sender_confirmed, traveller_confirmed, completed_at
-- Every other column stays exactly as writable by authenticated as it is
-- today, `status` very much included — see "WHAT IS DELIBERATELY LEFT OPEN"
-- in the header for the honest account of what that leaves possible.
--
-- WHO IS UNAFFECTED: service_role (the accept, release and cron routes) and
-- the owner of the function in section 2. The revoke names `authenticated`
-- and nothing else. Revoking from PUBLIC here would break all of them.
--
-- `anon` is left alone on purpose. Once section 5 lands, both surviving
-- policy clauses require ((auth.jwt() -> 'user_metadata') ->> 'pi_uid'),
-- which an anon request never carries, so anon's table grant is inert
-- whatever it says. That is a second, quieter reason the clause section 5
-- drops had to go: it was the one clause an anon request could satisfy.
--
-- Re-runnable: the revoke is idempotent and the grant is recomputed each
-- time.
-- ---------------------------------------------------------------------------
do $$
declare
  v_cols text;
begin
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position)
    into v_cols
    from information_schema.columns
   where table_schema = 'public'
     and table_name   = 'listings'
     and is_generated = 'NEVER'
     and column_name not in (
           'sender_confirmed',
           'traveller_confirmed',
           'completed_at'
         );

  if v_cols is null then
    raise exception
      'listings: no updatable columns resolved — refusing to revoke';
  end if;

  execute 'revoke update on public.listings from authenticated';
  execute format(
    'grant update (%s) on public.listings to authenticated', v_cols);
end
$$;


-- ---------------------------------------------------------------------------
-- 5. Replace the UPDATE policy — drop the open-row clause, converge the two
--    projects                                                 [PASS B]
--
-- Drop-and-create rather than a conditional or an ALTER. The clause being
-- removed exists on Testnet and not on Mainnet, so dropping it is a no-op
-- there; running this identical block on both projects leaves them with
-- byte-identical policy text, which is the point of doing it this way. There
-- is no branch to get wrong at mirror time.
--
-- WHAT GOES: (status = 'open' AND matched_with_user_id IS NULL).
-- It authorises by the state of the ROW rather than the identity of the
-- CALLER. Any Pioneer with a session could update any open listing they did
-- not post — expire it out of the marketplace, rewrite its price, its route,
-- its contact number. That is F18. Nothing in the app needs it: the only
-- authed write that touches an open row is cancelOpenListingAsync, and that
-- is the poster's own action, carried by the poster clause.
--
-- WHAT STAYS: the poster clause and the matched-party clause, verbatim, in
-- both USING and WITH CHECK, with the same JWT extraction the app issues.
--
-- ON `to authenticated`. This preserves the live role list rather than
-- changing it: both projects were verified on 14 Aug 2026 to target
-- {authenticated} on this policy, and pre-flight (a) re-checks it at run
-- time. It is stated explicitly here so the recreated policy cannot silently
-- widen to PUBLIC, which is what omitting the clause would do.
--
-- Re-runnable: drop if exists, then create.
-- ---------------------------------------------------------------------------
drop policy if exists
  "Posters and matched parties can update their listings"
  on public.listings;

create policy "Posters and matched parties can update their listings"
  on public.listings
  for update
  to authenticated
  using (
    posted_by_id = ((auth.jwt() -> 'user_metadata'::text) ->> 'pi_uid'::text)
    or matched_with_user_id = ((auth.jwt() -> 'user_metadata'::text) ->> 'pi_uid'::text)
  )
  with check (
    posted_by_id = ((auth.jwt() -> 'user_metadata'::text) ->> 'pi_uid'::text)
    or matched_with_user_id = ((auth.jwt() -> 'user_metadata'::text) ->> 'pi_uid'::text)
  );


-- ---------------------------------------------------------------------------
-- 6. Verification and manual tests (read-only, changes nothing)
--
-- Run the queries. Then run the tests. The tests are not optional: test 1 in
-- particular is the only thing standing between this migration and a poster
-- who can no longer cancel their own open listing, and it must pass on
-- Testnet before this file is run on Mainnet.
--
-- (a) The policy set. Expect exactly one UPDATE policy, named as above,
--     with TWO clauses in each of using_expr and check_expr, and no
--     'open'/'IS NULL' clause anywhere. Diff the two projects' output — the
--     UPDATE rows should now be identical.
--
--   select polname,
--          polcmd,
--          polroles::regrole[]                 as roles,
--          pg_get_expr(polqual, polrelid)      as using_expr,
--          pg_get_expr(polwithcheck, polrelid) as check_expr
--     from pg_policy
--    where polrelid = 'public.listings'::regclass
--    order by polcmd, polname;
--
-- (b) The function's ACL. Expect service_role and nothing else — no anon,
--     no authenticated, no PUBLIC (which shows as an entry with an empty
--     grantee).
--
--   select p.proname, p.prosecdef, p.proconfig, p.proacl
--     from pg_proc p
--     join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public'
--      and p.proname = 'listing_confirm_completion';
--
-- (c) The column grants. The first query must return NO ROWS: authenticated
--     must hold UPDATE on none of the three. The second is the positive
--     control — it must return a healthy list including status,
--     archived_at and archived_by_matched_at, or section 4 over-revoked and
--     cancel/archive/in-transit are now broken.
--
--   select grantee, column_name, privilege_type
--     from information_schema.column_privileges
--    where table_schema = 'public' and table_name = 'listings'
--      and grantee = 'authenticated' and privilege_type = 'UPDATE'
--      and column_name in
--          ('sender_confirmed', 'traveller_confirmed', 'completed_at');
--
--   select column_name
--     from information_schema.column_privileges
--    where table_schema = 'public' and table_name = 'listings'
--      and grantee = 'authenticated' and privilege_type = 'UPDATE'
--    order by column_name;
--
-- (d) The detector for the gap left open in the header: completions that
--     arrived without their attestations. Expect zero rows. Any row here is
--     a status written around the route — worth reading, not necessarily
--     malicious (a legacy row predating the flags would also show up).
--     Run it once now to establish the baseline, and again after a while.
--
--   select id, tracking_id, status, sender_confirmed, traveller_confirmed,
--          completed_at, matched_at
--     from public.listings
--    where status = 'completed'
--      and (sender_confirmed is not true
--           or traveller_confirmed is not true
--           or completed_at is null)
--    order by matched_at desc nulls last;
--
-- (e) Triggers on listings. The delivery-code migration found that something
--     outside the repo moves guest_jobs statuses; check whether the same is
--     true here before trusting the both-flags gate in section 2. A trigger
--     that flips status on any change to sender_confirmed would close a
--     delivery on the first attestation and defeat the whole design, without
--     any error surfacing.
--
--   select tgname, pg_get_triggerdef(oid)
--     from pg_trigger
--    where tgrelid = 'public.listings'::regclass
--      and not tgisinternal;
--
--
-- MANUAL TESTS — run as a real signed-in Pioneer in the app, on Testnet.
--
--   1. POSTER CANCELS AN OPEN LISTING.  Post a listing, then cancel it from
--      the sheet. It must move to Past. If it silently fails, the poster
--      clause is not carrying what the dropped clause was carrying, and
--      section 5 must be reverted on this project before going further.
--      This is the highest-risk consequence of the whole file.
--
--   2. F18 IS CLOSED.  As a Pioneer who did NOT post it, attempt a direct
--      PATCH to /rest/v1/listings?id=eq.<someone else's open listing> with
--      a session token. Expect 0 rows affected. Before this migration, on
--      Testnet, this succeeded.
--
--   3. F17 IS CLOSED AT THE DATABASE.  As a party to a matched listing,
--      attempt a direct PATCH setting sender_confirmed. Expect 42501,
--      permission denied for column. Repeat for traveller_confirmed and
--      completed_at.
--
--   4. COMPLETION STILL WORKS, ALL FOUR COMBINATIONS.  This is the test that
--      catches an inversion of the kind -> role mapping in section 2, and it
--      is the reason the mapping is worth reading twice. Four fresh listings,
--      two kinds crossed with two confirmation orders. After the FIRST
--      confirmation of each pair, exactly the named flag is true, the other
--      is false, status is still 'matched' and completed_at is null. After
--      the SECOND, both are true, status is 'completed', and completed_at is
--      stamped exactly once.
--
--        kind      confirms 1st   flag set 1st          flag set 2nd
--        --------  -------------  --------------------  --------------------
--        package   poster         sender_confirmed      traveller_confirmed
--        package   matched party  traveller_confirmed   sender_confirmed
--        trip      poster         traveller_confirmed   sender_confirmed
--        trip      matched party  sender_confirmed      traveller_confirmed
--
--      Rows 3 and 4 are the ones that matter. On a 'trip' the POSTER is the
--      traveller, so a poster confirming must set traveller_confirmed. If it
--      sets sender_confirmed instead, the mapping is inverted: the delivery
--      still reaches 'completed' after both parties act, and nothing errors,
--      but every attestation on every trip listing is filed against the wrong
--      Pioneer. Check the column, not just the status.
--
--      Verify each step against the row itself, not the sheet:
--
--        select kind, status, sender_confirmed, traveller_confirmed,
--               completed_at, posted_by_id, matched_with_user_id
--          from public.listings where tracking_id = '<GYM-...>';
--
--   5. THE REST OF THE WRITE SURFACE.  Traveller marks in transit. Either
--      party cancels a matched listing. Both sides archive a terminal
--      listing and each disappears only from their own My Activity. Post a
--      trip and post a package. All unchanged.
-- ---------------------------------------------------------------------------
