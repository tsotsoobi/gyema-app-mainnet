import { describe, it, expect } from "vitest"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { writeFileSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const run = promisify(execFile)

// The dispatch reader is a real process, so these tests run it as one. Every
// case here exits before any socket is opened: the connection string points at
// a host that does not resolve, and a test that reached the network would fail
// with a connection error instead of the refusal being asserted.
const SCRIPT = "scripts/dispatch-reader.mjs"
const UNROUTABLE = "postgres://gyema_reader:not-a-real-password@no-such-host.invalid:5432/postgres"

async function runReader(env: Record<string, string>) {
  try {
    const { stdout, stderr } = await run("node", [SCRIPT], {
      env: { ...process.env, ...env },
    })
    return { code: 0, stdout, stderr }
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string }
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" }
  }
}

describe("dispatch reader, TLS refusal", () => {
  it("refuses to run without a database URL", async () => {
    const res = await runReader({
      GYEMA_READER_DATABASE_URL: "",
      GYEMA_READER_CA_CERT: "",
      GYEMA_DISPATCH_DRY_RUN: "",
    })
    expect(res.code).toBe(1)
    expect(res.stderr).toContain("GYEMA_READER_DATABASE_URL is not set")
  })

  it("refuses to connect when GYEMA_READER_CA_CERT is unset", async () => {
    const res = await runReader({
      GYEMA_READER_DATABASE_URL: UNROUTABLE,
      GYEMA_READER_CA_CERT: "",
      GYEMA_DISPATCH_DRY_RUN: "",
    })
    expect(res.code).toBe(1)
    expect(res.stderr).toContain("GYEMA_READER_CA_CERT is not set")
    expect(res.stderr).toContain("will not open an unverified TLS connection")
    // The refusal happens before any connection is attempted.
    expect(res.stderr).not.toContain("could not connect")
  })

  it("refuses when the CA path does not exist", async () => {
    const res = await runReader({
      GYEMA_READER_DATABASE_URL: UNROUTABLE,
      GYEMA_READER_CA_CERT: join(tmpdir(), "gyema-no-such-ca.pem"),
      GYEMA_DISPATCH_DRY_RUN: "",
    })
    expect(res.code).toBe(1)
    expect(res.stderr).toContain("could not read GYEMA_READER_CA_CERT")
    expect(res.stderr).not.toContain("could not connect")
  })

  it("refuses a CA file that is not a certificate", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gyema-ca-"))
    const path = join(dir, "not-a-cert.pem")
    writeFileSync(path, "this is not a certificate\n", "utf8")
    const res = await runReader({
      GYEMA_READER_DATABASE_URL: UNROUTABLE,
      GYEMA_READER_CA_CERT: path,
      GYEMA_DISPATCH_DRY_RUN: "",
    })
    expect(res.code).toBe(1)
    expect(res.stderr).toContain("does not look like a PEM certificate")
    expect(res.stderr).not.toContain("could not connect")
  })

  it("there is no unverified fallback left in the source", async () => {
    const { readFileSync } = await import("node:fs")
    const source = readFileSync(SCRIPT, "utf8")
    // Exactly one setting of the option, and it is true. The prose above the
    // TLS block mentions the old fallback by name, so match the setting rather
    // than the word.
    const settings = source.match(/rejectUnauthorized:\s*(true|false)/g) ?? []
    expect(settings).toEqual(["rejectUnauthorized: true"])
  })
})

