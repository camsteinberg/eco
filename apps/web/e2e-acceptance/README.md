<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2026 Bos Computing LLC
-->

# Acceptance lane

The fourteen-task walkthrough a person would do before saying the product is usable,
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

## The ten-minute self-test

```bash
pnpm --filter @eco/web test:acceptance:smoke
```

`ECO_ACCEPTANCE_SMOKE=1` walks Eco Fast only, and only tasks 1, 4, 8 and 12 — a
cold-start reply, the two tool cards, the model switch there and back, and
Stop mid-reply followed by the next message. Those four cover the lane's own
machinery end to end: session plumbing and slot binding, the non-generation
tool path, the switcher flow on a second model, and a reply the person cuts
short. On a warm profile it takes about ten minutes.

It writes the same report files with the same rows, and still ends red on any
`FAIL` row, so a broken walk is as visible as it is in a full run. Two things
differ, and the report header says both: one model is walked, and the origin is
NOT wiped — a wipe would re-download both models. **Read a smoke report as "the
walk still works", never as "the product passed."** Both models are still
provisioned, because task 8 has to have somewhere to switch to.

### Narrowing further: one task, one model

```bash
ECO_ACCEPTANCE_TASKS=2 ECO_ACCEPTANCE_SLOT=eco-smart pnpm --filter @eco/web test:acceptance
```

`ECO_ACCEPTANCE_TASKS` takes a comma-separated list of task numbers and walks
exactly those. It chooses which tasks run, not their order: they always run in
the walk's own order, with task 7 last. `ECO_ACCEPTANCE_SLOT` (`eco-fast` or
`eco-smart`) chooses which model walks them instead of the default everyday
pick. A task list implies a smoke run and beats `ECO_ACCEPTANCE_SMOKE` when
both are set. Like the smoke subset it does **not** wipe the origin, so the
profile stays warm and the models stay downloaded — that is what makes a single
task about four minutes (s42, measured 5×) rather than the better part of an
hour. It is an instrument for "did the change I just made to this task work?",
never a product verdict: one task on one model, on a profile carrying whatever
the last run left behind.

The ten-turn chat (task 2) prefixes every row's evidence with that turn's
counts — prompt and completion tokens, the KV gate's `cachedLen`/`promptLen`,
the common prefix, the duration, the window start, and the decoded divergence
when there was one — which is what makes a lost figure diagnosable after the
fact.

## What it does

| # | Task |
| ---: | --- |
| 1 | Cold first run to a first reply, with no dead ends |
| 2 | A ten-turn budgeting chat — recall the rent figure, check a running total |
| 3 | Paste ~2 pages of text and ask for a summary |
| 4 | The exact-answer tools: a percentage and a date offset |
| 5 | Draft an email from three bullet points, then ask for it shorter |
| 6 | Chat until the context boundary appears, and check the app says so honestly |
| 7 | Reload the tab offline: the worker must be controlling the tab, the chat shell captured, and a turn must get a reply with the network off |
| 8 | Switch faster ↔ smarter and check the state and copy stay truthful |
| 9 | A factual question with web lookups off, then on |
| 10 | Kill the tab mid-reply and reopen — no wedge |
| 11 | A question about right now with Web search off, then on |
| 12 | Press Stop mid-reply, then send another message — the stopped reply ends cleanly and the next one answers |
| 13 | A reply fails part-way; press Try again — the retry answers and the conversation carries on |
| 14 | Edit the first message and resend — the later exchange leaves the transcript and the model answers from the edit |

Task 7 runs last because reloading offline ends the page.

Tasks 12–14 are the things a person does mid-conversation, and none of them
was walked until Stop was found to leave the WebLLM engine locked, so the next
message hung until the chat gave up on it. Each one checks what the person
would see and what the reply's receipt recorded:

- **12** presses Stop once words are on screen. The stopped reply must keep its
  words, say it was stopped, offer Try again, and be recorded as `aborted`;
  the next message must finish with its first word inside 30 seconds.
- **13** makes the reply fail on purpose with the harness's one-shot fault
  (`eco-force-generation-fault=mid-reply` in localStorage; harness builds only):
  it fails after its first word with the usual error card. Pressing Try again
  must answer, show the question once, and replace the failed reply; one more
  message must then answer too.
- **14** sends two messages, edits the first (a new name), and resends. Only
  the edited exchange may remain, the earlier version must be one tap away, and
  asked "What is my name?" the model must give the edited name, not the
  original.

Not yet covered: pressing Stop before the first word appears, and pressing Try
again on a reply the person stopped.

## The WebLLM run

```bash
ECO_ACCEPTANCE_RUNTIME=webllm pnpm --filter @eco/web test:acceptance
```

The default walk runs the ONNX models Chrome gets. This run walks the two
models the app serves desktop Safari instead, which run on WebLLM: Eco Compact
(Qwen) and its fallback, Eco Mobile (Qwen). Real Chrome presents desktop
Safari's user agent, so the app routes there on its own; the GPU underneath is
still Chrome's WebGPU, not Safari's. Every row's model id is what the runtime
actually held, so a run that ended up on the wrong models is visible.

It walks tasks 1, 12, 13 and 14 on both models by default (an
`ECO_ACCEPTANCE_TASKS` list still narrows the tasks), keeps its own profile in
`.browser-profile-webllm/`, and provisions each model by asking for it the way
a preparing slot does, then waiting until the app reports it ready.

Before it waits on a download, it checks that each model's files are on the
model host the build fetches from, and stops with the URLs and status codes if
they are not. The build fetches from the production model CDN by default.
`ECO_ACCEPTANCE_MODEL_CDN_BASE` overrides that host:

- empty (`ECO_ACCEPTANCE_MODEL_CDN_BASE=`) fetches through the app's own model
  proxy, which gets the files from Hugging Face;
- any other origin points it at a different copy of the model files in the same
  layout. The app's content-security policy has to allow that origin.

The host is compiled into the build, so stop the server on port 3120 before
changing it; otherwise the lane reuses a build that still fetches from the old
host.

Task 11 stubs the search relay in the browser, in both arms. Nothing in this lane
ever reaches a real search engine: the fixed payload is what makes the chip's
fetched-at time and the request body checkable, and the interception is also what
catches a request the OFF arm should never have made.

## What it reports

`test-results/acceptance-report.json` and `.md`: one table per model, one row
per turn, with the task, the model the receipt names, first-token time, the KV
cache's decision, a verdict, and the evidence behind it.

Verdicts are deliberately coarse. `PASS`/`FAIL` come from a mechanical check.
`EXPECTED-FAIL` is a known gap the run records without going red (no task claims one today).
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
