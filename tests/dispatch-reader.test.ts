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
