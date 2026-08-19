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
pnpm --filter @eco/web capture -g pilot.chat-empty-ready

# One project, or one group (the positional arg matches the spec FILE name)
pnpm --filter @eco/web capture --project=desktop-dark
pnpm --filter @eco/web capture routes.capture

# Verify a finished run, then (re)build its index
pnpm --filter @eco/web capture:coverage
pnpm --filter @eco/web capture:index
```

**Never put `--` before those flags.** pnpm forwards arguments to a script
without it, and Playwright honours `--` as the standard end-of-options marker:
everything after it becomes a positional test-*file* filter. So
`capture -- --project=desktop-dark --list` does not select a project and does
not list — it silently runs the **whole grid**, which is a twenty-minute
surprise. Verified on 2026-08-18: with `--` the same command ran 184 shots
across all twelve projects; without it, 37 tests in one project, listed.

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

This is not a style rule, and getting it wrong is quiet. An assertion that is
only true *before* the interaction does not fail — it **retries for ten seconds**,
so the lane waits for the interaction to undo itself and then photographs the
undone state. `chat-surface.code-block-copied` was asserting on a button whose
accessible name changes when it is clicked, and produced two runs of a perfectly
green "Copied" state that showed "Copy". If a `prepare` changes a name, a label
or a count, assert on something structural instead.

### Escape hatches, and when they are allowed

Four optional fields exist for states the plain declare-and-shoot path cannot
reach. Each one narrows what the lane can promise, so an entry that sets one
should say why in its `notes`.

| Field | For | Cost |
| --- | --- | --- |
| `mock(page, ctx)` | Network fakes installed **before** the first navigation — a response a route fetches on mount, or cutting the network off entirely. Also where a warm-up navigation goes. | Forces `realism: 'mocked'`; the manifest rejects any other value. |
| `serviceWorker` | Lets the real worker register instead of aborting `/sw.js`. | One run could serve another run's cached HTML. Only the offline state sets it. |
| `server: 'prod'` | States that do not exist on a dev server. | Skipped, and absent from `expected.json`, on a dev run — so coverage does not call them missing. |
| `hydrates: false` | A document the app did not render. | Drops the hydration wait, which is the check that stops the lane photographing a page whose buttons do not work. |

Two things genuinely need `server: 'prod'`: the app registers its service worker
only when `NODE_ENV === 'production'` (and, on a loopback host, only with
`eco-enable-local-sw` set), and Next.js's dev error overlay covers the
`error.tsx` boundaries — which `assertNoDevErrorOverlay` refuses to photograph.

`routes.offline-fallback` is the one state using all four, and is the worked
example: seed the two opt-in keys, remove `eco-skip-sw-registration-once` so the
app actually registers, warm up with a navigation in `mock`, wait for
`navigator.serviceWorker.controller`, then `setOffline(true)` and let the
entry's own `goto` land on the worker's fallback document.

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

## Seeding a conversation

`seed.idb` names the conversation a state needs. Two kinds of name resolve:

- the app's own harness fixtures (`conversation-assistant-dom`,
  `conversation-hybrid-continuation`), installed by the app through its
  `eco-history-fixture` param;
- a **lane seed** from `seeds/idb.ts`, written straight into the `eco-chat`
  database at document-start.

Lane seeds exist because the message surface is where most of the UI lives and
two fixed fixtures cannot express it: a markdown showcase, thirteen classified
error cards, a reasoning block and a three-way branch are all just "a
conversation whose rows say particular things". They are built from the app's
own `DbConversation` / `DbMessage` types, so a schema change fails type-check
instead of silently producing an empty chat.

The write is ordered, not raced: `indexedDB.open` is called before any app JS
runs and the write transaction is created synchronously in its success handler,
so the app's own read queues behind it. Timestamps are offsets from the same
frozen clock `capture.ts` uses, and ids are fixed strings — both are load-bearing
and `seeds/idb.ts` says so.

**One caveat, and it is a big one.** A conversation that is already active when
`/chat` mounts renders nothing on the **dev server**: `useConversationManager`'s
load effect stamps its request id above its own early-return, so React
StrictMode's second (no-op) invocation invalidates the load that the first one
started. The production build has no double invocation and renders correctly, so
every seeded-conversation state is marked `server: 'prod'`. If that effect is
ever fixed, the flag can come off all of them at once.

## Determinism, and what it costs

In order, per capture: fixed clock → media emulation (`colorScheme`,
`reducedMotion`) → the Battery Status API removed → one ordered `addInitScript`
(onboarding suppression → theme and font size → entry seed → **removals last**,
so an entry can un-suppress a first-run surface) → any IndexedDB seed → `mock` →
navigate → settle → `prepare` → screenshot.

The battery removal is not cosmetic. Below 30% on a discharging laptop the app
shows a "Low battery mode" notice above the composer, which then appears in
every chat capture — a run that differs by how charged the machine happened to
be is not a baseline. Dropping the API is the app's own "battery unavailable"
path, and the forced battery states still work because the harness override is
read first.

Settling refuses to photograph a broken app: it fails on a Next.js dev error
overlay, waits for `document.fonts.ready` and for React to have actually
hydrated (a fiber key on the DOM, not just `load`), runs the assertions, and
rejects an empty body. The dev-tools portal is hidden with a style tag — it is
not part of the product.

Model weights never arrive. They are fetched same-origin through
`/api/local-models/…`, so any state that reaches the download path would really
download a model — hundreds of megabytes per shot, and a progress bar reading a
different percentage every run. `installRouteMocks` holds those requests open
(never fulfilled, never aborted), which leaves the app in the state it genuinely
is in while it waits for the first byte: download phase, percent 0, no error.
The plan/manifest request is let through so the pipeline still builds a real
plan and the forced-failure entries still fail where they would in the wild.
That is what makes the `setup-gate` progress surfaces reproducible; it is also
why the mid-download percent bands (45–84%, 85–99%, smoke, done) have no
entries — they are driven by real bytes and nothing forces them.

That style tag is injected once, during settling. A `prepare` that **reloads**
throws it away along with the rest of the document, so a reloading prepare has
to re-inject it or the capture comes out with the dev-tools indicator in the
corner. Same for anything else granted per-page rather than per-context.

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
