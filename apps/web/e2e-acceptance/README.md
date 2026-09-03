<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2026 Bos Computing LLC
-->

# Acceptance lane

The ten-task walkthrough a person would do before saying the product is usable,
driven in a real browser against a production build with real on-device
inference, on both shipping models.

Run it at session open whenever a serving-path or tool change merged last
session, and at every phase end.

```bash
pnpm --filter @eco/web test:acceptance
```

It is **opt-in**. It is not in `pnpm qa` and not in CI: the first run downloads
two models (~0.8 GB and ~1.7 GB), every turn is real generation, and the whole
walk takes the better part of an hour per model.

## What it does

| # | Task |
| ---: | --- |
| 1 | Cold first run to a first reply, with no dead ends |
| 2 | A ten-turn budgeting chat — recall the rent figure, check a running total |
| 3 | Paste ~2 pages of text and ask for a summary |
| 4 | The exact-answer tools: a percentage and a date offset |
| 5 | Draft an email from three bullet points, then ask for it shorter |
| 6 | Chat until the context boundary appears, and check the app says so honestly |
| 7 | Reload the tab offline (a known gap — recorded, never fails the run) |
| 8 | Switch faster ↔ smarter and check the state and copy stay truthful |
| 9 | A factual question with web lookups off, then on |
| 10 | Kill the tab mid-reply and reopen — no wedge |

Task 7 runs last because reloading offline ends the page.

## What it reports

`test-results/acceptance-report.json` and `.md`: one table per model, one row
per turn, with the task, the model the receipt names, first-token time, the KV
cache's decision, a verdict, and the evidence behind it.

Verdicts are deliberately coarse. `PASS`/`FAIL` come from a mechanical check.
`EXPECTED-FAIL` is a known gap the run records without going red.
`RECORDED` is a turn whose quality only a person can judge — the row carries
the reply so they can.

## How it runs

Port 3120, its own production server, its own persistent Chrome profile in
`.browser-profile/` (gitignored). Session plumbing — persistent real Chrome,
stubbed auth, an empty workspace per page, turns that finish on a generation
receipt — is shared with the perf lane and lives in `../e2e-perf/lib/session.ts`.

The first test wipes the origin and provisions both models through the
switcher's own download flow, so each model walk can bind its slot and find the
bytes already there. To start genuinely cold again, delete `.browser-profile/`.
