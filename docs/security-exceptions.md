# Security exceptions

Advisories that `npm run security` deliberately does not fail on. Each one is listed in `ACCEPTED` in `scripts/audit-gate.mjs`, accepted only at the single install path named here. The same advisory at any other path, and any other high or critical advisory, still fails the gate.

An entry in the script without an entry here is a bug. When an exit condition is met, remove both together; the gate prints "no longer reported, exception can be removed" when an accepted id stops appearing.

## next's pinned postcss 8.4.31

Recorded 8 Oct 2026, on `fix/deps-audit`, with `next` at 15.5.27.

| Advisory | Severity | Title | Gate |
| --- | --- | --- | --- |
| [GHSA-6g55-p6wh-862q](https://github.com/advisories/GHSA-6g55-p6wh-862q) | high | Arbitrary file read via attacker-controlled `sourceMappingURL` in CSS comments | accepted |
| [GHSA-r28c-9q8g-f849](https://github.com/advisories/GHSA-r28c-9q8g-f849) | high | Path traversal in previous source map auto-loading | accepted |
| [GHSA-fxqj-rqcc-2cmp](https://github.com/advisories/GHSA-fxqj-rqcc-2cmp) | moderate | Incomplete fix of GHSA-6g55-p6wh-862q | below the gate's threshold, listed for completeness |
| [GHSA-qx2v-qp2m-jg93](https://github.com/advisories/GHSA-qx2v-qp2m-jg93) | moderate | XSS via unescaped `</style>` in stringify output | below the gate's threshold, listed for completeness |

Accepted path: `node_modules/next/node_modules/postcss` only. The top-level `postcss` is 8.5.28 and is not affected.

### Why it is accepted

Every advisory above needs an attacker to control the CSS that postcss parses or stringifies. Here postcss only ever sees this repository's own CSS, at build time.

- Every module in `next/dist` that loads postcss sits under `next/dist/build/`: the webpack CSS config, the CSS loader, the font loader, `resolve-url-loader` and the CSS minimizer. Nothing under `next/dist/server/` or `next/dist/client/` loads it.
- `next.config.mjs` does not enable `experimental.optimizeCss`, the one option that brings CSS processing into request handling.
- The built output (`.next/server`, `.next/static`) contains no reference to postcss.
- The only CSS file in the repository is `app/globals.css`, processed through `@tailwindcss/postcss` (`postcss.config.mjs`). It has no `sourceMappingURL`. No user input reaches CSS processing anywhere in the app.

Checked by reading `node_modules/next/dist` at `next@15.5.27` on 8 Oct 2026. Re-check if `next.config.mjs` gains `optimizeCss`, or the app ever processes CSS it did not write.

### Exit condition

Remove this exception when either is true:

1. A `next` 15.5.x release pins a postcss that fixes both accepted advisories (8.5.18 or later covers both highs; 8.5.23 or later covers all four). Upgrade `next` and delete the entries.
2. The `next@16` migration lands.

Not taken: an `overrides` entry forcing next's postcss to 8.5.x. It goes against next's own exact pin and is untested by the next team.
