# CLAUDE.md

Standing brief for Claude Code in the Gyema repositories (gyema-app, gyema-app-mainnet).
Read this before any change. The same file ships in both repos; rules that name a network
say so explicitly.

## What this is

Gyema: a peer to peer delivery marketplace on Pi Network, built and operated solo from
Accra, Ghana. Two rails that never blend: a Pioneer rail (Pi-denominated, authenticated,
`listings` table) and a Guest rail (cedi-denominated dispatch, `guest_jobs` table).
gyema-app is Testnet, the staging mirror. gyema-app-mainnet is production and the repo
is PUBLIC.

## Who you are working with

The founder directs every change and reviews every diff before merge. Explain what a
change does and what could break before making it. One logical change per branch.
Smallest-change fixes. Separate PRs for distinct concerns.

## The agent boundary (absolute)

1. **Agents read anything and draft anything. Agents never write a confirmation, stamp
   an attestation, or flip a status.** Any route or RPC that writes an attestation is
   drafted by the agent and reviewed line by line by the founder before merge. No
   exceptions, including byte-identical mirrors of already-reviewed code.
2. **Agents never mutate a database.** Every SQL mutation is applied by the founder by
   hand through the Supabase dashboard, with the project breadcrumb confirmed before
   the paste. Mainnet is read-only to agents at all times.
3. **Before trusting any file claim, confirm the repository.** Run `pwd` and
   `git remote get-url origin` first. Folder names lie; agent windows are not
   interchangeable.

## Invariants (a change that violates one of these is a bug, not a feature)

1. **Identity for sensitive operations is derived server-side** from
   `admin.auth.getUser` reading `user_metadata.pi_uid`. No route, RPC, or client
   function takes a role, party, or side argument. Re-introducing one is the F17
   defect.
2. **Security-definer RPCs with service_role-only EXECUTE** are the pattern for
   operations touching critical state. `search_path` pinned, grants revoked from
   public, anon, and authenticated.
3. **The two rails never blend.** Guest jobs never fire, simulate, or count toward
   Pioneer connection fee events.
4. **One front door.** Public copy and share surfaces carry the registered pinet
   production host only. Never the raw Vercel URL. The Mainnet host and the Testnet
   host never swap.
5. **No quantified carbon claims** anywhere in code, copy, or documentation until
   Gyema publishes its own measured benchmarks. No borrowed per-km figures.
6. **Trust signals are never borrowed.** The App Studio app's rating, raters, and
   staked Pi are a different app's numbers and never appear as this app's.
7. **`pi_username` is the identity anchor, never `pi_uid`.** Testnet rotates
   `pi_uid` across sessions.
8. **Every mutation carries RETURNING and is followed by a read-back.** An UPDATE
   matching zero rows still reports Success. For DDL, verify by querying catalog
   state, never by the Success banner.

## The merge gate (this rule has paid three times)

A green build on a branch is not a merge. A passed local branch delete is not a merge.
The gate is BOTH: main fast-forwards on `git pull`, AND a new Production deployment
appears (Vercel list, or `gh api .../deployments` with status `success`).

## Mirroring between networks

Testnet first, then mirror to Mainnet. Byte-identity per file is the default gate, with
one carve-out: **network-specific files mirror the change, not the bytes.** Before any
mirror, scan the file set for `pinet\.com|Testnet|testnet|8841|3681`; any file that
hits gets the change hand-applied onto its own network's version. Known
network-specific file: `components/listing-detail-sheet.tsx` (PI_APP_HOST, share
copy). CLAUDE.md is the documented exception: it hits the scan and still mirrors as
bytes, because the same file ships in both repos and rules that name a network say so.

The gate is blob-hash equality, checked TWICE, plus an existence test on the target
path. `git hash-object <file>` on the Mainnet working file before the commit, and
`git rev-parse HEAD:<path>` on the committed blob after, both matching
`git rev-parse <source-commit>:<path>` from the Testnet clone. Those are two separate
facts: the first says the copy landed, the second says what actually ships. Hashes
match or the mirror stops.

`git diff --no-index --quiet` is a secondary signal, never the gate. It normalizes line
endings, so it is not a byte comparison: both clones run `core.autocrlf=true`, and
working copies carry CRs that committed blobs do not. Measured 20 August on
`components/track-view.tsx`, it exited 0 on files whose raw sizes differed by 386
bytes, exactly the CR count.

## Database facts that bite

- `listings.status` is plain text, no enum, no CHECK. Observed values: `open`,
  `expired`, `matched`, `in_transit`, `completed`. Cancel-open writes `expired`.
- `listings` has no `updated_at` column. `guest_jobs` has one. Verify schema by
  reading it, never from memory; a 42703 here is self-inflicted.
- The guest rail has no application-level status transitions for uncoded jobs (F14,
  open). Terminal guest statuses are operator-applied by hand until F14 is fixed.
- Supabase SQL Editor does not preserve transaction state across executions. Prefer
  single auto-commit statements with verification between each.
- Before any guarded UPDATE on a free-text column, run a bracketed pre-flight:
  `select '[' || col || ']', length(col) from ... where <key>`. A guarded UPDATE whose
  guard misses matches zero rows and still reports Success, and whitespace is invisible
  in the result grid. Found live 21 August: `GYM-2F5367` held `'Asylum down '` at
  length 12, the guard on `'Asylum down'` matched nothing, and only the bracket
  exposed it. Off-list area inputs are stored untrimmed
  (`app/api/guest/create/route.ts`, fix queued). See invariant 8.
- A column-level revoke cannot subtract from a table-wide grant. Drop the table
  grant and re-grant per column.
- When an authenticated write fails generically, check
  `information_schema.role_table_grants` before chasing RLS or client config.

## Environment facts that bite

- `NEXT_PUBLIC_` variables bake at build time; setting one requires a redeploy.
- Pi Browser caches the JS bundle hard: fully close and reopen before verifying any
  UI change, and confirm the resolved domain is the intended network's production URL.
- Authed DB writes work at the raw Vercel URL; only Pi payments require the
  registered pinet host.
- Pi Testnet has no faucet and Pi Wallet refuses sends to unactivated accounts.

## PowerShell and process conventions

- Long scripts are written to a `.ps1` under `C:\Users\HP\Documents` and run with
  `& "path"`, never pasted as console here-strings.
- A clipboard-written script is verified by printing its first line before running.
  The clipboard is single-slot: copy the payload last, type the write command by hand.
- Guarded, all-or-nothing scripts: every sanity check passes or nothing is written.
  Expected counts are computed from the file, anchored to line starts, with
  dollar-quote markers counted as regex occurrences (Select-String counts lines,
  not occurrences).
- No end-of-line `$` anchors in regex (CRLF collision).

## Content and copy

- Any content another person will read passes the gyema-accuracy checklist before it
  leaves: locked answers used verbatim, no unlabelled roadmap features, every number
  traced to a query result or removed.
- No em-dashes anywhere: code comments, commit messages, documentation, copy.
- Escrow, payouts, and reputation are never described in the present tense until live.

## What to do when unsure

Read the actual file or the actual table before proposing anything. If a mechanism is
needed to explain observed behaviour and it cannot be found in the code, the answer is
that nothing implements the behaviour, not that a hidden trigger exists. Name the cause
from code before writing any fix. When still unsure, ask.
