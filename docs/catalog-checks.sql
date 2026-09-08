-- ===========================================================================
-- Gyema catalog checks: one statement, one jsonb document, one Run per network
-- ===========================================================================
--
-- READ ONLY. This is a single SELECT against catalog views. It creates,
-- alters, drops, grants and revokes nothing, and it reads no row of user data:
-- no listing, no guest job, no phone number, no delivery code, no name. The
-- only user-data-adjacent number in the output is the planner's row estimate
-- per table, which needs no scan.
--
-- HOW TO RUN IT
--
-- Select the whole file and Run, once per project. The Supabase SQL editor
-- returns only the last statement's result, which is why everything is one
-- statement returning one column of pretty-printed jsonb. Copy that one cell.
--
-- Confirm the project breadcrumb in the dashboard before running, per
-- CLAUDE.md. Then paste the result back labelled TESTNET or MAINNET. The
-- document carries current_database() and a timestamp so a mislabelled paste
-- is still identifiable.
--
-- Nothing in the output is a secret. Policy bodies and function ACLs are code
-- and privilege metadata, not data.
--
-- WHAT IT IS FOR
--
-- docs/security-inventory.md could not answer the database half of Phase 0.
-- The migrations in db/migrations say what was intended; the catalog says what
-- is deployed, and the two projects are known to disagree already. CLAUDE.md
-- invariant 8 makes the same point: verify DDL from catalog state, never from a
-- Success banner.
--
-- The document has an "expected" key at the top level holding the expectation
-- for every check, so a result that differs is visible without going back to
-- this file.
--
-- THE THREE UNREFERENCED TABLES
--
-- check 1 on the first network showed a2u_payments, couriers and
-- legacy_couriers. Nothing in this repository references any of them: no
-- route, no lib, no migration in db/migrations. They are now named explicitly
-- in every per-table check, and check 13 exists only for them, because an
-- unreferenced table is the case where nobody notices RLS is off. couriers and
-- legacy_couriers sound like they hold people; a2u_payments matches the
-- unmerged remote branch feat/a2u-payout, so it may be a table that was
-- created for work that never shipped.
--
-- ===========================================================================

with
-- CHECK 1. Row level security, per table, every table in public.
check_01_rls as (
  select coalesce(jsonb_agg(x order by x->>'table_name'), '[]'::jsonb) as v
  from (
    select jsonb_build_object(
      'table_name', c.relname,
      'referenced_by_repo', (c.relname in ('listings', 'guest_jobs', 'pioneers', 'auth_events')),
      'rls_enabled', c.relrowsecurity,
      'rls_forced', c.relforcerowsecurity,
      'policy_count', (select count(*) from pg_policies p
                        where p.schemaname = 'public' and p.tablename = c.relname)
    ) as x
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
  ) s
),

-- CHECK 2. Every policy body. listings SELECT and DELETE sort first.
check_02_policies as (
  select coalesce(jsonb_agg(x order by ord, tbl, cmd_, pol), '[]'::jsonb) as v
  from (
    select
      case when tablename = 'listings' and cmd = 'SELECT' then 0
           when tablename = 'listings' and cmd = 'DELETE' then 1
           when tablename = 'listings' then 2
           when tablename in ('a2u_payments', 'couriers', 'legacy_couriers') then 3
           else 4 end as ord,
      tablename as tbl, cmd as cmd_, policyname as pol,
      jsonb_build_object(
        'table_name', tablename,
        'policy_name', policyname,
        'cmd', cmd,
        'permissive', permissive,
        'roles', to_jsonb(roles),
        'using_expression', qual,
        'with_check_expression', with_check
      ) as x
    from pg_policies
    where schemaname = 'public'
  ) s
),

-- CHECK 3. Table wide grants to the roles that matter.
check_03_table_grants as (
  select coalesce(jsonb_agg(x order by x->>'grantee', x->>'table_name'), '[]'::jsonb) as v
  from (
    select jsonb_build_object(
      'grantee', grantee,
      'table_name', table_name,
      'privileges', to_jsonb(array_agg(distinct privilege_type order by privilege_type))
    ) as x
    from information_schema.role_table_grants
    where table_schema = 'public'
      and grantee in ('anon', 'authenticated', 'service_role', 'gyema_reader', 'PUBLIC')
    group by grantee, table_name
  ) s
),

