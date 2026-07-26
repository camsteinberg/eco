<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2026 Bos Computing LLC
-->

# Performance regression gate

Eco's functional E2E suites prove the on-device funnel *works*. This lane proves it is
still *fast*: before it existed, time-to-first-token could double and every check would
stay green.

It measures four numbers on the warm path — the path a returning user actually walks —
and compares each against a committed baseline with tolerance bands.

| metric | what it is | direction |
|---|---|---|
| `warmReadinessMs` | `/chat` navigation start → the cached, proven model is resident in the runtime (chat is usable) | lower is better |
| `ttftTurn1Ms` | send → first streamed token, turn 1 | lower is better |
| `ttftTurn2Ms` | same conversation, turn 2 — the KV/prefix-reuse benefit | lower is better |
| `decodeTokensPerSec` | streamed tokens per second after the first token, turn 1 | higher is better |

## Running it

```bash
pnpm --filter @eco/web perf-gate            # measure and compare against baseline.json
pnpm --filter @eco/web perf-gate:update     # measure and RE-RECORD baseline.json
```

The config builds a **production** bundle and serves it with `next start` on port
**3100** (dev-server numbers are meaningless, and 3100 keeps a dev server on 3000 from
being silently reused). It launches **headed real Chrome** with a persistent profile —
WebGPU is unavailable in headless Chromium, and ephemeral Playwright contexts reject the
large `Cache.put` a real model download needs.

Runtime: **~20s** for the measuring test on a warm profile (3 samples × 1 page load + 2
turns), plus the one-off production build. A fresh profile adds the model download.

**The first run downloads a real ~0.28GB model** (`candidate/lfm2.5-350m-onnx`, the
smallest shipping desktop model) into `e2e-perf/.browser-profile/`, which is gitignored
and reused by later runs. Budget a few extra minutes and a working network on that run
only; steady-state runs are download-free.

This lane is **not** part of the default `e2e/` suite and is **not** wired into CI yet
(a later wave does that). Two reasons it must stay separate: a real download inside the
default suite starves every `networkidle` wait in it, and the default 30s test timeout
cannot hold a model load.

### Knobs

| env var | default | purpose |
|---|---|---|
| `ECO_PERF_UPDATE_BASELINE` | unset | `1` re-records `baseline.json` instead of asserting |
| `ECO_PERF_PROFILE` | `desktop-chromium-webgpu` | which baseline profile to read/write |
| `ECO_PERF_SAMPLES` | `3` | samples per metric (median is compared, all samples are reported) |
| `ECO_PERF_MACHINE` | — | machine description recorded alongside a re-recorded baseline |
| `ECO_PERF_PROFILE_DIR` | `e2e-perf/.browser-profile` | browser profile location |
| `ECO_PERF_FRESH_PROFILE` | unset | `1` wipes the profile first (forces a real download) |

## The KV-reuse measurement (`kv-reuse.spec.ts`)

A second spec in this lane measures — never gates — KV-cache reuse across turns:

```bash
pnpm --filter @eco/web perf-kv
```

It walks one conversation through three phases (plain follow-ups → ~4,400-char
pastes that saturate the starter model's history budget → follow-ups after the
eviction) and reports what the per-turn receipts recorded: hit rate, miss
reasons, TTFT by decision, and whether reuse resumed after the eviction-forced
re-prefill — the design claim behind `context-window.ts`'s quantized eviction.
Results land in `test-results/kv-report.json`; the only assertions are
instrument-liveness invariants (every turn completed, telemetry present, cache
committed every turn). Hit rate is deliberately never asserted — how often
reuse fires is the product truth this spec measures, not a band it enforces.

It shares this lane's config, profile, and session plumbing (`lib/session.ts`),
so a warm `perf-gate` profile is a warm `perf-kv` profile. The `perf-gate`
scripts are pinned to `perf-gate.spec.ts`, so the measurement never runs inside
the regression gate.

## How it decides

Never a bare absolute-millisecond assertion — that is flaky within a week. Each metric
carries two independent guards (`lib/compare.ts`):

1. **Relative band.** Worst tolerated value is
   `max(baseline × (1 + tolerancePct/100), baseline + noiseFloor)` for a lower-is-better
   metric, mirrored for higher-is-better. The percentage term keeps a large metric from
   drifting; the `noiseFloor` term keeps a small metric from failing on scheduler jitter.
   Exceeding it is a **regression**.
