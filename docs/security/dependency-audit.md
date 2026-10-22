# Dependency advisories — the standing register

> AGPL-3.0-or-later | Bos Computing LLC | Last reviewed: 2026-10-22

`pnpm audit --audit-level=high` runs as a blocking step in CI
(`.github/workflows/ci.yml`, `.github/workflows/security.yml`). `pnpm.auditConfig` in
the root `package.json` can carry advisory ids but not reasons. This document is the
reason column, and it is standing — not a dated report. The **Suppressed advisories**
table below must match `pnpm.auditConfig` exactly, id for id, at all times.

**The rule in one line:** a version floor in `pnpm.overrides` before a suppression, and
never an id in `pnpm.auditConfig` without a row here.

## Policy

1. **CI blocks on high/critical.** `pnpm audit --audit-level=high` fails the pipeline if
   unresolved high or critical advisories exist.

2. **Fix before suppressing.** If a patched version exists in a compatible range, raise
   the floor in `pnpm.overrides` — including for transitive packages, which pnpm will
   honour even against a dependency's declared range. Suppression is the last resort.

3. **Accepted risks require documentation.** Any advisory that cannot be resolved needs a
   row in **Suppressed advisories** with: id, affected package and dependency path,
   severity, why it is not reachable in Eco, and a re-check date.

4. **Suppression is reserved for unreachable code.** Advisories below the CI gate
   (moderate, low) may stay visible in audit output so upstream changes get noticed;
   suppress only when the noise outlives its usefulness and the path is confirmed
   unreachable.

5. **Quarterly review.** All accepted risks are re-evaluated quarterly. If a patch
   becomes available it must be applied and the row moved to **Closed**.
   **Next review: 2026-12-15.**

6. **Override hygiene.** `pnpm.overrides` entries should be removed when the direct
   dependency updates to include the fix. Verify with `pnpm why <package>`.

### Note on `--prod` flagging dev-only dependencies

`better-auth` declares `vitest` and `drizzle-kit` as optional peer dependencies. When
those packages are also present in `devDependencies`, pnpm resolves them and follows
their transitive trees during `--prod` audits. Several advisories below are flagged
because of that mechanism, not because the vulnerable code ships to production.

## Suppressed advisories

Must equal `pnpm.auditConfig` in the root `package.json`.

| Id | Package (path) | Severity | Why it does not apply | Re-check |
| --- | --- | --- | --- | --- |
| `GHSA-67mh-4wv8-2f99` | `esbuild@0.18.20` (`apps/api > drizzle-kit > @esbuild-kit/esm-loader > @esbuild-kit/core-utils > esbuild`) | moderate | Any website can send requests to a running esbuild **dev server** and read the response. `drizzle-kit` bundles this old esbuild for its own loader and never starts a dev server; `drizzle-kit` is itself a dev-only CLI (`db:generate`, `db:push`) that never ships, and `@esbuild-kit` is archived and unmaintained. Checked 2026-09-16: `drizzle-kit@0.31.10`, the newest 0.31.x, still depends on `@esbuild-kit/esm-loader`; only the `1.0.0-rc` line drops it, so there is no non-major fix. | 2026-12-15, or when `drizzle-kit` ships a stable release without `@esbuild-kit` |
| `GHSA-vfj7-8cjw-p6xm` / `CVE-2026-93687` | `braces@3.0.3` (`packages/config > @next/eslint-plugin-next > fast-glob@3.3.1 > micromatch > braces`) | high | A glob pattern with deeply nested braces exhausts the stack. **No patched version at any release** (`patched: <0.0.0`), and 3.0.3 is the newest `braces`. The only path is the Next.js ESLint plugin, a dev dependency of the lint config: it expands glob patterns built from this repo's own config and directory names while linting, never input from a request or a user. Nothing in the web bundle or the api runtime resolves `braces` (`pnpm why -r braces`). Checked 2026-10-22: `@next/eslint-plugin-next@16.4.2`, the newest, still pins `fast-glob@3.3.1`, so a plugin bump would not clear it. | 2026-12-15, or when `braces` publishes a fix or the plugin drops `fast-glob` |

## Known open, not suppressed

Below the CI gate (moderate, low), left visible so upstream fixes get noticed. Checked
2026-10-22.

| Id | Package (path) | Severity | Status |
| --- | --- | --- | --- |
| `GHSA-qxg6-89mg-rqv8` / `CVE-2026-112949`, `GHSA-xp26-3454-mjgp` / `CVE-2026-112950` | `@vitest/mocker@4.1.11` (`vitest`) | moderate | Mock-registration code injection and a Windows-only redirect traversal. Patched in `>=4.1.12`. Test-time only — the mocker is not part of any build or runtime output. A vitest bump, not an override, since `vitest` and `@vitest/mocker` move together. |
| `GHSA-jggr-w7fw-pc2j` | `fast-copy@4.0.2` (`apps/api > pino-pretty > fast-copy`) | moderate | Stack exhaustion copying deeply nested values. Patched in `>=4.1.0`. `pino-pretty` formats local dev logs; production logs are plain JSON. |
| `GHSA-hp3w-g68c-fv3c` / `CVE-2026-97058` | `sprintf-js@1.1.3` (`apps/web > @huggingface/transformers > onnxruntime-node > global-agent > roarr > sprintf-js`) | moderate | Unbounded precision in a format string. **No patched version.** Same never-loaded `onnxruntime-node` path as the adm-zip rows under **Closed**. |
| `GHSA-238p-pmpm-9mq7` / `CVE-2026-103923` | `katex@0.16.47` (`apps/web > katex`) | low | Lets an already-present prototype pollution bypass KaTeX's trust option. Patched in `>=0.18.2`; Dependabot #413 is the bump, held for before/after math rendering screenshots. |