-- CHECK 4. Column level grants, collapsed to one row per grantee, table and
-- privilege with the column list. This is where S-1 lives.
check_04_column_grants as (
  select coalesce(jsonb_agg(x order by x->>'grantee', x->>'table_name', x->>'privilege'), '[]'::jsonb) as v
  from (
    select jsonb_build_object(
      'grantee', grantee,
      'table_name', table_name,
      'privilege', privilege_type,
      'column_count', count(*),
      'columns', to_jsonb(array_agg(column_name order by column_name))
    ) as x
    from information_schema.column_privileges
    where table_schema = 'public'
      and grantee in ('anon', 'authenticated', 'gyema_reader')
    group by grantee, table_name, privilege_type
  ) s
),

-- CHECK 3b and 4b. The same two grant questions read from pg_class.relacl and
-- pg_attribute.attacl instead of information_schema.
--
-- information_schema.role_table_grants and column_privileges only show
-- privileges granted to roles the current user belongs to. In Supabase the
-- SQL editor runs as postgres, which is a member of anon, authenticated and
-- service_role, so checks 3 and 4 should be complete. Should is not a word to
-- rest a privilege audit on: these two read the ACLs straight from the catalog,
-- where no role membership filtering applies. If 3 and 3b disagree, believe 3b.
check_03b_table_grants_catalog as (
  select coalesce(jsonb_agg(x order by x->>'grantee', x->>'table_name'), '[]'::jsonb) as v
  from (
    select jsonb_build_object(
      'grantee', grantee,
      'table_name', table_name,
      'privileges', to_jsonb(array_agg(distinct privilege_type order by privilege_type))
    ) as x
    from (
      select
        case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as grantee,
        c.relname as table_name,
        a.privilege_type
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
      where n.nspname = 'public' and c.relkind in ('r', 'v')
    ) g
    where grantee in ('anon', 'authenticated', 'service_role', 'gyema_reader', 'PUBLIC')
    group by grantee, table_name
  ) s
),

check_04b_column_grants_catalog as (
  select coalesce(jsonb_agg(x order by x->>'grantee', x->>'table_name', x->>'privilege'), '[]'::jsonb) as v
  from (
    select jsonb_build_object(
      'grantee', grantee,
      'table_name', table_name,
      'privilege', privilege_type,
      'column_count', count(*),
      'columns', to_jsonb(array_agg(column_name order by column_name))
    ) as x
    from (
      select
        case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as grantee,
        c.relname as table_name,
        att.attname as column_name,
        a.privilege_type
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute att on att.attrelid = c.oid and att.attnum > 0 and not att.attisdropped
      cross join lateral aclexplode(att.attacl) a
      where n.nspname = 'public' and c.relkind in ('r', 'v') and att.attacl is not null
    ) g
    where grantee in ('anon', 'authenticated', 'service_role', 'gyema_reader', 'PUBLIC')
    group by grantee, table_name, privilege_type
  ) s
),

-- CHECK 5. Does anything pin posted_by_id to the session on insert. S-15.
check_05_listings_insert_policy as (
  select coalesce(jsonb_agg(x), '[]'::jsonb) as v
  from (
    select jsonb_build_object(
      'policy_name', policyname,
      'roles', to_jsonb(roles),
      'with_check_expression', with_check,
      'mentions_posted_by_id', coalesce(with_check ilike '%posted_by_id%', false),
      'mentions_auth_uid', coalesce(with_check ilike '%auth.uid%' or with_check ilike '%auth.jwt%', false)
    ) as x
    from pg_policies
    where schemaname = 'public' and tablename = 'listings' and cmd = 'INSERT'
  ) s
),

