<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2026 Bos Computing LLC
-->

# The UI capture lane

A screenshot of every state Eco's UI can be in, taken the same way every time,
written outside the repo as a dated, browsable run.

This is **not** visual regression testing. `playwright.visual.config.ts` compares
a handful of pages against committed baselines inside CI and fails a build. This
lane produces an *inventory for people to look at* — a designer reviewing the
whole product in one sitting, a contributor checking that a change did not
disturb a state they had never seen. It runs on demand and never gates a merge.

## Running it

```bash
# Everything, into ~/eco-artifacts/ui-baseline/<run-id>/
pnpm --filter @eco/web capture

# One state (test titles are entry ids)
pnpm --filter @eco/web capture -- -g pilot.chat-empty-ready

# One project
pnpm --filter @eco/web capture -- --project desktop-dark

# Verify a finished run, then (re)build its index
pnpm --filter @eco/web capture:coverage
pnpm --filter @eco/web capture:index
```

The lane starts its own server on **port 3300** and never reuses a running one,
so it cannot accidentally photograph a stale build or another branch. It builds
`@eco/ui` first: that package is consumed from `dist/`, and in a fresh worktree
every route fails to resolve it — the symptom is a completely blank capture run.

### Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `ECO_CAPTURE_OUT` | `~/eco-artifacts/ui-baseline` | Base directory for runs. |
| `ECO_CAPTURE_PORT` | `3300` | Server port. Never 3000. |
| `ECO_CAPTURE_SERVER` | `dev` | `prod` builds and serves the production bundle instead. |
| `ECO_CAPTURE_WORKERS` | `4` | Parallel workers. |
| `ECO_CAPTURE_TIER` | *(unset)* | Comma-separated tier filter, e.g. `page,component`. |
| `ECO_CAPTURE_MODE` | *(unset)* | `baseline` asserts against committed snapshots instead of writing artifacts. |

### What a run contains

```
<run-id>/
  run.json            header + one record per shot (sha256, bytes, axes)
  expected.json       what the manifest said this run should produce
  INDEX.md            grouped, linked, human-readable index
  contact-sheets/*.html
  shots/<project>/<entry-id>.png
```

## Adding states (waves W1–W6)

A wave is **one manifest file plus one spec file**, nothing else:

1. `manifest/<group>.ts` — export `<group>States: StateEntry[]`.
2. Register it in `manifest/index.ts`'s `GROUPS`.
3. `specs/<group>.capture.spec.ts` — copy `pilot.capture.spec.ts` and change the
   group name. It is a 15-line loop; if you need more, the mechanism belongs in
   `capture.ts` instead.

### Entry ids are API

An id is how a state is referenced in review notes, in `-g` filters, and across
runs when comparing "before" and "after". Renaming one silently breaks that
history. Add and deprecate; do not rename casually. Ids are validated at module
load: lowercase, dot-separated, prefixed with their group, unique.

### Tiers decide how widely a state is shot

| Tier | Viewports | Why |
| --- | --- | --- |
| `page` | mobile, tablet, desktop | Layout is the point. |
| `component` | mobile, desktop | Two layouts; tablet adds nothing. |
| `micro` | desktop | A hover/focus/menu detail needs a pointer. |

Every tier is shot in both themes. The reduced-motion, font-size and
system-theme projects are **opt-in**: an entry only runs there if its `axes`
say so. `entryRunsInContext` in `capture.ts` is the single place this lives.

### Assertions are the contract

Every entry needs at least one. They run once when the page settles and again
after `prepare`, so they must describe what is true in **both** phases — the
stable base state, not the interaction. Proving the interaction is `prepare`'s
job (`openMenu` waits for `role=menu`; the hover pilot polls computed opacity).

### Realism is disclosed, not hidden

`real` (the app did this by itself), `seeded` (we set storage or harness knobs),
`mocked` (a network response was faked). The generated index flags `mocked`
states so nobody reads a stubbed account screen as live behavior.

## The slot-seam finding (verified 2026-08-18)

Two conflicting recipes existed for "a chat with a model already ready":

- `e2e/visual/fixtures.ts` seeds legacy localStorage keys
  (`eco-local-ai-slot-eco-fast`, `eco-local-ai-slot-status-eco-fast=ready`).
- `e2e/local-runtime-launch-confidence.spec.ts` uses harness URL params
  (`eco-validation-slot-eco-fast=…`, `eco-validation-slot-status-eco-fast=ready`,
  `eco-force-cache-verified=1`).

Tested both against the running dev:validation server:

- **The legacy localStorage seam does NOT reach a ready chat.** It lands on the
  setup gate's "Finishing your model download…" progress screen, which would
  have made every chat capture a screenshot of a progress bar.
- **The harness URL params do.** `[data-testid="empty-chat-state"]` renders
  within a second or two, no download runs.

So: **seed readiness through the URL**, using the `READY_SLOT_SEARCH` constant in
`manifest/pilot.ts`. The legacy keys are not useless — they still steer the gate
past the first-run choice into the download path, which is exactly how
`pilot.setup-error-storage` reaches a forced `eco-force-download=quota` failure.
They just do not confer *readiness*.

## Determinism, and what it costs

In order, per capture: fixed clock → media emulation (`colorScheme`,
`reducedMotion`) → one ordered `addInitScript` (onboarding suppression → theme
and font size → entry seed → **removals last**, so an entry can un-suppress a
first-run surface) → navigate → settle → `prepare` → screenshot.

Settling refuses to photograph a broken app: it fails on a Next.js dev error
overlay, waits for `document.fonts.ready` and for React to have actually
hydrated (a fiber key on the DOM, not just `load`), runs the assertions, and
rejects an empty body. The dev-tools portal is hidden with a style tag — it is
not part of the product.

`clock: 'paused'` installs a fake clock, which freezes timers and
`requestAnimationFrame` too. That is how an intro animation gets parked at a
chosen millisecond (`advanceMs`) — and also why it is not the default: a surface
that waits on a timer to appear will never appear under a paused clock.

## Coverage checking

`scripts/check-capture-coverage.mjs` compares `expected.json` (written from the
manifest before any screenshot exists) against the PNGs on disk. It fails on
missing, orphan, zero-byte, and **duplicate** shots — two ids with identical
pixels almost always means a theme seed or a `prepare` silently did nothing. It
warns on anything under 8 KB.

Both scripts default to the newest run under `ECO_CAPTURE_OUT`; pass a run
directory to check an older one. A filtered run (`-g …`, `--project …`,
`ECO_CAPTURE_TIER=…`) will report the states it deliberately skipped as MISSING —
coverage is a question about a *full* run.

It reads `expected.json` rather than importing the TypeScript manifest because
this repo has no TypeScript runner for plain Node scripts (`tsx` is not a
dependency), and `global-setup.ts` already evaluates the manifest with the exact
`entryRunsInContext` the specs use.
