# Dependency Audit Report

> Historical snapshot (pre-`eco-desktop` extraction); Rust/Solana/cargo findings no longer apply to this repo.

> AGPL-3.0-or-later | Bos Computing LLC | Last updated: 2026-03-18

## Audit Date

2026-03-18

## Tools

| Tool | Scope | Command |
|------|-------|---------|
| `pnpm audit` | npm (TypeScript) dependencies | `pnpm audit --audit-level=high` |
| `cargo audit` | Rust (Cargo) dependencies | `cargo audit` (from `apps/miner/src-tauri/`) |

## CI Integration

Both audits run as blocking steps in the CI pipeline (`.github/workflows/ci.yml`,
`security-audit` job). Findings at high/critical severity fail the build.

- **npm audit:** `pnpm audit --audit-level=high` -- exits non-zero on unresolved
  high/critical advisories. Resolved advisories are handled via `pnpm.overrides`
  in `package.json`. Accepted risks use `pnpm.auditConfig.ignoreCves`.
- **cargo audit:** `cargo audit --ignore RUSTSEC-2024-0344 --ignore RUSTSEC-2022-0093`
  -- exits non-zero on unresolved vulnerabilities. Accepted risks are ignored via
  command-line flags (documented below).

## Resolved Advisories

### npm (pnpm audit)

| Advisory | Package | Severity | Vulnerable Version | Resolution |
|----------|---------|----------|-------------------|------------|
| GHSA-3ppc-4f35-3m26 | minimatch | High | <3.1.3 | `pnpm.overrides`: `"minimatch@<3.1.4": "3.1.4"` |
| GHSA-3ppc-4f35-3m26 | minimatch | High | >=9.0.0 <9.0.6 | `pnpm.overrides`: `"minimatch@>=9.0.0 <9.0.7": "9.0.7"` |
| GHSA-7r86-cg39-jmmj | minimatch | High | <3.1.3 | `pnpm.overrides`: `"minimatch@<3.1.4": "3.1.4"` |
| GHSA-7r86-cg39-jmmj | minimatch | High | >=9.0.0 <9.0.7 | `pnpm.overrides`: `"minimatch@>=9.0.0 <9.0.7": "9.0.7"` |
| GHSA-23c5-xmqv-rm74 | minimatch | High | <3.1.4 | `pnpm.overrides`: `"minimatch@<3.1.4": "3.1.4"` |
| GHSA-23c5-xmqv-rm74 | minimatch | High | >=9.0.0 <9.0.7 | `pnpm.overrides`: `"minimatch@>=9.0.0 <9.0.7": "9.0.7"` |
| GHSA-25h7-pfq9-p65f | flatted | High | <3.4.0 | `pnpm.overrides`: `"flatted": ">=3.4.0"` |
| GHSA-8gc5-j5rx-235r | fast-xml-parser | High | >=4.0.0-beta.3 <=5.5.5 | `pnpm.overrides`: `"fast-xml-parser": ">=5.5.6"` |

All 8 high-severity npm advisories were resolved via `pnpm.overrides` in
the root `package.json`. The vulnerable packages are transitive dependencies
of `eslint`, `@typescript-eslint`, and `@aws-sdk/client-s3`.

### Cargo (cargo audit)

No high/critical Rust advisories were resolved via dependency upgrades.
The two vulnerabilities found are in the Solana SDK dependency chain and
cannot be upgraded without a major Solana SDK version change (see Accepted
Risks below).

## Accepted Risks

### npm

| CVE | Package | Severity | Why Unresolvable | Risk Assessment | Review Date |
|-----|---------|----------|-----------------|-----------------|-------------|
| CVE-2025-13204 | (pre-existing) | High | Upstream dependency, no patch available at time of audit | Development tooling only, not production runtime | 2026-06-18 |
| CVE-2025-12735 | (pre-existing) | High | Upstream dependency, no patch available at time of audit | Development tooling only, not production runtime | 2026-06-18 |

These two CVEs were already in `pnpm.auditConfig.ignoreCves` prior to this
audit. They affect development tooling and do not impact production runtime.

### Cargo (Rust)

| Advisory | Crate | Version | Severity | Why Unresolvable | Risk Assessment | Review Date |
|----------|-------|---------|----------|-----------------|-----------------|-------------|
| RUSTSEC-2024-0344 | curve25519-dalek | 3.2.1 | Vulnerability | Pinned by `solana-sdk 1.18.26` via `solana-zk-token-sdk`. Upgrading to curve25519-dalek >=4.1.3 requires upgrading the entire Solana SDK to v2.x, which is a major breaking change. | **Low runtime risk.** The timing variability is in `Scalar29::sub`/`Scalar52::sub`. Eco miners use curve25519 for wallet signatures (not constant-time-critical path). The miner does not perform operations where remote timing attacks on scalar subtraction are feasible. | 2026-06-18 |
| RUSTSEC-2022-0093 | ed25519-dalek | 1.0.1 | Vulnerability | Pinned by `solana-sdk 1.18.26`. Upgrading to ed25519-dalek >=2 requires upgrading the entire Solana SDK to v2.x. | **Low runtime risk.** The "double public key signing function oracle attack" requires an attacker to submit chosen messages for signing with two different public keys. Eco miners sign only self-generated transactions with a single wallet key. The attack is not applicable to our usage pattern. | 2026-06-18 |

Additionally, `cargo audit` reports 26 warnings for unmaintained crates
(e.g., `atk`, `atty`, `derivative`, `fxhash`). These are transitive
dependencies of Tauri v2 and the Solana SDK. They carry no known
vulnerabilities and are tracked as informational only.

## Resolution: Upgrade Path for Accepted Risks

Both Rust accepted risks will be resolved when the Solana SDK is upgraded
to v2.x. This is tracked as a future maintenance task (not launch-blocking
since the vulnerabilities do not apply to Eco's usage pattern).

**Trigger for re-evaluation:** Any of the following:
- Solana SDK v2.x stable release
- New advisory on curve25519-dalek or ed25519-dalek that affects our usage
- Quarterly review (next: 2026-06-18)

## Policy

1. **CI blocks on high/critical.** The `security-audit` CI job fails the
   pipeline if `pnpm audit --audit-level=high` or `cargo audit` (with
   accepted-risk ignores) exits non-zero.

2. **Accepted risks require documentation.** Any advisory that cannot be
   resolved must have an entry in this document with: CVE/advisory ID,
   affected package, reason it cannot be resolved, risk assessment, and
   a review date.

3. **Quarterly review.** All accepted risks are re-evaluated quarterly.
   If a patch becomes available, it must be applied and the entry removed
   from this document.

4. **Override hygiene.** `pnpm.overrides` entries should be removed when
   the direct dependency updates to include the fix. Check with
   `pnpm why <package>` to verify the override is still needed.
