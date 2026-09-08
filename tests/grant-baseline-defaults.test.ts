import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"

// Section 1a of the grant baseline, and the honesty of what it claims.
//
// The two dispatch views were created after section 1 had revoked Supabase's
// default grants from every object that existed, so they inherited those
// grants and were readable with the public key. ALTER DEFAULT PRIVILEGES is
// the rule for the objects created later.

const sql = readFileSync("db/migrations/2026-09-07_grant_baseline.sql", "utf8")

/** The file with its comment lines removed: the statements it actually runs. */
const statements = sql
  .split(/\r?\n/)
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n")

describe("default privileges", () => {
  it("revokes the defaults for tables and sequences, for role postgres", () => {
    expect(statements).toContain(
      "alter default privileges for role postgres in schema public\n  revoke all on tables from anon, authenticated;"
    )
    expect(statements).toContain(
      "alter default privileges for role postgres in schema public\n  revoke all on sequences from anon, authenticated;"
    )
  })

  it("does NOT claim to cover functions, because the statement is a no-op", () => {
    // Measured on postgres 17: revoking EXECUTE on future functions from
    // PUBLIC records nothing in pg_default_acl and changes nothing about a
    // function created afterwards. A statement doing it would look protective
    // and protect nothing, so the file explains the gap instead of shipping
    // one. It quotes the statement inside a comment, which is the opposite of
    // running it, hence the comment stripping above.
    expect(statements).not.toContain("revoke all on functions")
    expect(statements).not.toContain("revoke execute on functions")
    expect(statements).not.toContain("revoke execute on routines")
    expect(sql).toContain("FUNCTIONS ARE NOT COVERED HERE")
    expect(sql).toContain("records nothing in pg_default_acl")
    // And it points at the control that does work.
    expect(sql).toContain("grant execute on function public.your_function(args) to service_role")
  })

  it("carries probes a person can run rather than only an ACL to read", () => {
    expect(sql).toContain("zzz_default_privilege_probe")
    expect(sql).toContain("zzz_probe")
  })

  it("still revokes from the objects that already exist", () => {
    // 1a is about the future. Section 1 is about the present, and losing it
    // would leave every current table exposed.
    expect(statements).toContain("revoke all privileges on public.%I from anon")
    expect(statements).toContain("revoke all privileges on public.%I from authenticated")
  })
})