-- CHECK 6. Every function in public, with security definer, volatility,
-- search_path and owner.
check_06_functions as (
  select coalesce(jsonb_agg(x order by secdef desc, nm), '[]'::jsonb) as v
  from (
    select p.prosecdef as secdef, p.proname as nm,
      jsonb_build_object(
        'function_name', p.proname,
        'arguments', pg_get_function_identity_arguments(p.oid),
        'security_definer', p.prosecdef,
        'volatility', case p.provolatile when 'i' then 'immutable'
                                          when 's' then 'stable'
                                          else 'volatile' end,
        'settings', to_jsonb(p.proconfig),
        'search_path_pinned', (p.proconfig is not null
                               and array_to_string(p.proconfig, ',') like '%search_path%'),
        'owner', pg_get_userbyid(p.proowner)
      ) as x
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
  ) s
),

-- CHECK 7. EXECUTE grants on the four functions the migrations create.
check_07_function_acls as (
  select coalesce(jsonb_agg(x order by x->>'function_name'), '[]'::jsonb) as v
  from (
    select jsonb_build_object(
      'function_name', p.proname,
      'arguments', pg_get_function_identity_arguments(p.oid),
      'security_definer', p.prosecdef,
      'acl', case when p.proacl is null
                  then to_jsonb('(null: EXECUTE to PUBLIC)'::text)
                  else to_jsonb(p.proacl::text[]) end,
      'anon_or_authenticated_can_execute',
        coalesce(array_to_string(p.proacl, ',') like '%anon=X%'
              or array_to_string(p.proacl, ',') like '%authenticated=X%'
              or p.proacl is null, false)
    ) as x
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'guest_bump_delivery_code_attempts',
        'guest_bump_last4_attempts',
        'guest_stamp_delivery',
        'listing_confirm_completion',
        'listing_counterpart_contact',
        'mask_phone_head_only'
      )
  ) s
),

-- CHECK 8. Is anything at the database layer bounding the last-4 guard. S-2.
check_08_guard_columns as (
  select coalesce(jsonb_agg(x order by x->>'column_name'), '[]'::jsonb) as v
  from (
    select jsonb_build_object(
      'column_name', column_name,
      'data_type', data_type,
      'column_default', column_default,
      'is_nullable', is_nullable
    ) as x
    from information_schema.columns
    where table_schema = 'public' and table_name = 'guest_jobs'
      and (column_name like '%attempt%'
        or column_name like '%lock%'
        or column_name like '%guard%'
        or column_name in ('phone_verified', 'verified_at', 'delivery_code_hash'))
  ) s
),

