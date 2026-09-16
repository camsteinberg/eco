# Dependency audit — suppressions and known-open advisories

`pnpm audit` runs in CI. A small number of advisories are suppressed via
`pnpm.auditConfig` in the root `package.json`, which can carry ids but not reasons.
This file is the reason column: every suppressed id is listed here with why it does not
apply to Eco and when it should be looked at again.

**Rule:** never add an id to `pnpm.auditConfig` without adding a row here. If an
advisory can be fixed by a version floor, fix it in `pnpm.overrides` instead of
suppressing it.

> The rationales below were reconstructed on 2026-09-16 from the advisory text and the
> dependency paths in `pnpm audit --json`. The suppressions predate this file and
> carried no recorded reason, so these are current assessments rather than a record of
> the original intent.

## Suppressed

| Id | Package (path) | Severity | Why it does not apply | Re-check |
| --- | --- | --- | --- | --- |
| `CVE-2025-13204` / `GHSA-8gw3-rxh4-v6jx` | `expr-eval` (`apps/web > expr-eval`) | high | Prototype pollution in the expression parser. **No patched release of `expr-eval` exists** — only the separate `expr-eval-fork` package is fixed. Eco uses it in `apps/web/src/lib/calculator.ts` for the calculator tool, entirely inside the user's own browser: the expression is normalised by `apps/web/src/lib/tools/calculator-tool.ts` first, and nothing is sent anywhere. The blast radius is one tab belonging to the person who typed the input. It is still a parser reachable from model output, so this is a tolerated risk, not a non-issue. | 2026-12-15 |
| `CVE-2025-12735` / `GHSA-jc85-fpwf-qm7x` | `expr-eval` (`apps/web > expr-eval`) | high | `evaluate()` does not restrict the functions callable from an expression. Same package, path, and reasoning as the row above; no patched `expr-eval` release exists. | 2026-12-15 |
| `CVE-2026-39244` / `GHSA-xcpc-8h2w-3j85` | `adm-zip` (`apps/web > @huggingface/transformers > onnxruntime-node > adm-zip`) | high | A crafted ZIP triggers a 4 GB allocation. Reached only through `onnxruntime-node`, the Node-side ONNX backend; Eco's chat runs `onnxruntime-web` in the browser, and the Node backend is pulled in as a transitive of `@huggingface/transformers` for local tests only. `adm-zip@0.6.0` fixes this one, but its sibling `GHSA-vwc7-r8mq-g2x9` (below) has **no** fixed version at any release, so an override would not clear `adm-zip` from the audit. | 2026-12-15 |
| `GHSA-vwc7-r8mq-g2x9` / `CVE-2026-76845` | `adm-zip` (`apps/web > @huggingface/transformers > onnxruntime-node > adm-zip`) | moderate | Extraction follows symlinks in the destination, allowing arbitrary file overwrite. **No patched version at any release** (`patched: <0.0.0`). Same dev-only path as the row above. | 2026-12-15 |
| `GHSA-67mh-4wv8-2f99` | `esbuild@0.18.20` (`apps/api > drizzle-kit > @esbuild-kit/esm-loader > @esbuild-kit/core-utils > esbuild`) | moderate | Any website can send requests to a running esbuild **dev server** and read the response. `drizzle-kit` bundles this old esbuild for its own loader and never starts a dev server; `drizzle-kit` itself is a dev-only CLI (`db:generate`, `db:push`) that never ships. Checked 2026-09-16: `drizzle-kit@0.31.10`, the newest 0.31.x, still depends on `@esbuild-kit/esm-loader`; only the `1.0.0-rc` line drops it, so there is no non-major fix. | 2026-12-15 |

## Known open, not suppressed

| Id | Package | Severity | Status |
| --- | --- | --- | --- |
| `GHSA-82fw-gwwq-j7x9` / `CVE-2026-84373` | `vitest`, `@vitest/mocker` (3.2.6) | moderate | Path traversal via the mocker's redirect mock. Patched in `>=4.1.11`, which is a major upgrade across all three workspaces; it gets its own PR (Dependabot #359) rather than a suppression. Test-time only — the mocker is not part of any build or runtime output. |

## Removed suppressions

Both were verified inert on 2026-09-16 (removing them changed nothing in `pnpm audit`):

- `GHSA-gv7w-rqvm-qjhr` (esbuild) — **withdrawn upstream** by GitHub.
- `CVE-2026-47429` (vitest UI server arbitrary file read) — fixed in `vitest@3.2.6`, which
  is the version this repo resolves.
