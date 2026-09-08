import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

// Phase 3, log redaction: no phone number, token, code or request body in any
// log line. Vercel keeps function logs, a screenshot keeps a browser console,
// and a support chat keeps both.
//
// This is a source sweep rather than a runtime capture: the failure it guards
// against is somebody adding console.log(body) while debugging and leaving it,
// which is visible in the text and invisible at runtime until the day it
// matters.

function filesUnder(dir: string, name: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) return filesUnder(full, name)
    return entry === name ? [full.replace(/\\/g, "/")] : []
  })
}

const routeFiles = filesUnder("app/api", "route.ts")
const libFiles = readdirSync("lib")
  .filter((f) => f.endsWith(".ts"))
  .map((f) => `lib/${f}`)

/** Every console.* call in a file, as source text. */
function logCalls(source: string): string[] {
  return source.match(/console\.(log|warn|error|info|debug)\([^\n]*/g) ?? []
}

/**
 * The same call with its string literals blanked, so a check for a VARIABLE
 * named last4 is not tripped by a log prefix that reads "[last4-guard]".
 * The literal checks below run on the original text instead.
 */
function withoutStrings(call: string): string {
  return call
    .replace(/"[^"]*"/g, '""')
    .replace(/'[^']*'/g, "''")
    .replace(/`[^`]*`/g, "``")
}

describe("no log line carries a secret or a body", () => {
  for (const file of [...routeFiles, ...libFiles]) {
    it(`${file}`, () => {
      const source = readFileSync(file, "utf8")
      for (const raw of logCalls(source)) {
        const call = withoutStrings(raw)
        // The whole request body, under any of its usual names.
        expect(call, `${file}: logs a body`).not.toMatch(/console\.\w+\([^)]*\b(body|payload|req\.body)\b\s*[,)]/)
        // Credentials and the two four digit secrets.
        expect(call, `${file}: logs a token`).not.toMatch(/\baccessToken\b/)
        expect(call, `${file}: logs a service key`).not.toMatch(/SERVICE_ROLE_KEY|serviceRoleKey|apiKey|PI_API_KEY\s*\)/)
        expect(call, `${file}: logs a salt`).not.toMatch(/\bsalt\b/)
        expect(call, `${file}: logs a last-4`).not.toMatch(/\blast4\b/)
        expect(call, `${file}: logs a delivery code`).not.toMatch(/\bdeliveryCode\b|\bcodeFromHash\b/)
        expect(call, `${file}: logs a code`).not.toMatch(/console\.\w+\([^)]*,\s*code\s*[,)]/)
        // Phone numbers, under the names this schema uses.
        expect(call, `${file}: logs a phone`).not.toMatch(/sender_phone|recipient_phone|senderPhone|recipientPhone|whatsapp/i)
        // A literal that looks like a Ghanaian number. This one is about the
        // string rather than the variable, so it reads the raw call.
        expect(raw, `${file}: logs a phone literal`).not.toMatch(/0\d{9}|\+233\d{9}/)
      }
    })
  }
})

describe("what the logs are allowed to say", () => {
  it("auth/verify logs an eight character prefix, never a whole identifier", () => {
    const source = readFileSync("app/api/auth/verify/route.ts", "utf8")
    expect(source).toContain("function shortId(id: string): string")
    expect(source).toContain("id.slice(0, 8)")
    // Every pi_uid in a log line goes through it.
    for (const call of logCalls(source)) {
      if (/pi_uid/.test(call)) {
        expect(call).toMatch(/shortId\(/)
      }
    }
  })

  it("the payment routes log an identifier and a txid, which are not secrets", () => {
    // A Pi payment id and a Stellar transaction hash are public references and
    // are what makes a payment traceable afterwards. Named here so the sweep
    // above reads as deliberate rather than as having missed them.
    const complete = readFileSync("app/api/payments/complete/route.ts", "utf8")
    expect(complete).toContain('console.log("[gyema] Payment completed:", paymentId, "txid:", txid')
  })

  it("upstream error text goes to the log and not to the caller", () => {
    for (const file of [
      "app/api/payments/approve/route.ts",
      "app/api/payments/complete/route.ts",
    ]) {
      const source = readFileSync(file, "utf8")
      expect(source).toContain("console.error")
      expect(source).toContain("errorText")
      // The response carries a reason, never the upstream body.
      expect(source).not.toMatch(/NextResponse\.json\([^)]*errorText/)
      expect(source).not.toMatch(/details:/)
    }
  })
})
