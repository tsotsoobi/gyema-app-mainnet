import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"

// public.mask_phone_head_only lives in SQL, so this file cannot execute it:
// there is no database in the harness and no test here opens a connection.
//
// What it can do, and does, is two things that are still worth having:
//
//   1. Assert structural properties of the real function text in
//      db/migrations/2026-09-07_dispatch_reader_masked_view.sql. These catch
//      the specific way this function could be broken by a later edit, which
//      is someone reaching for the tail again.
//
//   2. Pin the contract on a mirror implementation of the same rules, so the
//      intended behaviour is written down as executable examples rather than
//      as prose.
//
// The mirror is NOT authority. The deployed function is only proved by running
// section 8(d) of the migration against each project:
//
//   select public.mask_phone_head_only('0244123456');   -- 024*** (10 digits)
//
// If the mirror and the deployed function ever disagree, the deployed function
// is what the report prints, and this file is the thing that is wrong.

const MIGRATION = "db/migrations/2026-09-07_dispatch_reader_masked_view.sql"
const sql = readFileSync(MIGRATION, "utf8")

/** Mirror of the SQL rules. See the caveat above: this is documentation, not proof. */
function maskHeadOnly(raw: string | null): string {
  if (raw === null) return "(null in, null out)"
  const digits = raw.replace(/[^0-9]/g, "")
  if (digits.length === 0) return "(none)"
  if (digits.length < 4) return `(unusable, ${digits.length} digits)`
  // Below eight digits the head and the guard overlap, so show no digits.
  if (digits.length < 8) return `(short, ${digits.length} digits)`
  return `${digits.slice(0, 3)}${"*".repeat(Math.max(digits.length - 3, 0))} (${digits.length} digits)`
}

describe("mask_phone_head_only, the deployed function text", () => {
  it("is defined once, immutable and strict, with a pinned search_path", () => {
    expect(sql).toContain("create or replace function public.mask_phone_head_only(raw text)")
    expect(sql).toContain("immutable")
    expect(sql).toContain("strict")
    expect(sql).toContain("set search_path = pg_catalog, pg_temp")
  })

  it("takes the head of the digits and never the tail", () => {
    const body = sql.slice(
      sql.indexOf("create or replace function public.mask_phone_head_only"),
      sql.indexOf("comment on function public.mask_phone_head_only")
    )
    expect(body).toContain("left(regexp_replace(raw, '[^0-9]', '', 'g'), 3)")
    // The ways a tail could come back. None of them may appear.
    expect(body).not.toMatch(/\bright\s*\(/)
    expect(body).not.toMatch(/\bsubstring\s*\(/)
    expect(body).not.toMatch(/\bsubstr\s*\(/)
    expect(body).not.toMatch(/-\s*4\b/)
  })

  it("is not security definer, because it needs no privileges of its own", () => {
    const body = sql.slice(
      sql.indexOf("create or replace function public.mask_phone_head_only"),
      sql.indexOf("comment on function public.mask_phone_head_only")
    )
    expect(body).not.toContain("security definer")
  })

  it("is the only thing the views expose a phone through", () => {
    const view = sql.slice(
      sql.indexOf("create view public.guest_jobs_dispatch"),
      sql.indexOf("comment on view public.guest_jobs_dispatch")
    )
    expect(view).toContain("public.mask_phone_head_only(sender_phone)    as sender_phone_masked")
    expect(view).toContain("public.mask_phone_head_only(recipient_phone) as recipient_phone_masked")
    // No bare phone column survives into the view's column list.
    expect(view).not.toMatch(/^\s+sender_phone,\s*$/m)
    expect(view).not.toMatch(/^\s+recipient_phone,\s*$/m)
  })

  it("takes the base tables away from the reader role", () => {
    expect(sql).toContain("revoke all on public.guest_jobs from gyema_reader")
    expect(sql).toContain("revoke all on public.listings   from gyema_reader")
    expect(sql).toContain("grant select on public.guest_jobs_dispatch to gyema_reader")
  })

  it("takes the Supabase defaults off both views in the file that creates them", () => {
    // Found live on Testnet, 7 September: the views are created after the
    // grant baseline has revoked the defaults from everything else, so they
    // were born with anon and authenticated holding everything on them. PUBLIC
    // is named too, because a grant to PUBLIC is inherited by anon and
    // revoking from anon alone leaves it in place.
    expect(sql).toContain(
      "revoke all on public.guest_jobs_dispatch from anon, authenticated, public;"
    )
    expect(sql).toContain(
      "revoke all on public.listings_dispatch   from anon, authenticated, public;"
    )
    // And they come before the grant to the reader, not after it.
    expect(sql.indexOf("revoke all on public.guest_jobs_dispatch from anon"))
      .toBeLessThan(sql.indexOf("grant select on public.guest_jobs_dispatch to gyema_reader"))
  })

  it("bounds the role and caps the rows", () => {
    expect(sql).toContain("alter role gyema_reader set statement_timeout = '10s'")
    expect(sql).toContain("alter role gyema_reader set idle_in_transaction_session_timeout = '30s'")
    expect(sql).toContain("alter role gyema_reader set default_transaction_read_only = on")
    // One cap per view.
    expect(sql.match(/limit 2000;/g) ?? []).toHaveLength(2)
  })
})

describe("mask_phone_head_only, the contract", () => {
  const cases: Array<[string, string]> = [
    ["0244123456", "024******* (10 digits)"],
    ["+233 24 412 3456", "233********* (12 digits)"],
    ["024-412-3456", "024******* (10 digits)"],
    ["", "(none)"],
    ["   ", "(none)"],
    ["no digits here", "(none)"],
    ["12", "(unusable, 2 digits)"],
    ["123", "(unusable, 3 digits)"],
    ["1234", "(short, 4 digits)"],
    ["1234567", "(short, 7 digits)"],
    ["12345678", "123***** (8 digits)"],
  ]

  for (const [input, expected] of cases) {
    it(`masks ${JSON.stringify(input)} as ${JSON.stringify(expected)}`, () => {
      expect(maskHeadOnly(input)).toBe(expected)
    })
  }

  // The property that matters, stated as a property rather than as examples.
  it("never emits the last four digits of any input", () => {
    const inputs = [
      "0244123456",
      "+233244123456",
      "0201234567",
      "0559876543",
      "233 55 000 1111",
      "0000",
      "00000000",
      "1234",
      "1234567",
    ]
    for (const input of inputs) {
      const digits = input.replace(/[^0-9]/g, "")
      const masked = maskHeadOnly(input)
      const last4 = digits.slice(-4)
      // The digit count is allowed to appear, so compare against the masked
      // value with its trailing "(n digits)" annotation removed.
      const maskedBody = masked.replace(/\s*\(\d+ digits\)$/, "")
      expect(maskedBody).not.toContain(last4)
    }
  })

  it("leaks at most three digits, wherever the number came from", () => {
    for (const input of ["0244123456", "+233244123456", "0201234567"]) {
      const masked = maskHeadOnly(input).replace(/\s*\(\d+ digits\)$/, "")
      const visible = masked.replace(/[^0-9]/g, "")
      expect(visible.length).toBeLessThanOrEqual(3)
    }
  })
})
