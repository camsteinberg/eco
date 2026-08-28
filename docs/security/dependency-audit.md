# Dependency Audit Report

> AGPL-3.0-or-later | Bos Computing LLC | Last reviewed: 2026-08-28

## Audit Date

2026-08-28

## Tools

| Tool | Scope | Command |
|------|-------|---------|
| `pnpm audit` | npm (TypeScript) dependencies | `pnpm audit --audit-level=high` |

## CI Integration

`pnpm audit --audit-level=high` runs as a blocking step in CI. Findings at
high or critical severity fail the build. Resolved advisories are handled
via `pnpm.overrides` in the root `package.json`. Accepted risks that should
not block CI use `pnpm.auditConfig.ignoreCves` or `ignoreGhsas`.

## Current Advisories (2026-08-28)

Six advisories appear in `pnpm audit --prod`. Two were already suppressed
before this audit (expr-eval). One (adm-zip) is suppressed as of this
review. Three remain visible in audit output by design.

### Note on `--prod` flagging dev-only dependencies

`better-auth` declares `vitest` and `drizzle-kit` as optional peer
dependencies. When those packages are also present in `devDependencies`,
pnpm resolves them and follows their transitive trees during `--prod`
audits. Several advisories below are flagged because of this mechanism,
not because the vulnerable code ships to production.

---

### 1. adm-zip &mdash; Crafted ZIP triggers 4 GB memory allocation

| Field | Value |
|-------|-------|
| GHSA | GHSA-xcpc-8h2w-3j85 |
| CVE | CVE-2026-39244 |
| Severity | **High** (CVSS 7.5) |
| Installed | 0.5.16 |
| Fixed in | &ge; 0.6.0 |
| CWE | CWE-400, CWE-789 |

**Dependency path:**
`apps/web > @huggingface/transformers@4.2.0 > onnxruntime-node@1.24.3 > adm-zip@0.5.16`

**Reachability: dead code.** `onnxruntime-node` is a hard dependency of
`@huggingface/transformers` 4.2.0, but the web app exclusively uses
`onnxruntime-web` for in-browser inference. No source file imports
`onnxruntime-node`. The package (and its `adm-zip` dependency) is installed
but never loaded at runtime. Next.js tree-shaking excludes it from client
bundles, and there is no server-side inference path.

**Resolution: suppressed.** CVE-2026-39244 is added to
`pnpm.auditConfig.ignoreCves`. `@huggingface/transformers` is pinned exact
at 4.2.0 with a local pnpm patch, so bumping `adm-zip` via overrides would
affect an unused code path with no benefit.

**Review trigger:** re-evaluate when `@huggingface/transformers` is next
bumped (deliberate PR).

---

### 2. esbuild &mdash; Dev server CORS allows cross-origin reads

| Field | Value |
|-------|-------|
| GHSA | GHSA-67mh-4wv8-2f99 |
| Severity | **Moderate** |
| Installed | 0.18.20 |
| Fixed in | &ge; 0.25.0 |

**Dependency path:**
`apps/api > better-auth@1.6.23 > drizzle-kit@0.31.9 > @esbuild-kit/esm-loader@2.6.5 > @esbuild-kit/core-utils@3.3.2 > esbuild@0.18.20`
(also via `apps/web > better-auth` on the same chain)

**Reachability: build-tool only.** `drizzle-kit` is a CLI migration tool
listed as an optional peer dependency of `better-auth`. It is never imported
by application code that runs on the Hono server or in the browser. The
vulnerable code path is esbuild's development HTTP server
(`esbuild --serve`), which this project never starts. `@esbuild-kit` is an
archived, unmaintained package internal to `drizzle-kit`.

**Resolution: accepted, visible in audit output.** Severity is moderate
(below the CI `--audit-level=high` gate). No suppression needed. The
advisory will self-resolve when `drizzle-kit` drops the archived
`@esbuild-kit` packages.

---

### 3. esbuild &mdash; Windows-only file read via path traversal

| Field | Value |
|-------|-------|
| GHSA | GHSA-g7r4-m6w7-qqqr |
| Severity | **Low** (CVSS 2.5) |
| Installed | 0.27.3 |
| Fixed in | &ge; 0.28.1 |

**Dependency paths:**
`apps/api > better-auth@1.6.23 > vitest@3.2.6 > vite@6.4.3 > tsx@4.21.0 > esbuild@0.27.3`
(also via `apps/web > better-auth` and direct devDependency `vitest` paths)

**Reachability: test-only, wrong OS.** All paths go through `vitest` (test
runner) or `tsx` (dev script executor). `vitest` appears in `--prod` output
because `better-auth` declares it as an optional peer dependency (see note
above). The vulnerability itself is Windows-only (backslash path traversal);
Eco runs on macOS (dev) and Linux (Fly.io production).

**Resolution: accepted, visible in audit output.** Severity is low. No
suppression needed. Will self-resolve when `tsx` bumps to esbuild 0.28+.

---

### 4. uuid &mdash; Missing buffer bounds check in v3/v5/v6