-- CHECK 9. Did each migration file's objects land.
check_09_migration_objects as (
  select coalesce(jsonb_agg(x order by x->>'migration', x->>'object'), '[]'::jsonb) as v
  from (
    select jsonb_build_object('migration', m, 'object', o, 'present', present) as x
    from (
      values
        ('2026-08-13', 'column guest_jobs.delivery_code_hash',
          exists (select 1 from information_schema.columns
                   where table_schema='public' and table_name='guest_jobs'
                     and column_name='delivery_code_hash')),
        ('2026-08-13', 'column guest_jobs.delivery_code_attempts',
          exists (select 1 from information_schema.columns
                   where table_schema='public' and table_name='guest_jobs'
                     and column_name='delivery_code_attempts')),
        ('2026-08-13', 'function guest_bump_delivery_code_attempts',
          exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                   where n.nspname='public' and p.proname='guest_bump_delivery_code_attempts')),
        ('2026-08-13', 'function guest_stamp_delivery',
          exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                   where n.nspname='public' and p.proname='guest_stamp_delivery')),
        ('2026-08-14', 'function listing_confirm_completion',
          exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                   where n.nspname='public' and p.proname='listing_confirm_completion')),
        ('2026-08-14', 'listings UPDATE policy for the two parties (renamed listings_update_parties by the identity migration)',
          exists (select 1 from pg_policies
                   where schemaname='public' and tablename='listings'
                     and (policyname = 'listings_update_parties'
                       or policyname ilike '%matched parties%'))),
        ('2026-08-18', 'role gyema_reader',
          exists (select 1 from pg_roles where rolname='gyema_reader')),
        ('2026-08-18', 'policy gyema_reader_select on guest_jobs (superseded)',
          exists (select 1 from pg_policies
                   where schemaname='public' and tablename='guest_jobs'
                     and policyname='gyema_reader_select')),
        ('2026-08-18', 'policy gyema_reader_select on listings (superseded)',
          exists (select 1 from pg_policies
                   where schemaname='public' and tablename='listings'
                     and policyname='gyema_reader_select')),
        ('2026-09-07', 'function mask_phone_head_only',
          exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                   where n.nspname='public' and p.proname='mask_phone_head_only')),
        ('2026-09-07', 'view guest_jobs_dispatch',
          exists (select 1 from information_schema.views
                   where table_schema='public' and table_name='guest_jobs_dispatch')),
        ('2026-09-07', 'view listings_dispatch',
          exists (select 1 from information_schema.views
                   where table_schema='public' and table_name='listings_dispatch')),
        ('2026-09-07', 'gyema_reader holds nothing on base table guest_jobs',
          not exists (select 1 from information_schema.role_table_grants
                       where grantee='gyema_reader' and table_name='guest_jobs')),
        ('2026-09-07', 'gyema_reader holds nothing on base table listings',
          not exists (select 1 from information_schema.role_table_grants
                       where grantee='gyema_reader' and table_name='listings')),
        ('2026-09-07', 'neither dispatch view is readable by anon or authenticated',
          not exists (select 1 from information_schema.role_table_grants
                       where table_schema='public'
                         and table_name in ('guest_jobs_dispatch','listings_dispatch')
                         and grantee in ('anon','authenticated','PUBLIC'))),
        ('2026-09-07 identity', 'the four listings policies reading app_metadata',
          (select count(*) = 4 from pg_policies
            where schemaname='public' and tablename='listings'
              and policyname in ('listings_select_public','listings_insert_own',
                                 'listings_update_parties','listings_delete_poster'))),
        ('2026-09-07 identity', 'no policy in public references user_metadata',
          not exists (select 1 from pg_policies
                       where schemaname='public'
                         and (coalesce(qual,'') like '%user_metadata%'
                           or coalesce(with_check,'') like '%user_metadata%'))),
        ('2026-09-07 last4', 'column guest_jobs.last4_attempts',
          exists (select 1 from information_schema.columns
                   where table_schema='public' and table_name='guest_jobs'
                     and column_name='last4_attempts')),
        ('2026-09-07 last4', 'function guest_bump_last4_attempts',
          exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                   where n.nspname='public' and p.proname='guest_bump_last4_attempts')),
        ('2026-09-07 baseline', 'default privileges deny anon and authenticated on new tables',
          not exists (
            select 1 from pg_default_acl d
            join pg_namespace n on n.oid = d.defaclnamespace
            where n.nspname = 'public' and d.defaclobjtype = 'r'
              and array_to_string(d.defaclacl, ',') ~ '(^|,)(anon|authenticated)='))
    ) as t(m, o, present)
  ) s
),

-- CHECK 10. The reader role's session bounds.
check_10_reader_role as (
  select coalesce(jsonb_agg(x), '[]'::jsonb) as v
  from (
    select jsonb_build_object(
      'rolname', rolname,
      'can_login', rolcanlogin,
      'superuser', rolsuper,
      'createdb', rolcreatedb,
      'createrole', rolcreaterole,
      'inherit', rolinherit,
      'settings', to_jsonb(rolconfig)
    ) as x
    from pg_roles where rolname = 'gyema_reader'
  ) s
),

-- CHECK 11. Table and view inventory, for drift between the two networks.
check_11_inventory as (
  select coalesce(jsonb_agg(x order by x->>'kind', x->>'name'), '[]'::jsonb) as v
  from (
    select jsonb_build_object(
      'name', c.relname,
      'kind', case c.relkind when 'r' then 'table' when 'v' then 'view' else c.relkind::text end,
      'approx_rows', c.reltuples::bigint,
      'column_count', (select count(*) from information_schema.columns col
                        where col.table_schema = 'public' and col.table_name = c.relname),
      'referenced_by_repo', (c.relname in (
        'listings', 'guest_jobs', 'pioneers', 'auth_events',
        'guest_jobs_dispatch', 'listings_dispatch'))
    ) as x
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'v')
  ) s
),

