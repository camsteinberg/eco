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
- **14** sends two messages, the first asking to be greeted by name, then
  edits that first message to a new name and resends. Only the edited exchange
  may remain, the earlier version must be one tap away, storage must hold the
  edit, and the reply to the edited message must not use the original name —
  if it does, it was generated from the discarded text. A reply that uses no
  name passes on the rest and says the edit's content went unchecked. The
  witness has to be that reply: a later turn is built from the conversation as
  the app now shows it, so it cannot see what the edited turn was built from.
  Then it asks "What is my name?". The original name FAILs, the edited name
  PASSes, and neither name (the model says it doesn't know) is RECORDED, since
  that is a reading on a small model's recall rather than on the edit. The same
  rules hold on both runtimes.

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

Before it waits on a download, it checks each model's files by the app's own
rule. The build fetches from the production model CDN by default, and when
the CDN is missing a file (a 403 or 404) the app retries it through its own
same-origin proxy, which gets it from Hugging Face. So a file only the proxy
serves is not a failure: the report carries a note under that model's table
("the model host is missing … ; the app fell back to its own proxy"), as it
does for any file the host refused during setup. The run stops, with every URL
and status code, only when neither the host nor the proxy serves a file. A proxy
answer of 429 or 5xx (Hugging Face rate-limiting this machine, say) is not a
refusal: the check notes that it could not confirm the file and goes on, and
setup's real download still fails the run if the file is truly refused.

`ECO_ACCEPTANCE_MODEL_CDN_BASE` overrides the model host:

- empty (`ECO_ACCEPTANCE_MODEL_CDN_BASE=`) skips the CDN and fetches everything
  through the app's own model proxy;
- any other origin points it at a different copy of the model files in the same
  layout. The app's content-security policy has to allow that origin.

The host is compiled into the build, so stop the server on port 3120 before
changing it; otherwise the lane reuses a build that still fetches from the old
host.

Task 11 stubs the search relay in the browser, in both arms. Nothing in this lane
ever reaches a real search engine: the fixed payload is what makes the chip's
fetched-at time and the request body checkable, and the interception is also what
catches a request the OFF arm should never have made.

## The Safari run

The WebLLM run above is still Chrome underneath. This one is real Safari,
desktop Safari on this Mac, driven through Apple's `safaridriver` over
WebDriver. It uses the same tasks, prompts and verdict rules (`lib/tasks.ts`)
and writes its report in the same format to its own files. Playwright is only
the test runner here; no Playwright browser starts.

It walks every task except 7 (offline reload) and 8 (switching models) for
now (`safari/target.ts` lists them), on the model the app serves desktop
Safari (Eco Compact, Qwen3 0.6B on WebLLM).
`ECO_ACCEPTANCE_TASKS` narrows the list, and asking for a task it cannot walk
yet is an error, never a silent skip.

You start the server yourself: a harness build, with `API_URL` pointing at
the stub api the lane runs on 127.0.0.1:3131.

```bash
# build with the same flags as the Chrome lane (playwright.acceptance.config.ts)
NEXT_PUBLIC_ECO_VALIDATION_HARNESS=true NEXT_PUBLIC_API_URL=http://127.0.0.1:3001 \
NEXT_PUBLIC_ECO_MODEL_CDN_BASE=https://models.econetwork.ai \
NEXT_PUBLIC_ENABLE_SERVICE_WORKER=true NEXT_PUBLIC_ENABLE_LOCAL_SW=true \
  pnpm --filter @eco/web build
API_URL=http://127.0.0.1:3131 PORT=3132 pnpm --filter @eco/web start

# then, with safaridriver listening (`safaridriver -p 4444`) and Safari NOT running:
ECO_SAFARI_TARGET=mac ECO_SAFARI_BASE_URL=http://127.0.0.1:3132 \
  pnpm --filter @eco/web test:acceptance:safari
```

What is different from the Chrome lane:

- **Every run is a genuine first run.** A WebDriver session starts with an
  empty Safari profile. The walk opens chat, answers the first-run choice and
  waits for the app to download and load its model, so task 1's time includes
  the download. If the app sets up any model other than this device's pick,
  the walk stops there.
- **Typing and pressing.** A prompt is put into the composer the way a paste
  does it: the value is set and an `input` event fires, as Playwright's
  `insertText` does. WebDriver's send-keys would turn a newline into Enter.
  Buttons get a real WebDriver click. A new conversation is the app's own
  new-chat shortcut, dispatched to the page, so Safari's own Cmd+N never
  fires.
- **Task 9 counts lookup requests from the page's own resource timings.**
  Safari offers no network observer, so the walk raises the page's
  resource-timing buffer, clears it before each turn and reads the
  Wikipedia/Wikidata entries afterwards. Both rows say that this is their
  witness.
- **Task 10 closes the tab, not the process.** The walk opens a spare tab,
  closes its own tab mid-reply, and opens chat in the spare: closing a
  session's only tab would end the session, and killing a Safari tab's
  process ends it too.
- **Task 14 hovers before pressing Edit**, as a person does on a desktop,
  because the message's actions are hidden until then.
- **Nothing reaches Eco's real api.** The app's same-origin auth and `/v1`
  proxy forward to `API_URL`. The stub there answers the signed-in session
  and the search relay with the Chrome lane's own fixed payloads, and records
  each search body. Before launching, the walk checks that a request to
  `/v1/search` reaches the stub.

Safety rules it keeps on this Mac (`safari/host.ts`):

- If Safari is already running, it stops before touching anything, with exit
  status 3. Those windows may be someone's own browsing, and `safaridriver`
  has to launch Safari itself.
- It ends the WebDriver session and then checks that Safari really quit,
  using a plain `quit app` and never a script that closes windows. A Safari
  that won't quit is a FAIL row.
- It waits when the disk has under 12 GB free and stops under 8 GB, before
  launch and before every task.

The report is
`test-results/acceptance-report-safari-mac.{json,md}`; its header names the
Safari version, and its Method section says how this run differs.

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