| Field | Value |
|-------|-------|
| GHSA | GHSA-w5hq-g745-h8pq |
| CVE | CVE-2026-41907 |
| Severity | **Moderate** |
| Installed | 10.0.0 |
| Fixed in | &ge; 11.1.1 |

**Dependency path:**
`apps/api > resend@6.9.2 > svix@1.84.1 > uuid@10.0.0`

**Reachability: runtime API server, but vulnerable call pattern not
triggered.** `resend` is imported in `apps/api/src/auth/index.ts` for auth
emails. `svix` is a webhook delivery library used internally by `resend`.
The vulnerability requires calling `uuid.v3()`, `uuid.v5()`, or `uuid.v6()`
with an explicit `buf` (Buffer) argument and an offset that overflows.
`svix` generates webhook message IDs with `uuid.v4()` (random, no buffer
argument), which is not affected. Additionally, email sending is currently
not active in production.

**Resolution: accepted, deliberately NOT suppressed.** The advisory is
moderate (below the CI gate), so it does not block builds. Keeping it
visible in `pnpm audit` output ensures the team notices if `svix` ever
changes its uuid usage pattern or if `resend` adds new uuid call sites.

**Review trigger:** re-evaluate when `resend` or `svix` publishes a version
that bumps `uuid` past 11.1.1, or if email sending is re-enabled.

---

### 5 &ndash; 6. expr-eval &mdash; Prototype pollution / arbitrary code execution (2 advisories)

| Field | Value |
|-------|-------|
| CVEs | CVE-2025-13204, CVE-2025-12735 |
| GHSA (also suppressed) | GHSA-gv7w-rqvm-qjhr (covers CVE-2026-47429) |
| Severity | **High** (x2) |
| Installed | 2.0.2 |

**Dependency path:**
`apps/web > expr-eval@2.0.2` (direct dependency)

**Reachability: client-side browser only.** `expr-eval` powers the
calculator tool in `apps/web/src/lib/calculator.ts` and
`apps/web/src/lib/tools/calculator-tool.ts`. It runs entirely in the
user's browser. The known vulnerabilities (prototype pollution, arbitrary
expression execution) would require the user to type a malicious expression
into their own browser session. There is no cross-user vector and no
server-side evaluation.

**Resolution: suppressed (pre-existing).** CVE-2025-13204,
CVE-2025-12735, and CVE-2026-47429 are in `pnpm.auditConfig.ignoreCves`;
GHSA-gv7w-rqvm-qjhr is in `ignoreGhsas`. These were set before this audit
and the rationale is sound: exploitation is self-inflicted only.

**Review trigger:** if expr-eval expressions are ever evaluated server-side
or with cross-user input, these ignores must be revisited immediately.

---

## Dev-Only Findings (not in `--prod` audit)

### ajv &mdash; ReDoS with `$data` option

| Field | Value |
|-------|-------|
| GHSA | GHSA-2g4f-4pwh-qvx6 |
| CVE | CVE-2025-69873 |
| Severity | Moderate |
| Installed | 6.12.6 |

**Dependency path:**
`packages/config > eslint@9.39.2 > @eslint/eslintrc@3.3.3 > ajv@6.12.6`

**Reachability: dev-only.** `ajv` is pulled in exclusively via ESLint in
the shared lint config package. It runs during development and CI linting
only. The `$data` option that triggers the ReDoS is an opt-in ajv feature
not used by ESLint's config validation. No action needed.

---

## Resolved Advisories (via pnpm.overrides)

Eight previously-high npm advisories remain resolved via `pnpm.overrides`
in the root `package.json`:

| Advisory | Package | Resolution |
|----------|---------|------------|
| GHSA-3ppc-4f35-3m26 | minimatch | `"minimatch@<3.1.4": "3.1.4"`, `"minimatch@>=9.0.0 <9.0.7": "9.0.7"` |
| GHSA-7r86-cg39-jmmj | minimatch | (same overrides) |
| GHSA-23c5-xmqv-rm74 | minimatch | (same overrides) |
| GHSA-25h7-pfq9-p65f | flatted | `"flatted": ">=3.4.0"` |
| GHSA-8gc5-j5rx-235r | fast-xml-parser | `"fast-xml-parser": ">=5.5.6"` |

## Policy

1. **CI blocks on high/critical.** `pnpm audit --audit-level=high` fails
   the pipeline if unresolved high or critical advisories exist.

2. **Accepted risks require documentation.** Any advisory that cannot be
   resolved must have an entry in this document with: CVE/advisory ID,
   affected package, dependency path, reachability classification, reason
   it cannot be resolved, and a review trigger.

3. **Suppression is reserved for high-severity dead code.** Advisories
   below the CI gate (moderate, low) stay visible in audit output so
   changes in upstream dependencies are noticed. Only high-severity
   advisories with confirmed-unreachable code paths are added to
   `ignoreCves`/`ignoreGhsas`.

4. **Quarterly review.** All accepted risks are re-evaluated quarterly.
   If a patch becomes available, it must be applied and the entry removed.
   **Next review: 2026-11-28.**

5. **Override hygiene.** `pnpm.overrides` entries should be removed when
   the direct dependency updates to include the fix. Verify with
   `pnpm why <package>`.