-- CHECK 12. Any security definer function in public executable by PUBLIC.
check_12_public_execute as (
  select coalesce(jsonb_agg(x order by x->>'function_name'), '[]'::jsonb) as v
  from (
    select jsonb_build_object(
      'function_name', p.proname,
      'arguments', pg_get_function_identity_arguments(p.oid),
      'owner', pg_get_userbyid(p.proowner),
      'acl', case when p.proacl is null
                  then to_jsonb('(null: EXECUTE to PUBLIC)'::text)
                  else to_jsonb(p.proacl::text[]) end
    ) as x
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prosecdef
      and (p.proacl is null
           or array_to_string(p.proacl, ',') like '%=X/%'
              and array_to_string(p.proacl, ',') not like '%service_role=X%')
  ) s
),

-- CHECK 12b. Default privileges: what a NEWLY created object starts with.
--
-- Section 1 of the grant baseline revokes from the objects that exist when it
-- runs, and says nothing about the next one. This is the rule for the objects
-- created afterwards. The two dispatch views were born with Supabase's
-- defaults on them because a later migration creates them, which is the
-- 7 September finding.
check_12b_default_privileges as (
  select coalesce(jsonb_agg(x order by x->>'creating_role', x->>'object_type'), '[]'::jsonb) as v
  from (
    select jsonb_build_object(
      'creating_role', pg_get_userbyid(d.defaclrole),
      'schema', n.nspname,
      'object_type', case d.defaclobjtype when 'r' then 'tables'
                                          when 'S' then 'sequences'
                                          when 'f' then 'functions'
                                          when 'T' then 'types'
                                          else d.defaclobjtype::text end,
      'default_acl', to_jsonb(d.defaclacl::text[]),
      'grants_anon_or_authenticated',
        coalesce(array_to_string(d.defaclacl, ',') ~ '(^|,)(anon|authenticated)=', false),
      'grants_public',
        coalesce(array_to_string(d.defaclacl, ',') ~ '(^|,)=', false)
    ) as x
    from pg_default_acl d
    join pg_namespace n on n.oid = d.defaclnamespace
    where n.nspname = 'public'
  ) s
),

-- CHECK 13. The three tables this repository never references. Column names
-- and types only, never a value, so a PII-shaped column is visible without
-- reading anyone's data.
check_13_unreferenced_tables as (
  select coalesce(jsonb_agg(x order by x->>'table_name'), '[]'::jsonb) as v
  from (
    select jsonb_build_object(
      'table_name', t.name,
      'exists', (c.oid is not null),
      'rls_enabled', c.relrowsecurity,
      'policy_count', (select count(*) from pg_policies p
                        where p.schemaname = 'public' and p.tablename = t.name),
      'approx_rows', c.reltuples::bigint,
      'grants', coalesce((
        select jsonb_agg(distinct jsonb_build_object('grantee', g.grantee, 'privilege', g.privilege_type))
        from information_schema.role_table_grants g
        where g.table_schema = 'public' and g.table_name = t.name
          and g.grantee in ('anon', 'authenticated', 'service_role', 'gyema_reader', 'PUBLIC')
      ), '[]'::jsonb),
      'columns', coalesce((
        select jsonb_agg(jsonb_build_object('name', col.column_name, 'type', col.data_type)
                         order by col.ordinal_position)
        from information_schema.columns col
        where col.table_schema = 'public' and col.table_name = t.name
      ), '[]'::jsonb),
      'pii_shaped_columns', coalesce((
        select jsonb_agg(col.column_name order by col.column_name)
        from information_schema.columns col
        where col.table_schema = 'public' and col.table_name = t.name
          and (col.column_name ilike '%phone%'
            or col.column_name ilike '%whatsapp%'
            or col.column_name ilike '%email%'
            or col.column_name ilike '%name%'
            or col.column_name ilike '%address%'
            or col.column_name ilike '%wallet%'
            or col.column_name ilike '%uid%')
      ), '[]'::jsonb)
    ) as x
    from (values ('a2u_payments'), ('couriers'), ('legacy_couriers')) as t(name)
    left join pg_namespace n on n.nspname = 'public'
    left join pg_class c on c.relname = t.name and c.relnamespace = n.oid and c.relkind = 'r'
  ) s
)