describe("dispatch reader, report shape", () => {
  it("dry run needs no credential and opens no connection", async () => {
    const res = await runReader({
      GYEMA_READER_DATABASE_URL: "",
      GYEMA_READER_CA_CERT: "",
      GYEMA_DISPATCH_DRY_RUN: "1",
    })
    expect(res.code).toBe(0)
    expect(res.stdout).toContain("No connection was opened and no credential was read.")
  })

  it("every generated statement reads a masked view, never a base table", async () => {
    const { SECTIONS, CHECKS, buildSql, buildPreflightSql } = await import(
      "../scripts/dispatch-reader.mjs"
    )
    const statements = [
      buildPreflightSql(),
      ...[...SECTIONS, ...CHECKS].map((s: { table: string }) => buildSql(s as never)),
    ]
    for (const sql of statements) {
      expect(sql).not.toMatch(/from public\.guest_jobs\b/)
      expect(sql).not.toMatch(/from public\.listings\b/)
      // The raw phone columns are unreachable to this role, so a statement
      // naming one would fail at the database. Catch it here instead.
      expect(sql).not.toMatch(/\bsender_phone\b(?!_masked)/)
      expect(sql).not.toMatch(/\brecipient_phone\b(?!_masked)/)
      expect(sql).not.toContain("delivery_code_hash")
    }
  })

  // The preflight only checks REQUIRED_COLUMNS. A section that names a column
  // missing from that list passes the preflight and then fails its own query
  // with 42703, which is reported, but softly, and only once it has run
  // against a database. This test closes that gap at commit time: every
  // identifier a section or check uses in its columns, where or order must be
  // either SQL vocabulary on the list below or a column REQUIRED_COLUMNS
  // declares for that section's own view.
  //
  // The vocabulary list is deliberately closed. A new SQL word in a section
  // fails here until it is added, the same intended friction as the read only
  // guard's call allowlist.
  const SQL_VOCABULARY = new Set([
    "and", "or", "not", "is", "null", "true", "false", "in", "distinct", "from",
    "asc", "desc", "interval", "current_date", "to_char", "extract", "epoch", "now",
  ])

  function identifiersOutsideRequired(
    section: { id: string | number; table: string; columns: string[]; where: string; order: string },
    required: Record<string, string[]>,
  ) {
    const view = section.table.replace(/^public\./, "")
    const known = new Set(required[view] ?? [])
    const text = [...section.columns, section.where, section.order]
      .join(" ")
      .replace(/'[^']*'/g, " ")
      .replace(/::\s*[a-z_][a-z0-9_]*/gi, " ")
      .replace(/\bas\s+[a-z_][a-z0-9_]*/gi, " ")
    const names = (text.match(/\b[a-z_][a-z0-9_]*\b/gi) ?? []).map((n) => n.toLowerCase())
    return [...new Set(names.filter((n) => !SQL_VOCABULARY.has(n) && !known.has(n)))]
  }

  it("every column a section or check uses is in REQUIRED_COLUMNS for its own view", async () => {
    const { SECTIONS, CHECKS, REQUIRED_COLUMNS } = await import("../scripts/dispatch-reader.mjs")
    for (const section of [...SECTIONS, ...CHECKS]) {
      const view = section.table.replace(/^public\./, "")
      expect((REQUIRED_COLUMNS as Record<string, string[]>)[view], `section ${section.id} reads ${section.table}`).toBeDefined()
      expect(identifiersOutsideRequired(section, REQUIRED_COLUMNS), `section ${section.id}`).toEqual([])
    }
  })

  it("that check catches a column the view does not declare", async () => {
    const { REQUIRED_COLUMNS } = await import("../scripts/dispatch-reader.mjs")
    const probe = {
      id: "probe",
      table: "public.guest_jobs_dispatch",
      columns: ["tracking_id", "to_char(remit_paid_at, 'YYYY-MM-DD') as remit_paid_at_txt", "remit_pi"],
      where: "status = 'delivered' and remit_rate is not null",
      order: "created_at asc",
    }
    expect(identifiersOutsideRequired(probe, REQUIRED_COLUMNS)).toEqual(["remit_pi", "remit_rate"])
    // And a guest column is not accepted on the listings view.
    const crossed = { ...probe, table: "public.listings_dispatch", columns: ["tracking_id"], where: "remit_cedis is null" }
    expect(identifiersOutsideRequired(crossed, REQUIRED_COLUMNS)).toEqual(["remit_cedis"])
  })

  it("the report can no longer mask a phone itself", async () => {
    const mod = await import("../scripts/dispatch-reader.mjs")
    expect("maskPhone" in mod).toBe(false)
  })

  it("the read only guard refuses a write dressed as a select", async () => {
    const { assertReadOnlySql } = await import("../scripts/dispatch-reader.mjs")
    expect(() => assertReadOnlySql("select guest_stamp_delivery('GYM-000000', 'sender')")).toThrow()
    expect(() => assertReadOnlySql("select tracking_id from guest_jobs_dispatch; update x set y = 1")).toThrow()
    expect(() => assertReadOnlySql("update guest_jobs set status = 'delivered'")).toThrow()
    expect(assertReadOnlySql("select tracking_id from guest_jobs_dispatch")).toBeTruthy()
  })
})

