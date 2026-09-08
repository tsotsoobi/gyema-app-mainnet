// ===========================================================================
// Gyema BD mesh, Node 1: the Dispatch Reader
// ===========================================================================
//
// A read only operations brief for the guest delivery rail, run by hand from
// the founder laptop. One command, one report, exit.
//
//   npm run dispatch
//
// WHAT THIS IS
//
// The eyes of the guest delivery operator runbook. It reads Testnet and
// prints what each stage of the queue currently holds, in runbook stage
// order, so the operator can see the whole board without clicking through
// nine dashboard queries. It is never the hands.
//
// SECTION 0, THE INTEGRITY CHECKS
//
// Four checks run after the preflight and before the queue sections, on every
// report. They exist because the problems they look for were found by hand
// rather than surfaced: free text stored untrimmed since July, and status
// values living in the table that the declared TypeScript union does not
// carry. A finding is a data condition, not a script failure. Nothing halts
// and the exit code does not move. A check that cannot run says so and sets
// exit 2, exactly as a failed section does, because a check that did not run
// must never read as a check that found nothing.
//
// WHAT THIS IS NOT, AND WILL NOT BECOME
//
// This file issues SELECT statements and nothing else. There is no insert,
// update, delete, RPC call, or storage call anywhere in it, and adding one is
// out of scope rather than a feature request. Two things enforce that beyond
// review:
//
//   1. The gyema_reader role carries default_transaction_read_only = on
//      (db/migrations/2026-08-18_dispatch_reader_role.sql section 2), so a
//      write fails at the database with 25006 no matter what this file says.
//   2. assertReadOnlySql() below refuses to execute any statement that is not
//      a lone SELECT, before it reaches the wire.
//
// There is also no scheduler, no daemon, no webhook, no WhatsApp integration,
// and nothing automatic. It runs when the founder types the command.
//
// CREDENTIALS
//
// No secret lives in this repo. The connection string is read from the
// environment variable GYEMA_READER_DATABASE_URL, which belongs in a
// gitignored .env.local or in the shell, and which authenticates as
// gyema_reader: SELECT on 22 named guest_jobs columns and 8 named listings
// columns, and nothing else. delivery_code_hash is deliberately not among
// them, so this script cannot read it even by mistake.
//
// Take the Session pooler URI from the Supabase dashboard under Connect (the
// direct db.<ref>.supabase.co host is IPv6 only on current projects), then
// swap the user to gyema_reader.<project_ref> and the password to the one
// generated when the migration was applied.
//
// TRACEABILITY
//
// Every value printed is a column value or an age computed from one. There
// are no derived scores, no sentiment, no advice, and no cross rail
// arithmetic. Each section and each integrity check prints the table, where
// clause, and order it actually ran, taken from the same strings used to
// build the SQL so the printed clause cannot drift from the executed one. Set
// GYEMA_DISPATCH_SHOW_SQL=1 to print each full statement as well.
//
// TIME
//
// The session pins TimeZone to Africa/Accra, so every rendered timestamp,
// every age, and the "today" test in section 7 are in Accra local time.
// Ghana observes UTC+0 year round with no daylight saving, so pasting a
// printed where clause into the Supabase SQL editor (session UTC) gives the
// same answer.
//
// ===========================================================================

import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import pg from "pg"

const { Client } = pg

// The one hard stop in the guest rail, kept in step with
// app/api/guest/confirm-delivery/route.ts MAX_CODE_ATTEMPTS. At this count
// the route returns code_locked and the courier cannot try again, so the
// report says locked because the code says locked.
const MAX_CODE_ATTEMPTS = 5

// Section 3 staleness threshold, in hours.
const POSTED_STALE_HOURS = 24

// Section 9 sighting window, expressed once so the interval literal in the
// where clause and the heading cannot disagree.
const SIGHTING_WINDOW_HOURS = 48

// The guest job statuses the application declares, mirrored by hand from the
// GuestJobStatus union at lib/guest-jobs.ts:7-13.
//
// It has to be a mirror. The union is a TypeScript type, erased at compile
// time, so it has no runtime form to import; and lib/guest-jobs.ts is
// TypeScript that imports fetch based client code, so a plain .mjs cannot
// load it at all. This list and that union move together: change one, change
// the other.
//
// Section 0.2 compares the table against this list. A finding there means the
// declared type and the table disagree, and either side can be the wrong one.
const DECLARED_GUEST_STATUSES = [
  "posted",
  "accepted",
  "in_transit",
  "delivered",
  "cancelled",
  "expired",
]

// The date the one time delivery code shipped, commit d85aef6. Section 0.3
// prints a created_at comparison against it as a fact and not as a verdict: a
// row created before this date could not have been minted a code, but nothing
// here concludes anything from that on its own.
const DELIVERY_CODE_SHIPPED = "2026-08-13"

const SHOW_SQL = process.env.GYEMA_DISPATCH_SHOW_SQL === "1"

// ---------------------------------------------------------------------------
// Column expression helpers
//
// Timestamps are rendered to text by Postgres rather than handed to the
// client as Date objects, so the displayed value cannot shift with whatever
// timezone the laptop happens to be set to. Ages are computed by Postgres for
// the same reason. bigint comes back from node-postgres as a string, so
// callers run these through toInt().
// ---------------------------------------------------------------------------
const tstamp = (col) => `to_char(${col}, 'YYYY-MM-DD HH24:MI') as ${col}_txt`
const dateOf = (col) => `to_char(${col}, 'YYYY-MM-DD') as ${col}_txt`
const ageOf = (col) => `extract(epoch from (now() - ${col}))::bigint as ${col}_age_secs`