select jsonb_pretty(jsonb_build_object(
  'gyema_catalog_checks', jsonb_build_object(
    'database', current_database(),
    'generated_at', now(),
    'server_version', current_setting('server_version'),
    'network_label', 'FILL THIS IN: TESTNET or MAINNET'
  ),

  -- Expectations for every check, so a differing result is visible here rather
  -- than by going back to the file that produced it.
  'expected', jsonb_build_object(
    'check_01_rls',
      'One row per table in public. rls_enabled true on listings, guest_jobs, pioneers, auth_events. '
      || 'For a2u_payments, couriers and legacy_couriers the expectation is unknown, and rls_enabled false '
      || 'on any of them is a finding: an unreferenced table is exactly where nobody notices RLS is off. '
      || 'rls_forced false everywhere.',
    'check_02_policies',
      'listings SELECT qual is expected to be literally true, which is what makes every column of every '
      || 'listing readable with the anon key (finding S-1). listings DELETE body is unknown to me and matters: '
      || 'a permissive DELETE cannot be undone from the app. listings UPDATE is expected to admit poster or '
      || 'matched party. guest_jobs is expected to have no policy admitting anon or authenticated. '
      || 'gyema_reader_select is expected absent once 2026-09-07 is applied. Policies on the three '
      || 'unreferenced tables: unknown, read them.',
    'check_03_table_grants',
      'Read the two dispatch views here as well: guest_jobs_dispatch and listings_dispatch must show '
      || 'gyema_reader and nothing else. They are created after the grant baseline runs, so on 7 September '
      || 'they were found on Testnet holding Supabase default grants for anon and authenticated. '
      || 'listings to anon with SELECT. authenticated with SELECT, INSERT, DELETE but NOT UPDATE, because the '
      || '2026-08-14 migration dropped the table wide UPDATE and re-granted per column. guest_jobs expected to '
      || 'show nothing for anon or authenticated: the guest rail is service_role only, and any row there is a '
      || 'finding. gyema_reader expected on the two dispatch views only.',
    'check_04_column_grants',
      'Two things. First, the authenticated UPDATE column list on listings should NOT contain status, '
      || 'sender_confirmed, traveller_confirmed or completed_at: those are attestation columns and belong to '
      || 'the RPC. Second, whatsapp and matched_with_whatsapp: if anon can read them here, or reads them '
      || 'through a table wide grant in check 03 with no column restriction, S-1 is confirmed. gyema_reader '
      || 'expected to have zero rows for sender_phone and recipient_phone.',
    'check_03b_and_04b_catalog_grants',
      'The same two questions read from pg_class.relacl and pg_attribute.attacl, where no role membership '
      || 'filtering applies. These are the authoritative answers. If 03 and 03b disagree, or 04 and 04b '
      || 'disagree, believe the catalog ones and tell me, because the disagreement itself is worth knowing.',
    'check_05_listings_insert_policy',
      'One INSERT policy on listings. If mentions_posted_by_id and mentions_auth_uid are both false then the '
      || 'poster identity on a listing is whatever the client typed, and S-15 is confirmed rather than '
      || 'theoretical.',
    'check_06_functions',
      'Expect guest_bump_delivery_code_attempts, guest_stamp_delivery and listing_confirm_completion as '
      || 'security definer with search_path_pinned true, and mask_phone_head_only as NOT security definer, '
      || 'immutable, search_path_pinned true. A security definer function with search_path_pinned false is a '
      || 'finding: it runs as its owner with whatever search_path the caller set.',
    'check_07_function_acls',
      'For the three security definer functions expect service_role and nothing else, so '
      || 'anon_or_authenticated_can_execute is false on every row. A true is the most serious single result '
      || 'this document can carry: it means a stamp can be written straight from the anon key without a route.',
    'check_08_guard_columns',
      'delivery_code_attempts present with default 0, and NO equivalent counter for the sender side last-4 '
      || 'guard. That absence is S-2, recorded from the catalog rather than inferred from reading routes.',
    'check_09_migration_objects',
      'TESTNET before 2026-09-07 is applied: everything present except the four 2026-09-07 rows. MAINNET '
      || 'today: the 2026-08-13 and 2026-08-14 rows present, the 2026-08-18 role absent, which is the drift. '
      || 'BOTH after 2026-09-07: every 2026-09-07 row present and both gyema_reader_select rows false.',
    'check_10_reader_role',
      'After 2026-09-07: settings carry default_transaction_read_only=on, statement_timeout=10s, '
      || 'idle_in_transaction_session_timeout=30s, lock_timeout=5s. superuser, createdb, createrole and '
      || 'inherit all false. can_login true where the role is in use.',
    'check_11_inventory',
      'The same name list on both networks. Row counts will differ and that is fine; the list should not. '
      || 'A name on one network and not the other is drift that nothing in db/migrations accounts for. '
      || 'approx_rows of -1 means the table has never been analysed, not that it is empty. '
      || 'referenced_by_repo false marks a table no route, lib or migration in this repository mentions.',
    'check_12_public_execute',
      'Zero rows. Any security definer function in public that PUBLIC can execute is reachable through '
      || 'PostgREST with the anon key, whoever wrote it and whenever.',
    'check_12b_default_privileges',
      'One row per creating role and object type with default privileges in schema public. For the postgres '
      || 'row: grants_anon_or_authenticated false on tables and sequences. There will be NO functions row, '
      || 'and that is expected: ALTER DEFAULT PRIVILEGES cannot take EXECUTE away from PUBLIC for future '
      || 'functions on PostgreSQL 17 (measured, see section 1a of the grant baseline), so a new function is '
      || 'callable with the public key until it is explicitly revoked. check_12_public_execute is the net for '
      || 'that and its expected answer is zero rows. A creating role that does not appear here at all still '
      || 'carries the built in defaults, so if objects are ever created as something other than postgres, that '
      || 'role needs the same two statements.',
    'check_13_unreferenced_tables',
      'a2u_payments, couriers and legacy_couriers, one row each whether or not the table exists (exists false '
      || 'on a network that does not have it is itself an answer). For each: is RLS on, who holds grants, and what the '
      || 'columns are. pii_shaped_columns is a name based guess, not a classification. The questions I need '
      || 'answered from it: are these live, is anon able to read any of them, and does legacy_couriers hold '
      || 'people who never agreed to be in it. a2u_payments matches the unmerged branch feat/a2u-payout, so '
      || 'it may be a table created for work that never shipped.'
  ),

  'check_01_rls',                   (select v from check_01_rls),
  'check_02_policies',              (select v from check_02_policies),
  'check_03_table_grants',          (select v from check_03_table_grants),
  'check_04_column_grants',         (select v from check_04_column_grants),
  'check_03b_table_grants_catalog', (select v from check_03b_table_grants_catalog),
  'check_04b_column_grants_catalog', (select v from check_04b_column_grants_catalog),
  'check_05_listings_insert_policy',(select v from check_05_listings_insert_policy),
  'check_06_functions',             (select v from check_06_functions),
  'check_07_function_acls',         (select v from check_07_function_acls),
  'check_08_guard_columns',         (select v from check_08_guard_columns),
  'check_09_migration_objects',     (select v from check_09_migration_objects),
  'check_10_reader_role',           (select v from check_10_reader_role),
  'check_11_inventory',             (select v from check_11_inventory),
  'check_12_public_execute',        (select v from check_12_public_execute),
  'check_12b_default_privileges',   (select v from check_12b_default_privileges),
  'check_13_unreferenced_tables',   (select v from check_13_unreferenced_tables)
)) as gyema_catalog_checks;

-- ===========================================================================
-- After running this
--
-- Paste the one cell back per network. The five answers that change what
-- happens next, in order:
--
--   1. check_02_policies: the listings SELECT qual and the DELETE body.
--   2. check_04_column_grants: whether anon can read whatsapp and
--      matched_with_whatsapp.
--   3. check_07_function_acls: whether anything but service_role holds EXECUTE.
--   4. check_13_unreferenced_tables: what a2u_payments, couriers and
--      legacy_couriers are, and whether anon can read them.
--   5. check_09_migration_objects: the per network checklist that turns the
--      drift from a guess into a list.
--
-- None of the fixes those imply are written yet, and none should be applied
-- from this file. Migrations go in db/migrations, one concern each, Testnet
-- first, applied by hand.
-- ===========================================================================
