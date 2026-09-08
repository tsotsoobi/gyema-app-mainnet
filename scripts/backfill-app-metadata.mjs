#!/usr/bin/env node
//
// Copy each Pioneer's pi_uid and pi_username from user_metadata into
// app_metadata, once, so existing accounts keep working after the identity
// change.
//
// WHY
//
// pi_uid decides who owns a listing, who may cancel a delivery, and whose
// phone number the counterpart RPC returns. It lived in user_metadata, which a
// signed in client writes itself with supabase.auth.updateUser({ data: ... })
// holding nothing but the anon key and their own session. Every check that
// read it was reading a value the caller chose.
//
// app_metadata can only be written with the service_role key. Routes and RLS
// policies now read it, and /api/auth/verify stamps it on every sign in. This
// script is for the accounts that signed in before that shipped: without it
// they get a 401 on every write until they sign in again.
//
// WHAT IT PRINTS
//
// Counts. Never a uid, never a username, never an email, never a token. The
// whole point of the identity work is that these values matter, so this script
// does not put them on a terminal, in scrollback, or in a screenshot pasted
// into a chat. If you need to see one, read it in the dashboard.
//
// SAFETY
//
// Dry run by default: it reads every user, works out what it would change, and
// changes nothing. Pass --apply to write.
//
// Idempotent. A user whose app_metadata already carries the same values is
// counted as "already correct" and skipped, so re-running costs a listUsers
// page scan and nothing else.
//
// It never invents an identity. A user with nothing in user_metadata and
// nothing in app_metadata is counted as "no identity to copy" and left alone:
// they will get one from /api/auth/verify the next time they sign in, from Pi,
// which is the only source that should ever mint one.
//
// It never overwrites a DIFFERENT app_metadata value with a user_metadata one.
// If those two disagree, app_metadata wins and the user is counted as a
// conflict, because user_metadata is exactly the field a person could have
// edited to say they are somebody else. Conflicts are the one thing worth
// investigating by hand.
//
// USAGE
//
//   NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//     node scripts/backfill-app-metadata.mjs           # dry run
//     node scripts/backfill-app-metadata.mjs --apply   # write
//
// Run it against ONE network at a time and confirm which one: the URL is
// printed as its project ref only. Testnet first.

import { createClient } from "@supabase/supabase-js"

const APPLY = process.argv.includes("--apply")
const PAGE_SIZE = 200

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!url || !serviceKey) {
  console.error("")
  console.error("[backfill] NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must both be set.")
  console.error("")
  console.error("  Take them from the project you intend to change, and confirm which project")
  console.error("  that is before running. This script writes to auth.users.")
  console.error("")
  process.exit(1)
}

// The project ref identifies which database this is without printing a key.
// https://<ref>.supabase.co
const projectRef = (() => {
  try {
    return new URL(url).hostname.split(".")[0]
  } catch {
    return "(unparseable url)"
  }
})()

const admin = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
})

/** True when two identity pairs say the same thing. */
function same(a, b) {
  return a.pi_uid === b.pi_uid && a.pi_username === b.pi_username
}

async function main() {
  console.log("")
  console.log("=".repeat(66))
  console.log("  Gyema app_metadata backfill")
  console.log("=".repeat(66))
  console.log(`  project ref : ${projectRef}`)
  console.log(`  mode        : ${APPLY ? "APPLY, this writes to auth.users" : "DRY RUN, nothing is written"}`)
  console.log("")

  const counts = {
    scanned: 0,
    alreadyCorrect: 0,
    wouldCopy: 0,
    copied: 0,
    noIdentity: 0,
    conflict: 0,
    failed: 0,
  }

  let page = 1
  for (;;) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: PAGE_SIZE })
    if (error) {
      console.error(`[backfill] listUsers failed on page ${page}: ${error.message}`)
      process.exit(1)
    }
    const users = data?.users ?? []
    if (users.length === 0) break

    for (const user of users) {
      counts.scanned += 1

      const app = {
        pi_uid: user.app_metadata?.pi_uid,
        pi_username: user.app_metadata?.pi_username,
      }
      const usr = {
        pi_uid: user.user_metadata?.pi_uid,
        pi_username: user.user_metadata?.pi_username,
      }

      if (app.pi_uid && app.pi_username) {
        // Already stamped. If user_metadata disagrees, app_metadata still
        // wins and nothing is written, but it is worth counting: a mismatch
        // is either an old rotated uid or somebody who edited their own.
        if (usr.pi_uid && !same(app, usr)) counts.conflict += 1
        else counts.alreadyCorrect += 1
        continue
      }

      if (!usr.pi_uid || !usr.pi_username) {
        // Nothing to copy. /api/auth/verify will stamp it from Pi at their
        // next sign in, which is the only source that should mint one.
        counts.noIdentity += 1
        continue
      }

      if (!APPLY) {
        counts.wouldCopy += 1
        continue
      }

      const { error: writeError } = await admin.auth.admin.updateUserById(user.id, {
        app_metadata: {
          pi_uid: usr.pi_uid,
          pi_username: usr.pi_username,
          provider: "pi-network",
        },
      })
      if (writeError) {
        // The message can name a constraint or a field, never a value.
        console.error(`[backfill] write failed for one user: ${writeError.message}`)
        counts.failed += 1
      } else {
        counts.copied += 1
      }
    }

    if (users.length < PAGE_SIZE) break
    page += 1
  }

  console.log("  Results")
  console.log("  " + "-".repeat(64))
  console.log(`  users scanned              : ${counts.scanned}`)
  console.log(`  already correct            : ${counts.alreadyCorrect}`)
  if (APPLY) {
    console.log(`  copied to app_metadata     : ${counts.copied}`)
    console.log(`  write failures             : ${counts.failed}`)
  } else {
    console.log(`  would copy                 : ${counts.wouldCopy}`)
  }
  console.log(`  no identity to copy        : ${counts.noIdentity}`)
  console.log(`  app_metadata already differs: ${counts.conflict}`)
  console.log("")

  if (counts.conflict > 0) {
    console.log("  A conflict means app_metadata and user_metadata disagree for a user.")
    console.log("  app_metadata was kept and nothing was written. Most likely an old")
    console.log("  rotated pi_uid; possibly somebody who edited their own metadata.")
    console.log("  Worth looking at by hand in the dashboard. This script will not name")
    console.log("  them, by design.")
    console.log("")
  }

  if (!APPLY && counts.wouldCopy > 0) {
    console.log("  Dry run. Re-run with --apply to write these.")
    console.log("")
  }

  if (counts.failed > 0) process.exit(1)
}

main().catch((err) => {
  console.error("[backfill] unexpected error:", err instanceof Error ? err.message : String(err))
  process.exit(1)
})
