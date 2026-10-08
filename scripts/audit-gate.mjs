// ===========================================================================
// The npm audit half of `npm run security`
// ===========================================================================
//
// Runs `npm audit --omit=dev --json` and fails on any high or critical
// advisory, exactly as `npm audit --omit=dev --audit-level=high` did, with one
// difference: the advisories named in ACCEPTED below are ignored, and only at
// the one install path they were accepted for.
//
// npm audit has no way to ignore a single advisory, which is the only reason
// this file exists. Every accepted advisory is recorded, with its reason and
// its exit condition, in docs/security-exceptions.md. An entry here without an
// entry there is a bug.
//
// FAILS CLOSED. Output that is not JSON, an audit that reports its own error,
// or a report with no vulnerabilities object exits 1. A gate that could not
// read the audit must never read as a gate that found nothing.
//
// Exit codes: 0 clean, 1 anything that should stop a merge.

import { execSync } from "node:child_process"
import { fileURLToPath } from "node:url"

// Severities that fail the gate. Matches --audit-level=high.
const FAILING = new Set(["high", "critical"])

// Advisory id -> the only node_modules path at which it is accepted.
//
// Both are next's own pinned copy of postcss (next 15.5.x pins postcss
// 8.4.31 exactly). It runs at build time only, over this repository's own CSS.
// The same advisory anywhere else, including a top level postcss, still fails.
const ACCEPTED = new Map([
  ["GHSA-6g55-p6wh-862q", "node_modules/next/node_modules/postcss"],
  ["GHSA-r28c-9q8g-f849", "node_modules/next/node_modules/postcss"],
])

/** The GHSA id from an advisory URL, or null. */
function advisoryId(url) {
  const match = typeof url === "string" ? url.match(/GHSA(-[a-z0-9]{4}){3}/) : null
  return match ? match[0] : null
}

/**
 * Judge an `npm audit --json` report.
 *
 * Returns { ok, failures, accepted, stale }. failures and accepted are lists
 * of "id package severity" lines. stale lists ACCEPTED ids the report no longer
 * carries, which means an exception can be removed. stale never fails the gate.
 */
export function evaluate(report, accepted = ACCEPTED) {
  if (!report || typeof report !== "object" || report.error) {
    return { ok: false, failures: ["unreadable audit report"], accepted: [], stale: [] }
  }
  const vulns = report.vulnerabilities
  if (!vulns || typeof vulns !== "object") {
    return { ok: false, failures: ["audit report has no vulnerabilities object"], accepted: [], stale: [] }
  }

  const failures = []
  const acceptedHits = []
  const seen = new Set()

  for (const [name, vuln] of Object.entries(vulns)) {
    // A via entry that is a string names another package whose own entry
    // carries the advisory. It is judged there, so it is skipped here.
    for (const via of vuln.via ?? []) {
      if (typeof via !== "object" || via === null) continue
      if (!FAILING.has(via.severity)) continue

      const id = advisoryId(via.url)
      const line = `${id ?? via.url ?? "unknown"} ${name} ${via.severity}`
      if (id) seen.add(id)

      const allowedPath = id ? accepted.get(id) : undefined
      const nodes = Array.isArray(vuln.nodes) ? vuln.nodes : []
      const onlyAtAllowedPath =
        allowedPath !== undefined && nodes.length > 0 && nodes.every((n) => n === allowedPath)

      if (onlyAtAllowedPath) acceptedHits.push(line)
      else failures.push(line)
    }
  }

  const stale = [...accepted.keys()].filter((id) => !seen.has(id))
  return { ok: failures.length === 0, failures, accepted: acceptedHits, stale }
}

function runAudit() {
  // npm audit exits non-zero whenever it finds anything, so the report is
  // read from stdout whatever the exit code was.
  try {
    return execSync("npm audit --omit=dev --json", { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
  } catch (err) {
    return err.stdout ?? ""
  }
}

function main() {
  let report
  try {
    report = JSON.parse(runAudit())
  } catch {
    report = null
  }
  const result = evaluate(report)

  for (const line of result.accepted) console.log(`[audit-gate] accepted (docs/security-exceptions.md): ${line}`)
  for (const id of result.stale) console.log(`[audit-gate] no longer reported, exception can be removed: ${id}`)
  for (const line of result.failures) console.error(`[audit-gate] FAIL: ${line}`)

  if (!result.ok) {
    console.error("[audit-gate] high or critical advisories outside the recorded exceptions.")
    process.exit(1)
  }
  console.log("[audit-gate] no high or critical advisories outside the recorded exceptions.")
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main()
}