describe("dispatch reader, commission", () => {
  type Section = {
    id: string | number
    where: string
    columns: string[]
    footer?: (rows: Record<string, unknown>[]) => string[]
    render: (row: Record<string, unknown>) => { flags: string[]; fields: [string, string][] }
  }

  async function load() {
    const mod = await import("../scripts/dispatch-reader.mjs")
    // The .mjs sections are inferred as a union of object literals; the shape
    // this block reads from them is declared once, above.
    const all = [...mod.SECTIONS, ...mod.CHECKS] as unknown as Section[]
    const byId = (id: string | number) => {
      const s = all.find((x) => String(x.id) === String(id))
      if (!s) throw new Error(`no section ${id}`)
      return s
    }
    return { mod, byId }
  }

  it("the view carries remit_cedis and no other new remit column", async () => {
    const { mod } = await load()
    const guest: string[] = mod.REQUIRED_COLUMNS.guest_jobs_dispatch
    expect(guest).toContain("remit_cedis")
    for (const hidden of ["remit_pi", "remit_rate", "remit_method", "remit_ref"]) {
      expect(guest).not.toContain(hidden)
    }
  })

  it("sections 8 and 8b split one population on remit_cedis and nothing else", async () => {
    const { byId } = await load()
    const eight = byId(8).where
    const eightB = byId("8b").where
    expect(eight).toBe("status = 'delivered' and remit_paid_at is null and remit_cedis is not null")
    expect(eightB).toBe("status = 'delivered' and remit_paid_at is null and remit_cedis is null")
  })

  it("section 8 totals the commission, not the quote", async () => {
    const { byId } = await load()
    const lines = byId(8).footer!([
      { remit_cedis: "3.00", quote_cedis: "40.00" },
      { remit_cedis: "5.50", quote_cedis: "70.00" },
    ])
    expect(lines[0]).toBe("  remit_cedis total over 2 of 2 rows: 8.50")
    expect(lines.join("\n")).not.toContain("110.00")
  })

  it("check 0.4 totals the commission and counts a missing one apart", async () => {
    const { byId } = await load()
    const lines = byId("0.4").footer!([
      { remit_cedis: "3.00", quote_cedis: "40.00" },
      { remit_cedis: null, quote_cedis: "50.00" },
    ])
    expect(lines[0]).toBe("  remit_cedis total over 1 of 2 rows: 3.00")
    expect(lines).toContain("  1 row(s) carried no usable remit_cedis and are excluded from that total")
  })

  it("section 8b never prints a cedi total", async () => {
    const { byId } = await load()
    const lines = byId("8b").footer!([
      { quote_cedis: "40.00", created_after_window: false, stamped_before_window: true },
      { quote_cedis: "50.00", created_after_window: true, stamped_before_window: null },
      { quote_cedis: "70.00", created_after_window: false, stamped_before_window: null },
    ])
    const text = lines.join("\n")
    expect(text).not.toContain("total over")
    for (const amount of ["40.00", "50.00", "70.00", "90.00", "120.00", "160.00"]) {
      expect(text).not.toContain(amount)
    }
    expect(lines).toContain("  No cedi total is printed for this section, by design.")
  })

  it("section 8b places each row against the window, and only strict true is evidence", async () => {
    const { mod, byId } = await load()
    const era = mod.commissionEra
    expect(era({ created_after_window: false, stamped_before_window: true })).toBe("pre_change")
    expect(era({ created_after_window: true, stamped_before_window: null })).toBe("data_gap")
    expect(era({ created_after_window: false, stamped_before_window: null })).toBe("cannot_tell")
    expect(era({ created_after_window: null, stamped_before_window: null })).toBe("cannot_tell")
    expect(era({ created_after_window: true, stamped_before_window: true })).toBe("inconsistent")

    // A pre-change or undecidable row is listed without an alert; a data gap is flagged.
    const render = byId("8b").render
    expect(render({ created_after_window: false, stamped_before_window: true }).flags).toEqual([])
    expect(render({ created_after_window: null, stamped_before_window: null }).flags).toEqual([])
    expect(render({ created_after_window: true, stamped_before_window: null }).flags[0]).toMatch(/^DATA GAP/)
  })

  it("the window bounds are the deployment records widened by one hour outward", async () => {
    const { mod, byId } = await load()
    expect(mod.COMMISSION_SHIPPED_EARLIEST).toBe("2026-09-14 15:48:36+00")
    expect(mod.COMMISSION_SHIPPED_LATEST).toBe("2026-09-15 01:51:41+00")
    // Testnet deployment 6441956927 less one hour, Mainnet 6449391484 plus one hour.
    const hour = 3600 * 1000
    expect(Date.parse("2026-09-14T16:48:36Z") - Date.parse(mod.COMMISSION_SHIPPED_EARLIEST.replace(" ", "T").replace("+00", "Z"))).toBe(hour)
    expect(Date.parse(mod.COMMISSION_SHIPPED_LATEST.replace(" ", "T").replace("+00", "Z")) - Date.parse("2026-09-15T00:51:41Z")).toBe(hour)
    // Check 0.5 filters on the later bound, never the earlier one.
    expect(byId("0.5").where).toContain(`created_at >= '${mod.COMMISSION_SHIPPED_LATEST}'::timestamptz`)
    expect(byId("0.5").where).not.toContain(mod.COMMISSION_SHIPPED_EARLIEST)
  })
})