## Closed

**2026-10-22 — new high advisories closed by version floors, two suppressions
removed.** New advisories in `adm-zip` (4 high, 2 moderate), `brace-expansion` (2 high
and 1 moderate, each in both the 1.x and 5.x lines), `sharp` (1 high, librsvg),
`source-map-js` (1 high) and `vite` (1 high, 3 moderate, 1 low, all in Vite's dev server
and `launch-editor`) each had a patched release, so each got a floor (see the table
below). `adm-zip@0.6.1` is also outside the two advisories that had been suppressed:
`CVE-2026-39244` / `GHSA-xcpc-8h2w-3j85` (fixed in 0.6.0) and `GHSA-vwc7-r8mq-g2x9` /
`CVE-2026-76845` (GitHub now lists the range as `>=0.5.9 <=0.6.0` and still records no
patched version; checked 2026-10-22). Both had been suppressed as unreachable (`onnxruntime-node` is installed with
`@huggingface/transformers` but never loaded; its only `adm-zip` use is its install
script's optional CUDA download on Linux). Removing both ids and re-running
`pnpm audit` showed neither, so they left `pnpm.auditConfig`. The override crosses
`onnxruntime-node`'s declared `adm-zip: ^0.5.16`, which pnpm permits.

**2026-10-22 — `GHSA-82fw-gwwq-j7x9` / `CVE-2026-84373` (vitest mocker path
traversal) closed by the vitest 4 upgrade**; the repo resolves `vitest@4.1.11`.

**2026-09-16 — expr-eval, two high advisories, closed by replacement.**
`CVE-2025-13204` / `GHSA-8gw3-rxh4-v6jx` (prototype pollution) and `CVE-2025-12735` /
`GHSA-jc85-fpwf-qm7x` (`evaluate()` does not restrict callable functions) had no patched
release of `expr-eval` and were suppressed from before 2026-08-28. The calculator
(`apps/web/src/lib/calculator.ts`) now uses `expr-eval-fork@3.0.3` (MIT,
[jorenbroekema/expr-eval](https://github.com/jorenbroekema/expr-eval)), which GitHub's
advisory database lists as patched for both — first patched 2.0.2 for
`GHSA-8gw3-rxh4-v6jx`, 3.0.1 for `GHSA-jc85-fpwf-qm7x`. Both CVEs were removed from
`ignoreCves`.

**2026-09-16 — two suppressions removed as inert.** Verified by removing them and
re-running `pnpm audit`: no ids appeared. `GHSA-gv7w-rqvm-qjhr` (esbuild) was
**withdrawn upstream** by GitHub — the 2026-08-28 review recorded it as covering
CVE-2026-47429, which it does not. `CVE-2026-47429` (vitest UI server arbitrary file
read) is fixed in `vitest@3.2.6`, the version this repo resolves.

**Resolved by a floor in `pnpm.overrides`.** The override entries themselves are the
record; this is the index.

| Advisory | Package | Override |
|---|---|---|
| `GHSA-rgj7-g3m4-5g8c` (2026-09-16), `GHSA-wq5f-xc86-pv6w` (2026-10-22) | sharp | `"sharp": ">=0.35.5"` |
| `GHSA-2883-xcg3-v3hh` | js-yaml | `"js-yaml": ">=4.3.2 <5"` (2026-09-16) |
| `GHSA-gqvv-2mrq-wpjv`, `GHSA-g6gw-c38x-mqfc`, `GHSA-crvj-82cr-hjcx` | hono | `"hono": ">=4.13.5"` + `apps/api` dep `^4.13.5` (2026-09-16) |
| `GHSA-w5hq-g745-h8pq` / `CVE-2026-41907` | uuid | `"uuid@<11.1.1": "11.1.1"` (2026-09-16) |
| `GHSA-2g4f-4pwh-qvx6` / `CVE-2025-69873` | ajv | `"ajv@<6.14.0": "6.14.0"` (2026-09-16) |
| `GHSA-p498-v437-472g` | @humanfs/node | `"@humanfs/node@<0.16.8": "0.16.8"` (2026-09-16) |
| `GHSA-g7r4-m6w7-qqqr` | esbuild | `"esbuild@>=0.27.0 <0.28.1": "0.28.1"` (2026-09-16) |
| `GHSA-3ppc-4f35-3m26`, `GHSA-7r86-cg39-jmmj`, `GHSA-23c5-xmqv-rm74` | minimatch | `"minimatch@<3.1.4": "3.1.4"`, `"minimatch@>=9.0.0 <9.0.7": "9.0.7"` |
| `GHSA-25h7-pfq9-p65f` | flatted | `"flatted": ">=3.4.0"` |
| `GHSA-8gc5-j5rx-235r` | fast-xml-parser | `"fast-xml-parser": ">=5.5.6"` |
| `GHSA-7q85-xj36-vmfc`, `GHSA-8238-w5pm-2374`, `GHSA-j5f4-cc29-5x44`, `GHSA-rcw4-f5rp-g42v`, `GHSA-c6fg-446q-cg94`, `GHSA-p634-w6r4-rjp2`, `GHSA-xcpc-8h2w-3j85`, `GHSA-vwc7-r8mq-g2x9` | adm-zip | `"adm-zip@<0.6.1": "0.6.1"` (2026-10-22) |
| `GHSA-6j4f-fj2g-mc7p`, `GHSA-qhr7-859c-m2p7`, `GHSA-q2hr-2g5m-vwhr` | brace-expansion | `"brace-expansion@<1.1.21": "1.1.21"`, `"brace-expansion@>=4.0.0 <5.0.12": "5.0.12"` (2026-10-22) |
| `GHSA-68fv-2mgg-jv7q` | source-map-js | `"source-map-js@>=1.0.0 <1.2.2": "1.2.2"` (2026-10-22) |
| `GHSA-587h-7wmj-h5pm`, `GHSA-698v-4r3x-3vcv`, `GHSA-r825-w8mm-5pxw`, `GHSA-rq7h-c2jc-7f22`, `GHSA-9jrq-w75r-8gcw` | vite | `"vite": "6.4.5"` (2026-10-22) |

## History

### 2026-10-22 — advisory sweep

`pnpm audit` went from **35 findings (3 low, 18 moderate, 14 high; 3 of them ignored)** to
**9 findings (1 low, 7 moderate, 1 high; 2 ignored, the high among them)**, and
`pnpm audit --audit-level=high` exits 0 again. Five floors were raised or
added (adm-zip, brace-expansion, sharp, source-map-js, vite), the two adm-zip
suppressions became inert and were removed, and `braces` (no fix at any release,
lint tooling only) was suppressed. `pnpm.auditConfig` went from three ids to two.

### 2026-09-16 — advisory sweep

`pnpm audit` went from **19 findings (1 low, 13 moderate, 5 high, 3 ignored)** to
**8 findings (7 moderate, 1 high, all high ignored)**. Seven advisories were closed by
raising override floors, two by the expr-eval replacement, and two stale suppressions
were removed. `pnpm.auditConfig` went from five ids to three. Only `GHSA-82fw-gwwq-j7x9`
(vitest) remains visible and unignored.

### 2026-08-28 — first structured review

Six advisories appeared in `pnpm audit --prod`, plus dev-only findings. Condensed, with
the reachability calls that still stand:

- **adm-zip** (`GHSA-xcpc-8h2w-3j85`) — classified dead code and suppressed at this
  review. Closed 2026-10-22 by the `adm-zip@0.6.1` floor.
- **esbuild 0.18.20 dev-server CORS** (`GHSA-67mh-4wv8-2f99`) — build-tool only, left
  visible because it sits below the CI gate. Suppressed on 2026-09-16 once it was clear
  no non-major `drizzle-kit` drops `@esbuild-kit`.
- **esbuild 0.27.3 path traversal** (`GHSA-g7r4-m6w7-qqqr`) — low, and **Windows-only**
  (backslash traversal); Eco runs macOS in dev and Linux on Fly.io. Left visible; closed
  by an override on 2026-09-16.
- **uuid 10.0.0** (`GHSA-w5hq-g745-h8pq`) — reached through
  `apps/api > resend > svix > uuid`. The vulnerable pattern needs `v3`/`v5`/`v6` with an
  explicit `buf`; svix calls only `v4` (confirmed again 2026-09-16 in
  `svix/dist/request.js`), and email sending is not active in production. Deliberately
  left visible then; closed by an override on 2026-09-16 — svix declares `uuid: ^10`, so
  the override crosses its declared range, which pnpm permits and the api suite covers.
- **expr-eval, two advisories** — suppressed before this review on the ground that
  exploitation is self-inflicted: the parser runs in the user's own browser on an
  expression they typed, with no cross-user vector and no server-side evaluation. That
  reasoning was sound but is now moot; see **Closed**. The review trigger it carried —
  *if expr-eval expressions are ever evaluated server-side or with cross-user input,
  revisit immediately* — still applies to `expr-eval-fork`.
- **ajv** (`GHSA-2g4f-4pwh-qvx6`) — dev-only via ESLint in `packages/config`; the `$data`
  option that triggers the ReDoS is opt-in and ESLint does not use it. Closed by an
  override on 2026-09-16 regardless, since a patched 6.x exists.