// ---------------------------------------------------------------------------
// The exact column set this report needs, per table.
//
// The preflight compares these against information_schema.columns as seen by
// gyema_reader. That view is filtered by privilege, so a column that exists
// but was never granted is absent here too: one check catches both a schema
// drift and a missing grant, and it fails before any section runs rather than
// producing a quietly short report.
// ---------------------------------------------------------------------------
const REQUIRED_COLUMNS = {
  guest_jobs: [
    "tracking_id",
    "status",
    "created_at",
    "updated_at",
    "phone_verified",
    "verified_at",
    "pickup_area",
    "dropoff_area",
    "package_size",
    "when_pref",
    "scheduled_date",
    "quote_cedis",
    "payment_type",
    "sender_phone",
    "recipient_phone",
    "assigned_courier",
    "pickup_confirmed_at",
    "pickup_confirmed_by",
    "delivery_confirmed_at",
    "delivery_confirmed_by",
    "delivery_code_attempts",
    "remit_paid_at",
  ],
  listings: [
    "tracking_id",
    "kind",
    "status",
    "created_at",
    "from_city",
    "to_city",
    "posted_by_username",
    "archived_at",
  ],
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const LABEL_WIDTH = 22
const RULE = "=".repeat(74)
const THIN = "-".repeat(74)

function toInt(value) {
  if (value === null || value === undefined) return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

// Numeric columns arrive from node-postgres as strings so that precision is
// not silently lost. Anything unparseable is reported as unparseable rather
// than coerced to zero, because a zero would quietly understate a cedi total.
function toAmount(value) {
  if (value === null || value === undefined) return { ok: false, value: null, text: "(null)" }
  const n = Number(value)
  if (!Number.isFinite(n)) return { ok: false, value: null, text: `(unparseable: ${String(value)})` }
  return { ok: true, value: n, text: n.toFixed(2) }
}

// Phone numbers render masked except the last 4 digits, which is the only
// part the operator uses (it is the sender side guard reference). A full
// number is never printed by this script.
function maskPhone(raw) {
  if (raw === null || raw === undefined || String(raw).trim() === "") return "(none)"
  const digits = String(raw).replace(/[^0-9]/g, "")
  if (digits.length < 4) return "(unusable, fewer than 4 digits)"
  return "*".repeat(digits.length - 4) + digits.slice(-4)
}

function humanAge(seconds) {
  const s = toInt(seconds)
  if (s === null) return "(no age, timestamp null)"
  if (s < 0) return "(timestamp is in the future)"
  const mins = Math.floor(s / 60)
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 48) return `${hours}h ${mins % 60}m`
  const days = Math.floor(hours / 24)
  return `${days}d ${hours % 24}h`
}

function show(value) {
  if (value === null || value === undefined) return "(null)"
  if (value === "") return "(empty string)"
  if (value === true) return "true"
  if (value === false) return "false"
  return String(value)
}

function field(label, value) {
  return `    ${label.padEnd(LABEL_WIDTH)} ${value}`
}

function route(from, to) {
  return `${show(from)} -> ${show(to)}`
}

// Names the whitespace at the edges of a value by code point. Section 0.1
// brackets the value in SQL so the space is visible at all, but a bracket
// cannot tell a trailing space from a trailing tab, and the two are not the
// same defect: SQL trim would strip the first and leave the second, while the
// JS .trim() the create route applies strips both.
function describeEdgeWhitespace(value) {
  if (typeof value !== "string") return null
  const lead = value.match(/^\s+/)
  const trail = value.match(/\s+$/)
  if (!lead && !trail) return null
  const codes = []
  for (const chunk of [lead, trail]) {
    if (!chunk) continue
    for (const ch of chunk[0]) {
      const point = `U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}`
      if (!codes.includes(point)) codes.push(point)
    }
  }
  const sides = [lead ? "leading" : null, trail ? "trailing" : null].filter(Boolean).join(" and ")
  return `${sides}, ${codes.join(" ")}`
}

// ---------------------------------------------------------------------------
// Section definitions
//
// Each section owns its table, column list, where clause, and order clause as
// separate strings. buildSql() joins them, and the report prints the same
// strings it built from, so what is displayed is always what ran.
// ---------------------------------------------------------------------------

function buildSql(section) {
  return [
    `select ${section.columns.join(",\n       ")}`,
    `  from ${section.table}`,
    ` where ${section.where}`,
    ` order by ${section.order}`,
  ].join("\n")
}

const SECTIONS = [
  {
    id: 1,
    title: "NEW JOBS, awaiting quote",
    subtitle: "Every pending_quote row. Unverified rows are flagged: WhatsApp not yet matched.",
    table: "public.guest_jobs",
    where: "status = 'pending_quote'",
    order: "created_at asc",
    columns: [
      "tracking_id",
      tstamp("created_at"),
      ageOf("created_at"),
      "phone_verified",
      "pickup_area",
      "dropoff_area",
      "package_size",
      "when_pref",
      dateOf("scheduled_date"),
      "payment_type",
      "quote_cedis",
      "sender_phone",
    ],
    render: (r) => ({
      flags: r.phone_verified === true ? [] : ["UNVERIFIED, WhatsApp not yet matched"],
      age: r.created_at_age_secs,
      fields: [
        ["created_at", show(r.created_at_txt)],
        ["phone_verified", show(r.phone_verified)],
        ["route", route(r.pickup_area, r.dropoff_area)],
        ["package_size", show(r.package_size)],
        ["when_pref", show(r.when_pref)],
        ["scheduled_date", show(r.scheduled_date_txt)],
        ["payment_type", show(r.payment_type)],
        ["quote_cedis", toAmount(r.quote_cedis).text],
        ["sender_phone", maskPhone(r.sender_phone)],
      ],
    }),
  },

  {
    id: 2,
    title: "VERIFIED, AWAITING QUOTE",
    subtitle: "Subset of section 1, not a second queue: the pending_quote rows whose phone is verified.",
    table: "public.guest_jobs",
    where: "status = 'pending_quote' and phone_verified = true",
    order: "created_at asc",
    columns: [
      "tracking_id",
      tstamp("created_at"),
      ageOf("created_at"),
      tstamp("verified_at"),
      "pickup_area",
      "dropoff_area",
      "package_size",
      "when_pref",
      dateOf("scheduled_date"),
      "payment_type",
      "quote_cedis",
      "sender_phone",
    ],
    render: (r) => ({
      flags: [],
      age: r.created_at_age_secs,
      fields: [
        ["created_at", show(r.created_at_txt)],
        ["verified_at", show(r.verified_at_txt)],
        ["route", route(r.pickup_area, r.dropoff_area)],
        ["package_size", show(r.package_size)],
        ["when_pref", show(r.when_pref)],
        ["scheduled_date", show(r.scheduled_date_txt)],
        ["payment_type", show(r.payment_type)],
        ["quote_cedis", toAmount(r.quote_cedis).text],
        ["sender_phone", maskPhone(r.sender_phone)],
      ],
    }),
  },

  {
    id: 3,
    title: "POSTED, NOT YET ACCEPTED",
    subtitle:
      "phone_verified is shown per row, not filtered on: app/api/guest/create/route.ts writes status posted with phone_verified false on the same insert, so unverified posted rows exist.",
    table: "public.guest_jobs",
    where: "status = 'posted'",
    order: "created_at asc",
    columns: [
      "tracking_id",
      tstamp("created_at"),
      ageOf("created_at"),
      "phone_verified",
      tstamp("verified_at"),
      "assigned_courier",
      "pickup_area",
      "dropoff_area",
      "package_size",
      "when_pref",
      dateOf("scheduled_date"),
      "payment_type",
      "quote_cedis",
    ],
    render: (r) => {
      const secs = toInt(r.created_at_age_secs)
      const flags = []
      if (secs !== null && secs >= POSTED_STALE_HOURS * 3600) {
        flags.push(`STALE, unaccepted for over ${POSTED_STALE_HOURS}h`)
      }
      if (r.phone_verified !== true) flags.push("UNVERIFIED, WhatsApp not yet matched")
      return {
        flags,
        age: r.created_at_age_secs,
        fields: [
          ["created_at", show(r.created_at_txt)],
          ["phone_verified", show(r.phone_verified)],
          ["verified_at", show(r.verified_at_txt)],
          ["assigned_courier", show(r.assigned_courier)],
          ["route", route(r.pickup_area, r.dropoff_area)],
          ["package_size", show(r.package_size)],
          ["when_pref", show(r.when_pref)],
          ["scheduled_date", show(r.scheduled_date_txt)],
          ["payment_type", show(r.payment_type)],
          ["quote_cedis", toAmount(r.quote_cedis).text],
        ],
      }
    },
  },

  {
    id: 4,
    title: "ACCEPTED, PICKUP NOT YET STAMPED",
    subtitle:
      "Waiting on the courier and the sender, not on the operator. No operator action is defined for this stage.",
    table: "public.guest_jobs",
    where: "status = 'accepted' and pickup_confirmed_at is null",
    order: "created_at asc",
    columns: [
      "tracking_id",
      tstamp("created_at"),
      ageOf("created_at"),
      tstamp("updated_at"),
      "assigned_courier",
      "pickup_area",
      "dropoff_area",
      "package_size",
      "quote_cedis",
      "sender_phone",
      "recipient_phone",
    ],
    render: (r) => ({
      flags: [],
      age: r.created_at_age_secs,
      fields: [
        ["created_at", show(r.created_at_txt)],
        ["updated_at", show(r.updated_at_txt)],
        ["assigned_courier", show(r.assigned_courier)],
        ["route", route(r.pickup_area, r.dropoff_area)],
        ["package_size", show(r.package_size)],
        ["quote_cedis", toAmount(r.quote_cedis).text],
        ["sender_phone", maskPhone(r.sender_phone)],
        ["recipient_phone", maskPhone(r.recipient_phone)],
      ],
    }),
  },

  {
    id: 5,
    title: "FLIP 1 READY",
    subtitle: "status accepted and pickup_confirmed_at is not null. The in_transit flip is now safe on these rows.",
    table: "public.guest_jobs",
    where: "status = 'accepted' and pickup_confirmed_at is not null",
    order: "pickup_confirmed_at asc",
    columns: [
      "tracking_id",
      tstamp("created_at"),
      tstamp("pickup_confirmed_at"),
      ageOf("pickup_confirmed_at"),
      "pickup_confirmed_by",
      "assigned_courier",
      "pickup_area",
      "dropoff_area",
      "package_size",
      "quote_cedis",
    ],
    render: (r) => ({
      flags: ["FLIP 1 READY: the operator in_transit flip is now safe on this row"],
      age: r.pickup_confirmed_at_age_secs,
      ageLabel: "stamped",
      fields: [
        ["created_at", show(r.created_at_txt)],
        ["pickup_confirmed_at", show(r.pickup_confirmed_at_txt)],
        ["pickup_confirmed_by", show(r.pickup_confirmed_by)],
        ["assigned_courier", show(r.assigned_courier)],
        ["route", route(r.pickup_area, r.dropoff_area)],
        ["package_size", show(r.package_size)],
        ["quote_cedis", toAmount(r.quote_cedis).text],
      ],
    }),
  },

  {
    id: 6,
    title: "IN TRANSIT, watching the handover",
    subtitle: `delivery_code_attempts is the courier's code entry count. ${MAX_CODE_ATTEMPTS} of ${MAX_CODE_ATTEMPTS} is the hard stop in app/api/guest/confirm-delivery/route.ts, at which the route returns code_locked.`,
    table: "public.guest_jobs",
    where: "status = 'in_transit'",
    order: "updated_at asc",
    columns: [
      "tracking_id",
      tstamp("updated_at"),
      ageOf("updated_at"),
      tstamp("pickup_confirmed_at"),
      "delivery_code_attempts",
      tstamp("delivery_confirmed_at"),
      "delivery_confirmed_by",
      "assigned_courier",
      "pickup_area",
      "dropoff_area",
      "recipient_phone",
    ],
    render: (r) => {
      const attempts = toInt(r.delivery_code_attempts)
      const flags = []
      if (attempts !== null && attempts >= MAX_CODE_ATTEMPTS) {
        flags.push(
          `!!! HARD STOP !!! ${attempts} of ${MAX_CODE_ATTEMPTS} attempts used, code is locked, operator review required`
        )
      } else if (attempts !== null && attempts >= 3) {
        flags.push(`ALERT: ${attempts} of ${MAX_CODE_ATTEMPTS} code attempts used`)
      }
      return {
        flags,
        age: r.updated_at_age_secs,
        ageLabel: "since updated_at",
        fields: [
          ["updated_at", show(r.updated_at_txt)],
          ["pickup_confirmed_at", show(r.pickup_confirmed_at_txt)],
          ["delivery_code_attempts", show(r.delivery_code_attempts)],
          ["delivery_confirmed_at", show(r.delivery_confirmed_at_txt)],
          ["delivery_confirmed_by", show(r.delivery_confirmed_by)],
          ["assigned_courier", show(r.assigned_courier)],
          ["route", route(r.pickup_area, r.dropoff_area)],
          ["recipient_phone", maskPhone(r.recipient_phone)],
        ],
      }
    },
  },

  {
    id: 7,
    title: "CLOSED TODAY",
    subtitle:
      "delivery_confirmed_by sender+courier_code is a fully stamped close. A bare sender is a legacy close, predating the delivery code. updated_at and delivery_confirmed_at are shown side by side: a hand applied close through the SQL editor moves updated_at only if the operator typed it, so a row can be closed today and absent from this filter.",
    table: "public.guest_jobs",
    where: "status = 'delivered' and updated_at::date = current_date",
    order: "updated_at asc",
    columns: [
      "tracking_id",
      tstamp("updated_at"),
      tstamp("delivery_confirmed_at"),
      "delivery_confirmed_by",
      "delivery_code_attempts",
      "assigned_courier",
      "pickup_area",
      "dropoff_area",
      "quote_cedis",
      tstamp("remit_paid_at"),
    ],
    render: (r) => ({
      flags:
        r.delivery_confirmed_by === "sender+courier_code"
          ? ["fully stamped close: sender and delivery code"]
          : [`stamp value: ${show(r.delivery_confirmed_by)}`],
      age: null,
      fields: [
        ["updated_at", show(r.updated_at_txt)],
        ["delivery_confirmed_at", show(r.delivery_confirmed_at_txt)],
        ["delivery_confirmed_by", show(r.delivery_confirmed_by)],
        ["delivery_code_attempts", show(r.delivery_code_attempts)],
        ["assigned_courier", show(r.assigned_courier)],
        ["route", route(r.pickup_area, r.dropoff_area)],
        ["quote_cedis", toAmount(r.quote_cedis).text],
        ["remit_paid_at", show(r.remit_paid_at_txt)],
      ],
    }),
  },

  {
    id: 8,
    title: "REMIT OUTSTANDING",
    subtitle: "status delivered with remit_paid_at null. The total below is summed from the quote_cedis values printed above it and from nothing else.",
    table: "public.guest_jobs",
    where: "status = 'delivered' and remit_paid_at is null",
    order: "updated_at asc",
    columns: [
      "tracking_id",
      tstamp("updated_at"),
      ageOf("updated_at"),
      tstamp("delivery_confirmed_at"),
      "delivery_confirmed_by",
      "assigned_courier",
      "pickup_area",
      "dropoff_area",
      "payment_type",
      "quote_cedis",
    ],
    render: (r) => ({
      flags: [],
      age: r.updated_at_age_secs,
      ageLabel: "since updated_at",
      fields: [
        ["updated_at", show(r.updated_at_txt)],
        ["delivery_confirmed_at", show(r.delivery_confirmed_at_txt)],
        ["delivery_confirmed_by", show(r.delivery_confirmed_by)],
        ["assigned_courier", show(r.assigned_courier)],
        ["route", route(r.pickup_area, r.dropoff_area)],
        ["payment_type", show(r.payment_type)],
        ["quote_cedis", toAmount(r.quote_cedis).text],
      ],
    }),
    // Summed in the client, from the same rows printed above, so the figure is
    // checkable line by line rather than taken on trust from a SQL aggregate.
    footer: (rows) => {
      let total = 0
      let counted = 0
      let skipped = 0
      for (const r of rows) {
        const amount = toAmount(r.quote_cedis)
        if (amount.ok) {
          total += amount.value
          counted += 1
        } else {
          skipped += 1
        }
      }
      const lines = [`  quote_cedis total over ${counted} of ${rows.length} rows: ${total.toFixed(2)}`]
      if (skipped > 0) {
        lines.push(`  ${skipped} row(s) carried no usable quote_cedis and are excluded from that total`)
      }
      return lines
    },
  },

  {
    id: 9,
    title: `PIONEER RAIL SIGHTINGS, last ${SIGHTING_WINDOW_HOURS}h, read only FYI`,
    subtitle:
      "The Pioneer rail is a separate rail. This is a list and nothing more: no analysis, and no number here is ever added to a Guest number.",
    table: "public.listings",
    where: `created_at >= now() - interval '${SIGHTING_WINDOW_HOURS} hours'`,
    order: "created_at desc",
    columns: [
      "tracking_id",
      "kind",
      "status",
      tstamp("created_at"),
      ageOf("created_at"),
      "posted_by_username",
      "from_city",
      "to_city",
      tstamp("archived_at"),
    ],
    render: (r) => ({
      flags: r.archived_at_txt ? [`archived at ${r.archived_at_txt}`] : [],
      age: r.created_at_age_secs,
      fields: [
        ["kind", show(r.kind)],
        ["status", show(r.status)],
        ["created_at", show(r.created_at_txt)],
        ["posted_by_username", show(r.posted_by_username)],
        ["route", route(r.from_city, r.to_city)],
        ["archived_at", show(r.archived_at_txt)],
      ],
    }),
  },
]

// ---------------------------------------------------------------------------
// Section 0 check definitions
//
// Same shape as a section, so buildSql(), assertReadOnlySql(),
// printSectionHeading() and printRow() all apply unchanged. Ids are 0.1 to
// 0.4 rather than whole numbers so that sections 1 through 9 keep the numbers
// they already have: db/migrations/2026-08-18_dispatch_reader_role.sql refers
// to section 8 and section 9 by number, and renumbering here would quietly
// falsify a comment in a migration that has already been applied.
//
// No check calls a function. Every test is built from operators, so the
// allowlist in ALLOWED_CALLS stays at seven entries and the guard keeps its
// narrow promise.
// ---------------------------------------------------------------------------
const CHECKS = [
  {
    id: "0.1",
    title: "UNTRIMMED FREE TEXT",
    subtitle:
      "Area values holding leading or trailing whitespace. The test is the regex match operator, not a call to trim: Postgres trim strips spaces only by default, while the JS .trim() that app/api/guest/create/route.ts has applied since commit 634a7cb on 21 August 2026 also strips tabs and newlines. Matching on backslash s reports what that fix would have caught rather than the narrower thing SQL trim would. Rows created before 634a7cb were inserted untrimmed.",
    table: "public.guest_jobs",
    where: "pickup_area ~ '^\\s|\\s$' or dropoff_area ~ '^\\s|\\s$'",
    order: "created_at asc",
    columns: [
      "tracking_id",
      "status",
      tstamp("created_at"),
      ageOf("created_at"),
      "pickup_area",
      "dropoff_area",
      "'[' || pickup_area || ']' as pickup_area_bracketed",
      "'[' || dropoff_area || ']' as dropoff_area_bracketed",
    ],
    render: (r) => {
      const flags = []
      const pickup = describeEdgeWhitespace(r.pickup_area)
      const dropoff = describeEdgeWhitespace(r.dropoff_area)
      if (pickup) flags.push(`pickup_area is untrimmed: ${pickup}`)
      if (dropoff) flags.push(`dropoff_area is untrimmed: ${dropoff}`)
      return {
        flags,
        age: r.created_at_age_secs,
        fields: [
          ["status", show(r.status)],
          ["created_at", show(r.created_at_txt)],
          ["pickup_area", show(r.pickup_area_bracketed)],
          ["dropoff_area", show(r.dropoff_area_bracketed)],
        ],
      }
    },
  },

  {
    id: "0.2",
    title: "STATUS VOCABULARY",
    subtitle:
      "Rows whose status is not among the values declared by the GuestJobStatus union at lib/guest-jobs.ts:7-13, mirrored in this file as DECLARED_GUEST_STATUSES. A finding means the declared type and the table disagree, and either side can be the wrong one. Known case: app/api/guest/create/route.ts:126 writes pending_quote, which the union does not carry, so pending_quote rows appear here until one side changes. The null arm is deliberate, not defensive: status not in (...) evaluates to null for a null status and would drop exactly the row most worth seeing.",
    table: "public.guest_jobs",
    where: `status is null or status not in (${DECLARED_GUEST_STATUSES.map((s) => `'${s}'`).join(", ")})`,
    order: "status, created_at asc",
    columns: [
      "tracking_id",
      "status",
      tstamp("created_at"),
      ageOf("created_at"),
      tstamp("updated_at"),
      "pickup_area",
      "dropoff_area",
      "quote_cedis",
    ],
    render: (r) => ({
      flags: [
        r.status === null || r.status === undefined
          ? "status is null. The declared GuestJobStatus union carries no null, so the type and the table disagree."
          : `status "${r.status}" is not in the declared GuestJobStatus union (lib/guest-jobs.ts:7-13). The type and the table disagree.`,
      ],
      age: r.created_at_age_secs,
      fields: [
        ["status", show(r.status)],
        ["created_at", show(r.created_at_txt)],
        ["updated_at", show(r.updated_at_txt)],
        ["route", route(r.pickup_area, r.dropoff_area)],
        ["quote_cedis", toAmount(r.quote_cedis).text],
      ],
    }),
    // Tallied in the client, from the same rows printed above, for the same
    // reason section 8 sums its own rows: the figure stays checkable line by
    // line instead of arriving from a SQL aggregate on trust.
    footer: (rows) => {
      const tally = new Map()
      for (const r of rows) {
        const key = r.status === null || r.status === undefined ? "(null)" : String(r.status)
        tally.set(key, (tally.get(key) || 0) + 1)
      }
      const lines = ["  undeclared status values, counted from the rows above:"]
      for (const [value, count] of tally) lines.push(`    ${value}: ${count} row(s)`)
      lines.push(`  declared union: ${DECLARED_GUEST_STATUSES.join(", ")}`)
      return lines
    },
  },

  {
    id: "0.3",
    title: "DELIVERED WITHOUT BOTH STAMPS",
    subtitle:
      "status delivered where delivery_confirmed_by is not sender+courier_code, the composite lib/delivery-stamps.ts writes once both sides have signed off. Two buckets, kept apart rather than flattened, because only one of them is unambiguous. delivery_code_hash is not granted to gyema_reader, so this report cannot tell a coded job from an uncoded one and does not guess. delivery_code_attempts is shown but discriminates nothing: it is integer not null default 0, so every row carries 0 whether coded or not. is distinct from, not <>, because <> against a null delivery_confirmed_by yields null and would drop the row instead of reporting it.",
    table: "public.guest_jobs",
    where: "status = 'delivered' and delivery_confirmed_by is distinct from 'sender+courier_code'",
    order: "updated_at asc",
    columns: [
      "tracking_id",
      "status",
      "delivery_confirmed_by",
      tstamp("created_at"),
      tstamp("delivery_confirmed_at"),
      tstamp("updated_at"),
      ageOf("updated_at"),
      "delivery_code_attempts",
      "assigned_courier",
      "pickup_area",
      "dropoff_area",
      "quote_cedis",
    ],
    render: (r) => {
      const by = r.delivery_confirmed_by
      const flags = []
      if (by === "courier_code") {
        flags.push(
          "UNAMBIGUOUS: closed on the courier code alone. The sender never signed off, so this row reached delivered by hand."
        )
      } else if (by === "sender") {
        flags.push(
          "AMBIGUOUS: a bare sender stamp is either a legacy close predating the delivery code, correct for its own era, or a coded job closed by hand on one stamp. This report cannot tell which, because delivery_code_hash is not granted to gyema_reader."
        )
        const created = typeof r.created_at_txt === "string" ? r.created_at_txt.slice(0, 10) : null
        if (created) {
          const side = created < DELIVERY_CODE_SHIPPED ? "before" : "on or after"
          flags.push(
            `created_at ${created} is ${side} ${DELIVERY_CODE_SHIPPED}, the date the delivery code shipped. A date comparison, not a verdict.`
          )
        }
      } else {
        flags.push(
          `UNEXPECTED stamp value ${show(by)}. lib/delivery-stamps.ts declares three legal values and this is not one of them.`
        )
      }
      return {
        flags,
        age: r.updated_at_age_secs,
        ageLabel: "since updated_at",
        fields: [
          ["delivery_confirmed_by", show(r.delivery_confirmed_by)],
          ["created_at", show(r.created_at_txt)],
          ["delivery_confirmed_at", show(r.delivery_confirmed_at_txt)],
          ["updated_at", show(r.updated_at_txt)],
          ["delivery_code_attempts", show(r.delivery_code_attempts)],
          ["assigned_courier", show(r.assigned_courier)],
          ["route", route(r.pickup_area, r.dropoff_area)],
          ["quote_cedis", toAmount(r.quote_cedis).text],
        ],
      }
    },
    footer: (rows) => {
      let courierOnly = 0
      let senderOnly = 0
      let other = 0
      for (const r of rows) {
        if (r.delivery_confirmed_by === "courier_code") courierOnly += 1
        else if (r.delivery_confirmed_by === "sender") senderOnly += 1
        else other += 1
      }
      return [
        "  buckets, counted from the rows above:",
        `    courier_code alone, unambiguous hand close: ${courierOnly} row(s)`,
        `    sender alone, legacy close or hand close, undecidable here: ${senderOnly} row(s)`,
        `    stamp value outside the three lib/delivery-stamps.ts declares: ${other} row(s)`,
      ]
    },
  },

  {
    id: "0.4",
    title: "REMIT PAID ON A JOB THAT IS NOT DELIVERED",
    subtitle:
      "remit_paid_at is set on a row whose status is not delivered. The total below is summed from the quote_cedis values printed above it and from nothing else. is distinct from, not <>, because status <> 'delivered' evaluates to null for a null status and would drop the row instead of reporting it.",
    table: "public.guest_jobs",
    where: "remit_paid_at is not null and status is distinct from 'delivered'",
    order: "remit_paid_at asc",
    columns: [
      "tracking_id",
      "status",
      tstamp("remit_paid_at"),
      ageOf("remit_paid_at"),
      tstamp("updated_at"),
      tstamp("delivery_confirmed_at"),
      "delivery_confirmed_by",
      "assigned_courier",
      "pickup_area",
      "dropoff_area",
      "quote_cedis",
    ],
    render: (r) => ({
      flags: [`remit_paid_at is set on a job whose status is ${show(r.status)}, not delivered`],
      age: r.remit_paid_at_age_secs,
      ageLabel: "since remit_paid_at",
      fields: [
        ["status", show(r.status)],
        ["remit_paid_at", show(r.remit_paid_at_txt)],
        ["updated_at", show(r.updated_at_txt)],
        ["delivery_confirmed_at", show(r.delivery_confirmed_at_txt)],
        ["delivery_confirmed_by", show(r.delivery_confirmed_by)],
        ["assigned_courier", show(r.assigned_courier)],
        ["route", route(r.pickup_area, r.dropoff_area)],
        ["quote_cedis", toAmount(r.quote_cedis).text],
      ],
    }),
    footer: (rows) => {
      let total = 0
      let counted = 0
      let skipped = 0
      for (const r of rows) {
        const amount = toAmount(r.quote_cedis)
        if (amount.ok) {
          total += amount.value
          counted += 1
        } else {
          skipped += 1
        }
      }
      const lines = [
        `  quote_cedis total over ${counted} of ${rows.length} rows: ${total.toFixed(2)}`,
        "  That is money marked paid out against jobs not marked delivered.",
      ]
      if (skipped > 0) {
        lines.push(`  ${skipped} row(s) carried no usable quote_cedis and are excluded from that total`)
      }
      return lines
    },
  },
]

// ---------------------------------------------------------------------------
// Read only guard
//
// Belt to the database's braces. Every statement this file sends passes
// through here first. A statement that is not a single leading SELECT, or
// that carries a second statement after a semicolon, never reaches the wire.
// ---------------------------------------------------------------------------
// Every token this file is permitted to place before an open paren. Two
// SQL keywords that legitimately precede one, and the complete set of five
// functions the report calls. Adding a section that needs a sixth function
// means adding it here deliberately, which is the intended friction.
const ALLOWED_CALLS = new Set([
  "from",
  "in",
  "to_char",
  "extract",
  "now",
  "current_database",
  "current_setting",
])

function assertReadOnlySql(sql) {
  const stripped = sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .trim()

  if (!/^select\s/i.test(stripped)) {
    throw new Error(`[dispatch-reader] refused: statement does not begin with SELECT:\n${sql}`)
  }
  if (stripped.replace(/;\s*$/, "").includes(";")) {
    throw new Error(`[dispatch-reader] refused: more than one statement in:\n${sql}`)
  }
  const banned = /\b(insert|update|delete|truncate|drop|alter|create|grant|revoke|copy|call|do)\b/i
  const hit = stripped.match(banned)
  if (hit) {
    throw new Error(`[dispatch-reader] refused: statement contains "${hit[0]}":\n${sql}`)
  }

  // Function calls are allowlisted, not blocklisted.
  //
  // Leading SELECT is not on its own a read only guarantee: "select
  // guest_stamp_delivery('GYM-000000','sender')" begins with SELECT and
  // closes a delivery. Any security definer function is reachable that way.
  // So instead of guessing at the names of everything that writes, this
  // permits only the handful of functions the report actually calls and
  // refuses every other call by default.
  for (const match of stripped.matchAll(/\b([a-z_][a-z0-9_]*)\s*\(/gi)) {
    const name = match[1].toLowerCase()
    if (!ALLOWED_CALLS.has(name)) {
      throw new Error(
        `[dispatch-reader] refused: statement calls "${name}(", which is not in the read only allowlist:\n${sql}`
      )
    }
  }
  return sql
}

async function runSelect(client, sql) {
  return client.query(assertReadOnlySql(sql))
}

// ---------------------------------------------------------------------------
// Connection breadcrumb
//
// Printed at the top of every report. CLAUDE.md warns that folder names lie
// and that the project has to be confirmed before anything is trusted; the
// same applies to a terminal full of report text. Host, port, user, and
// database only. The password is parsed out and never touched again.
// ---------------------------------------------------------------------------
function describeTarget(rawUrl) {
  try {
    const u = new URL(rawUrl)
    return {
      host: u.hostname || "(none)",
      port: u.port || "5432",
      user: decodeURIComponent(u.username || "") || "(none)",
      database: (u.pathname || "").replace(/^\//, "") || "(none)",
    }
  } catch {
    return { host: "(unparseable connection string)", port: "?", user: "?", database: "?" }
  }
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------
function buildPreflightSql() {
  const tables = Object.keys(REQUIRED_COLUMNS)
  return [
    "select table_name, column_name",
    "  from information_schema.columns",
    " where table_schema = 'public'",
    `   and table_name in (${tables.map((t) => `'${t}'`).join(", ")})`,
    " order by table_name, column_name",
  ].join("\n")
}

async function preflight(client) {
  const tables = Object.keys(REQUIRED_COLUMNS)
  const { rows } = await runSelect(client, buildPreflightSql())

  const seen = new Map(tables.map((t) => [t, new Set()]))
  for (const row of rows) {
    const set = seen.get(row.table_name)
    if (set) set.add(row.column_name)
  }

  const missing = []
  for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
    for (const column of columns) {
      if (!seen.get(table).has(column)) missing.push(`${table}.${column}`)
    }
  }
  return { missing, visible: seen }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function printSectionHeading(section, rowCount) {
  console.log("")
  console.log(RULE)
  console.log(`SECTION ${section.id}  ${section.title}`)
  console.log(RULE)
  if (section.subtitle) {
    for (const line of wrap(section.subtitle, 72)) console.log(line)
  }
  console.log(`  from   ${section.table}`)
  console.log(`  where  ${section.where}`)
  console.log(`  order  ${section.order}`)
  console.log(`  rows   ${rowCount}`)
  if (SHOW_SQL) {
    console.log("  sql")
    for (const line of buildSql(section).split("\n")) console.log(`    ${line}`)
  }
  console.log(THIN)
}

function wrap(text, width) {
  const words = text.split(/\s+/)
  const lines = []
  let current = ""
  for (const word of words) {
    if (current.length + word.length + 1 > width) {
      lines.push(`  ${current}`)
      current = word
    } else {
      current = current ? `${current} ${word}` : word
    }
  }
  if (current) lines.push(`  ${current}`)
  return lines
}

// Renders one row and returns the view it rendered, so the caller can count
// flags without invoking section.render a second time.
function printRow(section, row) {
  const view = section.render(row)
  const ageLabel = view.ageLabel || "age"
  const agePart = view.age === null || view.age === undefined ? "" : `   ${ageLabel} ${humanAge(view.age)}`
  console.log("")
  console.log(`  ${show(row.tracking_id)}${agePart}`)
  for (const flag of view.flags) console.log(`      >> ${flag}`)
  for (const [label, value] of view.fields) console.log(field(label, value))
  return view
}

// ---------------------------------------------------------------------------
// Section 0, the integrity checks
//
// Runs after the preflight and before section 1, because a data integrity
// finding changes how every queue section below it reads.
//
// Three outcomes are kept visually distinct, which is the whole point of the
// block. "clean, no rows matched" means the query ran and matched nothing. A
// row count means it matched something. "CHECK DID NOT RUN" means the report
// itself is broken and the zero you would otherwise have read was never
// measured. The failure that prompted this section was a silence being read
// as a clean result, so silence is not an outcome here.
//
// Findings do not halt and do not move the exit code: a finding is a data
// condition, not a script failure, and a reader that refused to run on dirty
// data would be useless on exactly the days it is needed. A check that errors
// does set exit 2, the same as a failed section.
// ---------------------------------------------------------------------------
async function runIntegrity(client) {
  console.log("")
  console.log(RULE)
  console.log("SECTION 0  INTEGRITY CHECKS")
  console.log(RULE)
  console.log(`  ${CHECKS.length} checks, run on every report, before the queue sections.`)
  console.log("  A finding here is a data condition, not a script failure: nothing halts")
  console.log("  and the exit code does not move. A check that cannot run says so, and")
  console.log("  its result is unknown rather than clean.")

  let ran = 0
  let failed = 0
  let findingRows = 0
  let checksWithFindings = 0
  let alerts = 0

  for (const check of CHECKS) {
    let rows
    try {
      const result = await runSelect(client, buildSql(check))
      rows = result.rows
    } catch (err) {
      printSectionHeading(check, "not run")
      console.log("")
      console.log(`  CHECK DID NOT RUN: ${err.code ? `${err.code} ` : ""}${err.message}`)
      console.log("  This is not a clean result. Nothing was measured for this check.")
      failed += 1
      continue
    }

    ran += 1
    printSectionHeading(check, rows.length)

    if (rows.length === 0) {
      console.log("")
      console.log("  clean, no rows matched")
      continue
    }

    findingRows += rows.length
    checksWithFindings += 1
    for (const row of rows) {
      alerts += printRow(check, row).flags.length
    }
    if (check.footer) {
      console.log("")
      for (const line of check.footer(rows)) console.log(line)
    }
  }

  console.log("")
  console.log(THIN)
  if (findingRows === 0) {
    console.log(`  INTEGRITY: ${ran} of ${CHECKS.length} checks ran, no findings.`)
  } else {
    console.log(
      `  INTEGRITY: ${ran} of ${CHECKS.length} checks ran, ${findingRows} finding row(s) across ${checksWithFindings} check(s).`
    )
  }
  if (failed > 0) {
    console.log(`  ${failed} check(s) DID NOT RUN. Their result is unknown, not clean.`)
  }
  console.log(THIN)

  let title
  if (failed > 0) {
    title = `INTEGRITY CHECKS, ${ran} of ${CHECKS.length} ran, ${failed} FAILED`
  } else if (findingRows === 0) {
    title = `INTEGRITY CHECKS, ${ran} of ${CHECKS.length} ran, no findings`
  } else {
    title = `INTEGRITY CHECKS, ${ran} of ${CHECKS.length} ran, findings in ${checksWithFindings} check(s)`
  }

  return { failed, indexRow: { id: 0, title, rows: findingRows, alerts } }
}

// ---------------------------------------------------------------------------
// Dry run
//
// GYEMA_DISPATCH_DRY_RUN=1 prints every statement the report would send, each
// one first passed through assertReadOnlySql, then exits. It opens no
// connection and needs no credentials.
//
// Two uses. It proves the read only guard accepts exactly these fourteen
// statements and nothing else, and it hands over the statements themselves so
// they can be pasted into the Supabase SQL editor and the printed report
// checked against the database row by row.
// ---------------------------------------------------------------------------
// Statements the guard must reject, and a few it must accept, checked in the
// dry run so the guard demonstrates itself rather than being taken on trust.
//
// Note the deliberate conservatism: the multi statement check looks for a
// semicolon anywhere but the very end, so a SELECT carrying a semicolon
// inside a string literal would be refused too. That is a false refusal, not
// a false acceptance, and no statement in this file contains one.
const GUARD_PROBES = [
  { expect: "reject", sql: "update guest_jobs set status = 'delivered'" },
  { expect: "reject", sql: "delete from guest_jobs" },
  { expect: "reject", sql: "insert into guest_jobs (tracking_id) values ('GYM-000000')" },
  { expect: "reject", sql: "truncate guest_jobs" },
  { expect: "reject", sql: "grant select on guest_jobs to public" },
  { expect: "reject", sql: "do $$ begin end $$" },
  { expect: "reject", sql: "select 1; drop table guest_jobs" },
  { expect: "reject", sql: "select tracking_id from guest_jobs; update guest_jobs set status = 'x'" },
  { expect: "reject", sql: "with x as (update guest_jobs set status = 'x' returning 1) select * from x" },
  { expect: "reject", sql: "select tracking_id from guest_jobs for update" },
  { expect: "reject", sql: "select guest_stamp_delivery('GYM-000000', 'sender')" },
  { expect: "reject", sql: "select guest_bump_delivery_code_attempts('GYM-000000')" },
  { expect: "reject", sql: "select pg_read_file('/etc/passwd')" },
  {
    expect: "reject",
    sql: "select trim(pickup_area) from guest_jobs",
    note: "on record: section 0.1 uses the regex operator so the allowlist stays at seven. This probe fails loudly the day someone widens it without meaning to.",
  },
  {
    expect: "reject",
    sql: "select tracking_id from guest_jobs where status = 'delivered' and (delivery_confirmed_by is null or delivery_confirmed_by <> 'sender+courier_code')",
    note: "the real first draft of section 0.3, rejected on its first dry run: the matcher cannot tell 'and (' from a function call, so any parenthesised group after a boolean operator is refused. The fix was to rewrite the clause as 'is distinct from', which needs no parentheses and is exactly equivalent, not to add 'and' to the allowlist.",
  },
  {
    expect: "accept",
    sql: "select delivery_code_hash from guest_jobs",
    note: "the guard does not stop this one, the missing column grant does",
  },
  { expect: "accept", sql: "select tracking_id from guest_jobs where status = 'posted'" },
  { expect: "accept", sql: "select tracking_id from guest_jobs;" },
  {
    expect: "accept",
    sql: "select tracking_id from guest_jobs where pickup_area ~ '^\\s|\\s$'",
    note: "section 0.1: the regex match operator is not a call, so it needs no allowlist entry",
  },
  {
    expect: "accept",
    sql: "select tracking_id from guest_jobs where status is null or status not in ('posted', 'accepted')",
    note: "section 0.2: in( is already allowlisted as a keyword, not as a function",
  },
]

function runGuardSelfTest() {
  console.log("")
  console.log(THIN)
  console.log("  read only guard self test")
  console.log(THIN)
  let failures = 0
  for (const probe of GUARD_PROBES) {
    let accepted = true
    try {
      assertReadOnlySql(probe.sql)
    } catch {
      accepted = false
    }
    const actual = accepted ? "accept" : "reject"
    const ok = actual === probe.expect
    if (!ok) failures += 1
    const verdict = ok ? "ok  " : "FAIL"
    console.log(`  ${verdict}  expected ${probe.expect}, got ${actual}   ${probe.sql}`)
    if (probe.note) console.log(`          note: ${probe.note}`)
  }
  console.log("")
  console.log(`  ${GUARD_PROBES.length - failures} of ${GUARD_PROBES.length} probes behaved as expected.`)
  return failures
}

function dryRun() {
  const guardFailures = runGuardSelfTest()

  const statements = [
    { name: "preflight", sql: buildPreflightSql() },
    ...CHECKS.map((c) => ({ name: `check ${c.id}, ${c.title}`, sql: buildSql(c) })),
    ...SECTIONS.map((s) => ({ name: `section ${s.id}, ${s.title}`, sql: buildSql(s) })),
  ]

  console.log("")
  console.log(RULE)
  console.log("GYEMA DISPATCH READER, dry run")
  console.log(RULE)
  console.log("  No connection was opened and no credential was read.")
  console.log(`  ${statements.length} statements, each checked by the read only guard.`)
  console.log("")
  console.log("  Paste these into the Supabase SQL editor to check the report by hand.")
  console.log("  Ghana is UTC+0 year round, so current_date there matches the Africa/Accra")
  console.log("  session this script pins.")

  for (const s of statements) {
    console.log("")
    console.log(THIN)
    console.log(`  ${s.name}`)
    console.log(THIN)
    try {
      assertReadOnlySql(s.sql)
    } catch (err) {
      console.log(`  GUARD REJECTED THIS STATEMENT: ${err.message}`)
      return 1
    }
    console.log("  guard: accepted as a single read only SELECT")
    console.log("")
    for (const line of s.sql.split("\n")) console.log(`    ${line}`)
  }

  console.log("")
  console.log(RULE)
  if (guardFailures > 0) {
    console.log(`  DRY RUN FAILED: ${guardFailures} guard probe(s) did not behave as expected.`)
    console.log("")
    return 1
  }
  console.log("  End of dry run. Nothing was read and nothing was written.")
  console.log("")
  return 0
}

async function main() {
  if (process.env.GYEMA_DISPATCH_DRY_RUN === "1") {
    process.exit(dryRun())
  }

  const rawUrl = process.env.GYEMA_READER_DATABASE_URL
  if (!rawUrl) {
    console.error("")
    console.error("[dispatch-reader] GYEMA_READER_DATABASE_URL is not set.")
    console.error("")
    console.error("  Set it to the Session pooler URI from the Supabase dashboard under")
    console.error("  Connect, with the user swapped to gyema_reader.<project_ref> and the")
    console.error("  password generated when db/migrations/2026-08-18_dispatch_reader_role.sql")
    console.error("  was applied. Keep it in a gitignored .env.local or in the shell.")
    console.error("")
    process.exit(1)
  }

  const target = describeTarget(rawUrl)

  // TLS. Without a CA the connection is encrypted but the server certificate
  // is not verified, which defends against eavesdropping and not against an
  // active man in the middle. Point GYEMA_READER_CA_CERT at the Supabase CA
  // PEM to upgrade to full verification without editing this file.
  const caPath = process.env.GYEMA_READER_CA_CERT
  let ssl
  if (caPath) {
    ssl = { ca: readFileSync(caPath, "utf8"), rejectUnauthorized: true }
  } else {
    ssl = { rejectUnauthorized: false }
  }

  const client = new Client({ connectionString: rawUrl, ssl, application_name: "gyema-dispatch-reader" })

  try {
    await client.connect()
  } catch (err) {
    console.error("")
    console.error(`[dispatch-reader] could not connect to ${target.host}:${target.port} as ${target.user}`)
    console.error(`[dispatch-reader] ${err.message}`)
    console.error("")
    process.exit(1)
  }

  let exitCode = 0

  try {
    // Session settings, not writes. SET is permitted inside a read only
    // transaction. The read only characteristic is a third layer under the
    // role default and assertReadOnlySql.
    await client.query("set session characteristics as transaction read only")
    await client.query("set time zone 'Africa/Accra'")

    const { rows: stamp } = await runSelect(
      client,
      "select current_database() as db, current_user as who, current_setting('TimeZone') as tz, " +
        "to_char(now(), 'YYYY-MM-DD HH24:MI:SS') as now_txt, " +
        "current_setting('transaction_read_only') as read_only"
    )
    const meta = stamp[0]

    console.log("")
    console.log(RULE)
    console.log("GYEMA DISPATCH READER, guest rail operations brief")
    console.log(RULE)
    console.log(field("host", `${target.host}:${target.port}`))
    console.log(field("database", show(meta.db)))
    console.log(field("connected as", show(meta.who)))
    console.log(field("transaction", `read only = ${show(meta.read_only)}`))
    console.log(field("session timezone", show(meta.tz)))
    console.log(field("report time", show(meta.now_txt)))
    console.log("")
    console.log("  Read only. This report performs SELECT statements and nothing else.")
    console.log("  Confirm the host above is the intended project before acting on any line.")

    const { missing } = await preflight(client)
    if (missing.length > 0) {
      console.error("")
      console.error(RULE)
      console.error("PREFLIGHT FAILED, no section was run")
      console.error(RULE)
      console.error("")
      console.error("  These columns are required by the report and are not visible to this")
      console.error("  role. information_schema.columns is filtered by privilege, so each one")
      console.error("  is either absent from the schema or never granted to gyema_reader:")
      console.error("")
      for (const name of missing) console.error(`    ${name}`)
      console.error("")
      console.error("  Check the grants first:")
      console.error("")
      console.error("    select table_name, column_name, privilege_type")
      console.error("      from information_schema.column_privileges")
      console.error("     where grantee = 'gyema_reader'")
      console.error("     order by table_name, column_name;")
      console.error("")
      process.exit(1)
    }

    console.log("")
    console.log(
      `  Preflight passed: all ${REQUIRED_COLUMNS.guest_jobs.length + REQUIRED_COLUMNS.listings.length} required columns are readable.`
    )

    const counts = []

    // Section 0 first, and its index row first, because a data integrity
    // finding changes how every queue section below it reads.
    const integrity = await runIntegrity(client)
    counts.push(integrity.indexRow)
    if (integrity.failed > 0) exitCode = 2

    for (const section of SECTIONS) {
      let rows
      try {
        const result = await runSelect(client, buildSql(section))
        rows = result.rows
      } catch (err) {
        console.log("")
        console.log(RULE)
        console.log(`SECTION ${section.id}  ${section.title}`)
        console.log(RULE)
        console.log(`  QUERY FAILED: ${err.code ? `${err.code} ` : ""}${err.message}`)
        console.log("  This section is not reported. The others below still ran.")
        counts.push({ id: section.id, title: section.title, rows: "FAILED", alerts: 0 })
        exitCode = 2
        continue
      }

      printSectionHeading(section, rows.length)

      let alerts = 0
      if (rows.length === 0) {
        console.log("")
        console.log("  No rows.")
      } else {
        for (const row of rows) {
          alerts += printRow(section, row).flags.length
        }
      }

      if (section.footer && rows.length > 0) {
        console.log("")
        for (const line of section.footer(rows)) console.log(line)
      }

      counts.push({ id: section.id, title: section.title, rows: rows.length, alerts })
    }

    console.log("")
    console.log(RULE)
    console.log("INDEX, counts as printed above and from nothing else")
    console.log(RULE)
    for (const c of counts) {
      const flagged = c.alerts > 0 ? `  ${String(c.alerts).padStart(3)} flagged` : "             "
      console.log(`  ${String(c.id).padStart(2)}  ${String(c.rows).padStart(5)} rows${flagged}   ${c.title}`)
    }
    console.log("")
    console.log("  End of report. Nothing was written.")
    console.log("")
  } catch (err) {
    console.error("")
    console.error(`[dispatch-reader] ${err.message}`)
    console.error("")
    exitCode = 1
  } finally {
    await client.end().catch(() => {})
  }

  process.exit(exitCode)
}

// Run only when invoked directly, so the pure helpers below can be imported
// and checked without opening a connection or printing a report.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main()
}

// Exported for testing only. No application code imports this file.
export {
  maskPhone,
  humanAge,
  toAmount,
  describeEdgeWhitespace,
  assertReadOnlySql,
  buildSql,
  buildPreflightSql,
  runIntegrity,
  SECTIONS,
  CHECKS,
  REQUIRED_COLUMNS,
  DECLARED_GUEST_STATUSES,
}