2. **Hard limit.** An absolute ceiling (lower-is-better) or floor (higher-is-better) that
   fails on its own, however wide the band. This is the "the product is broken" line, and
   it is the guard that survives a careless baseline update.

Beating the band is reported as an **improvement**, never a failure — with a nudge to
re-record.

> **Size `noiseFloor` to observed jitter, never above the baseline.** The floor wins
> whenever it exceeds `value × tolerancePct`, which silently turns the percentage band
> off. During development a 300ms floor on a 177ms TTFT baseline let a *measured* 2.7×
> regression report `PASS`. A unit test now fails if any committed metric carries a
> floor larger than its own baseline; do not "fix flakiness" by raising one.

Each metric is the **median of `ECO_PERF_SAMPLES` runs** (3 by default) inside one
session; every individual sample is printed and attached to the run as
`perf-report.json`.

## Measurement source

The app's own instrumentation, not the DOM:

- per-turn timings come from the generation receipts
  (`src/local-ai/lifecycle/generation-receipt.ts` — the same records the diagnostics dump
  carries: `firstTokenMs`, `durationMs`, `completionTokens`);
- readiness comes from `runtime/lifecycle.getActiveModel()`, which is set only after the
  adapter's load resolves.

Both are module-scoped, so the gate reads them through `window.__ecoPerf`
(`src/local-ai/diagnostics/perf-bridge.ts`) — a read-only bridge over those two existing
accessors, gated on `isValidationHarnessEnabled()` so it never exists on a production
host. DOM waits are used only to drive the UI.

The gate deliberately does **not** seed a fake-ready slot: warm readiness is only honest
if the slot is really restored, really reconciled against the real cache, and the
mount-time warm really loads the weights.

It *does* start each sample from an empty workspace, via the app's own one-shot
`eco-skip-conversation-persistence-once` sessionStorage seam. Conversations persist in
IndexedDB across pages in the reused profile, so without it sample 2's "turn 1" would
carry sample 1's history and TTFT would climb sample over sample for no product reason.
The trade-off is that `warmReadinessMs` excludes conversation-list hydration, which a
real returning user does pay — that hydration runs in parallel with the model load and
is not what this gate is watching.

## Updating the baseline

Baselines are **machine-specific**. `baseline.json` records the machine class it was
captured on; a number recorded on different hardware means nothing.

When a change is *deliberately* perf-affecting (a new runtime, a different default
sampling profile, a bigger prompt envelope):

1. Land the change.
2. `pnpm --filter @eco/web perf-gate` — confirm the gate flags exactly what you expect.
3. `ECO_PERF_MACHINE="<your machine>" pnpm --filter @eco/web perf-gate:update`
4. Commit `baseline.json` **in the same PR as the change**, and say in the PR body why
   the numbers moved.

A refresh replaces `value` only. `tolerancePct`, `noiseFloor` and `hardLimit` are
deliberate judgements and are carried over untouched — widening a guard is always a
hand edit with a reviewer.

## Tightening path

The bands start at **±50%**, deliberately loose: the first job is a gate nobody has to
babysit. Tighten it with evidence, in this order:

1. **Collect variance first.** Run the gate ~10 times on an idle machine and record the
   spread per metric. Do not tighten a band below `3 × observed spread`.
2. **Tighten TTFT first** (`ttftTurn1Ms`, `ttftTurn2Ms`) — they are the shortest and
   least environment-sensitive, and the ones a user feels first. 50% → 30% → 20%.
3. **Then `decodeTokensPerSec`** — steady-state throughput is stable once the machine is
   warm. 50% → 25%.
4. **`warmReadinessMs` last.** It includes disk I/O and shader compilation and is the
   most machine-mood-dependent; 50% → 35% is realistic, tighter is not.
5. **Lower the hard limits alongside.** They should always sit at "a user would call this
   broken", not just above the baseline — otherwise a bad baseline update disables the
   only guard that does not move.
6. **Add a second profile before tightening for CI.** A CI runner (and later a
   BrowserStack phone) gets its own `profiles` key with its own numbers and its own,
   looser bands — never a shared band across device classes.
