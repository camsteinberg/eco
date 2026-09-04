# Contributing to Eco

Thanks for your interest in contributing. Eco is a local-first AI chat app; bug fixes,
performance work on the on-device model path, UI improvements, and new ideas are all
welcome. This guide covers what you need to send a change with confidence.

## Getting set up

The fastest way in is the **zero-service quickstart** in the [README](./README.md): the
on-device chat runs entirely in the browser, so `pnpm install` and `pnpm dev` are enough
to start working on the product. You only need Postgres + Redis if you're touching auth
— the README's "Full-stack development" section covers that.

## The QA bar

Run these before opening a PR. All of them should pass.

```bash
pnpm type-check      # TypeScript, strict mode, no `any`
pnpm lint            # ESLint
pnpm test            # Vitest unit tests
pnpm check:cycles    # no new circular dependencies
```

If your change touches user-facing flows, also run the end-to-end suite:

```bash
pnpm --filter @eco/web exec playwright test
```

Scope the unit tests to the package you changed when that fully covers it — e.g.
`pnpm --filter @eco/web test`.

A note on CI: `pnpm audit` intentionally ignores a small set of documented,
non-applicable CVEs via `pnpm.auditConfig` in the root `package.json` — if you touch
dependencies, don't be surprised to see those listed there. The secret-scanning
(TruffleHog) and dependency-review CI lanes are advisory on forks, so they may not run
with full permissions on a fork PR; that's expected and not a failure on your part.

## UI changes

Before sending a visual change:

- **Use the design tokens — don't hardcode.** Colors, typography, spacing, radius, and
  shadows come from CSS custom properties (`--eco-*`). Sources of truth:
  `apps/web/app/globals.css` and `packages/ui/src/tokens/tokens.css`.
- **Reuse before inventing.** Pull shared components from `packages/ui/` and existing app
  components in `apps/web/src/components/` before adding new ones.
- **Cover the states.** Think through default, hover, focus, loading, empty, error, and
  mobile up front — reviewers will look for them.
- **Include screenshots** of the affected surface in your PR — light and dark, and mobile
  if it's responsive.

## Commits, sign-off, and the DCO

We use [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`,
`docs:`, `chore:`, `refactor:`, `test:`, and so on. Keep the subject line short and
imperative.

Every commit must be **signed off** under the
[Developer Certificate of Origin](https://developercertificate.org/). The DCO is a
lightweight, one-line affirmation that you wrote the contribution (or otherwise have the
right to submit it) and that it can be distributed under the project's license. Sign off
by adding the `-s` flag when you commit:

```bash
git commit -s -m "fix: keep the reset-password form usable without a token"
```

That appends a `Signed-off-by: Your Name <you@example.com>` trailer using your `git`
identity. Make sure your name and email are set (`git config user.name` / `user.email`).

## Pull request expectations

- **Keep PRs small and focused.** One change per PR is much easier to review and merge
  than a grab-bag.
- **Add tests for behavior changes.** New behavior or a bug fix should come with a test
  that would fail without it.
- **Add the AGPL header to new source files.** Every new source file starts with this
  block (using the appropriate comment syntax for the file type):

  ```
  // SPDX-License-Identifier: AGPL-3.0-or-later
  // Copyright (C) 2026 Bos Computing LLC
  ```

- **Explain the what and the why.** The PR template will prompt you; a sentence or two of
  reasoning saves everyone time.

## Questions

Open a [GitHub issue](https://github.com/camsteinberg/eco/issues) — questions,
proposals, and bug reports all start there. For security vulnerabilities, please don't
open a public issue; follow [`SECURITY.md`](./SECURITY.md) instead.
