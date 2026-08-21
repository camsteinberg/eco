# Local-AI selection & slot state model

> Living reference for the persisted state that decides **which on-device model
> serves a generation**. Descriptive, not prescriptive: it freezes the surface
> of the *shipped* machine so changes to it are deliberate. It is not a redesign.
> Consolidation toward a smaller, single-owner surface (see
> [Future direction](#future-direction)) is explicitly future work.

The behavioral guarantees this document describes are pinned by
`apps/web/src/local-ai/__tests__/state-invariants.test.ts` (invariants I1–I7,
[below](#8-invariants-i1i7)). The sibling `invariants.test.ts` pins the
*architectural* invariants (export/ownership greps); this file and its test pin
the *value-level* ones.

---

## 1. Vocabulary

The surface uses several near-synonyms deliberately; conflating them is the
usual source of bugs.

- **Serving model** — the concrete catalog id a generation resolves to *right
  now*. It is not stored directly; it is *computed* at dispatch time by
  `resolveSelectedModelId(choice)` (`local-ai/util.ts`), which turns a
  *selection* (a slot name or a concrete id) into a concrete id by resolving a
  slot to its bound model. This is the only value that answers "what is
  answering me?".
- **Selection** (a.k.a. the *pick*) — the persisted `eco-selected-model` value:
  either a **slot name** (`eco-fast` / `eco-smart`), a **concrete catalog id**,
  or the sentinel `auto` (route via the recommender). Owned by
  `stores/chatStore.ts`.
- **Bound model** — the concrete catalog id persisted *in a slot*
  (`eco-local-ai-slot-<slot>`). A slot's binding is what its name resolves to.
- **Staged model** — a model whose bytes are verified on disk and waiting to be
  swapped into the slot its pull record names, tracked by that record
  (`phase: 'staged'`). Staged is not yet serving; the swap makes it so, and only
  the user's own "switch now" starts it.
- **Explicit pick** — a selection the user chose deliberately, flagged by
  `eco-selected-model-explicit = 'true'`. Explicit picks are honored verbatim
  across reloads and are exempt from auto-migration. The auto-default population
  (no explicit flag) is the only population migrations touch.
- **Starter** — the smallest trustworthy model Stage-A setup binds to eco-fast
  to get a fresh device chatting in ~a minute (currently the LFM2.5-350M rung).
  A pull carries the device from there to whichever model the person taps in the
  composer's model selector; **the slot it binds is the one the record names**,
  so the tile that was not tapped keeps what it had.

**Slot ↔ id duality.** A selection or a bound value can be a slot name *or* a
concrete id. The canonical helpers live in `local-ai/util.ts`:
`isLocalAiSlot(value)` (is it `eco-fast`/`eco-smart`?), `isLocalAiModel(id)`
(slot name, or a `local/` / `candidate/` prefixed id), and
`resolveSelectedModelId(choice)` (collapse a slot to its bound id). The two
slots are the fixed set `['eco-fast', 'eco-smart']` (`types.ts` `Slot`).

---

## 2. Persisted-key registry

One row per key. "Owner" is the module that *defines* the key name and is the
sanctioned writer; other modules read (and, where noted, migrate) via that
owner's API rather than touching the string. All keys are `localStorage` unless
noted.

| Key | Type / legal values | Owner (writer) | Readers | Lifecycle / cleanup |
|---|---|---|---|---|
| `eco-selected-model` | slot name \| concrete id \| `auto` | `stores/chatStore.ts` (`persistSelectedModel`) | `chatStore` hydration; `self-heal.ts` retirement detox (read + rewrite) | Rewritten on every explicit set; detoxed to `eco-fast` when it names a retired id |
| `eco-selected-model-explicit` | `'true'` \| `'false'` | `stores/chatStore.ts` | `chatStore` hydration; `self-heal.ts` (read for exempt-check, demote on detox) | Demoted to `'false'` when a retired explicit pick is scrubbed |
| `eco-local-ai-slot-eco-fast` | concrete model id \| absent | `local-ai/lifecycle/slots.ts` (**sole** owner — Invariant 3) | `slots.ts` only; everything else via `getSlot`/`setSlot` | Removed on `clearSlot`; rebound by retirement/former-default migrations |
| `eco-local-ai-slot-eco-smart` | concrete model id \| absent | `slots.ts` | via `slots.ts` API | Cleared (not rebound) on retirement detox |
| `eco-local-ai-slot-status-eco-fast` | `empty`\|`preparing`\|`ready`\|`error` | `slots.ts` (`setSlot`/`setSlotStatus`) | via `slots.ts` API | Forced `preparing` on id change / bind-from-empty (phantom-pick rule); flipped `ready`→`preparing` by boot reconcile on failed verify |
| `eco-local-ai-slot-status-eco-smart` | same | `slots.ts` | via `slots.ts` API | same |
| `eco-local-ai-upgrade-v1` | JSON `UpgradeRecord` (`version:1`) | `local-ai/lifecycle/upgrade.ts` (`writeUpgradeRecord`) | `upgrade.ts`; `self-heal.ts` (read + drop on retirement) | Removed on `reset` / retirement detox; `swapping`→`staged` on boot reconcile |
| `eco-local-ai-ledger-v1` | JSON array of evidence entries | `local-ai/evidence/ledger.ts` | `recommend()`, diagnostics | `clearEvidence(id)` on artifact-swap / retirement migrations |
| `eco-local-ai-cooldowns-v1` | JSON crash-cooldown records | `local-ai/runtime/lifecycle.ts` | runtime load path | Auto-expires lazily on read (5-min window); no active boot cleanup |
| `eco-local-heavy-work-owner-v1` | JSON lease `{ownerId, expiresAt, …}` | `lib/local-heavy-work-owner.ts` | runtime/switch/download | 90s TTL; expired lease swept as a side effect of the boot lease read |
| `eco-local-download-owner-v1` | JSON lease | `lib/local-heavy-work-owner.ts` | download pipeline | 90s TTL; same sweep |
| `eco-local-ai-download-in-progress-<id>` | timestamp \| `{startedAt}` JSON | download pipeline | self-heal | Cleared by self-heal when older than 5 min |
| `<file-url>.ecopart.<stamp>.<offset>` | chunk-part bytes (in the model's storage namespace, Cache API/OPFS) | `local-ai/download/download.ts` | resume path | Swept by `clearModel` and after a successful whole-file store; invisible to reconcile |
| `eco-local-ai-mig-*` (marker keys) | timestamp string | `self-heal.ts` (per migration) | self-heal | Written **last**, only on full success, so a thrown step retries next boot |
| `eco-local-ai-retired-notice-v1` | JSON `{label, at}` | `self-heal.ts` | `components/local-ai/RetiredModelNotice.tsx` (read + remove on mount) | One-time hint; removed by the consumer after it fires the toast |
| `eco-local-ai-cache-repaired-v1` (**sessionStorage**) | JSON `{modelId, slot, removed, at}` | `local-ai/bootstrap.ts` (`onCacheRepaired`) | cache-repaired notice consumer | Session-scoped; one-time "we cleaned up your cache" hint |
| `eco-composer-draft` | string | `stores/chatStore.ts` | `chatStore` | Removed when the draft empties (not a selection key; listed for completeness) |

**Legacy (read-migrate-only) keys.** `slots.ts` reads the pre-v1 keys
`eco-model-slot-<slot>` and `eco-slot-<slot>` on first slot read; a value found
there is promoted forward to the canonical key and the legacy key is left in
place (retirement detox additionally deletes a legacy key still naming a retired
id). `self-heal.ts` also sweeps the legacy download/smoke prefixes
`eco-model-download-in-progress:` and `eco-local-model-smoke-ready-v1:`. These
keys are never *written* by current code.

### Harness-only keys (appendix — no production owner)

These are read only when the validation harness is enabled
(`isValidationHarnessEnabled()` — loopback host in non-prod, an explicit env
opt-in, or `NODE_ENV==='test'`). They are **never** active on a production host
and have no canonical owner in the state machine. Set via URL query or
localStorage:

- `eco-validation-slot-<slot>`, `eco-validation-slot-status-<slot>`,
  `eco-validation-selected-model` — override slot binding / status / selection.
- `eco-force-capability`, `eco-force-device-memory`, `eco-force-browser`,
  `eco-force-platform`, `eco-force-opfs`, `eco-force-metered`,
  `eco-force-data-saver`, `eco-force-connection`, `eco-force-download`,
  `eco-force-local-runtime`, `eco-force-protection`, `eco-force-remote` —
  device-profile / capability / failure-injection overrides.
- `eco-force-cache-verified` — makes `reconcileReadySlots` skip verification so
  e2e fixtures can prime `ready` slots without writing real cache bytes.

---

## 3. Selection resolution

Two distinct steps: **hydration** normalizes the persisted selection on boot;
**dispatch** resolves the live selection to a serving id per generation.

### Hydration — `normalizePersistedSelectedModel(storedModel, hasExplicitChoice)`

Runs inside `loadPersistedSelectedModel()` (`stores/chatStore.ts`) on store
creation. `canUseLocalSelection` folds two gates: capability is not
`unsupported`, AND either the pick is explicit or a local model is
default-eligible (a slot is ready). Branches, in order:

| Condition (first match wins) | Result |
|---|---|
| explicit pick **and** capability supported **and** `getModel(storedModel)` exists | `storedModel` **verbatim** (any prefix — the 2026-06-10 reversion fix) |
| `storedModel` is a slot name (`eco-fast`/`eco-smart`) | slot name if `canUseLocalSelection`, else `auto` |
| a slot currently binds `storedModel` (`getSlotForModel`) | that slot name if `canUseLocalSelection`, else `auto` |
| `getModel(storedModel)` exists (non-explicit, any prefix) | `auto` |
| `local/`-prefixed but no catalog match | `eco-fast` if a local default is eligible, else `auto` |
| local defaults not eligible | `auto` |
| `storedModel === 'auto'` | `eco-fast` (default local selection) |
| otherwise | `eco-fast` |

No stored value at all → `eco-fast` if a local default is eligible, else `auto`.
When the harness is enabled, `getValidationSelectedModelOverride()` short-circuits
the whole read.

### Dispatch — `resolveSelectedModelId(choice)`

`local-ai/util.ts`. A slot name resolves to its bound model id
(`getSlot(choice).model?.id`); an empty slot or any non-slot value passes
through unchanged. **Total and non-throwing** for any non-empty input (Invariant
I1): even a slot bound to an id the catalog no longer owns resolves to the slot
name (because `getSlot` nulls the uncataloged model), never to a dangling id.

---

## 4. Slot machine

Owned entirely by `slots.ts` (Invariant 3: no other file in `local-ai/` touches
the `eco-local-ai-slot-*` keys). Status lattice:

```
empty ──setSlot(id)──▶ preparing ──pipeline──▶ ready
                          ▲   │                  │
                          │   └──error◀──load────┘
       reconcile(fail)────┘   (failed verify flips ready→preparing)
```

`getSlot(slot)` composes the persisted id and status: it resolves the id
against the catalog (`getModel`, plus eval candidates **only** when the harness
is enabled), and a slot whose id no longer resolves reads back as `empty` with a
null model — so a retired or unknown binding never presents as a live model.

**Phantom-pick rule** (`setSlot`, the load-bearing lines ~139–163). Status
describes *the bytes of the currently-bound model*. Therefore:

- Binding a **different** id, or binding into an **empty** slot, forces
  `preparing` — the new bytes are unverified until the pipeline drives the slot
  to `ready`.
- A **same-id** re-bind **preserves** status — the bytes it describes are
  unchanged.

Without this, a reload mid-switch would leave a slot falsely `ready` on a model
that never finished downloading: Settings claims it is running, chat refuses,
nothing resumes. This is Invariant I5.

---

## 5. Pull machine

Owned by `lifecycle/upgrade.ts`; persisted under `eco-local-ai-upgrade-v1`. A
**pure** transition table (`transitionUpgrade`) plus two effectful drivers with
injectable seams (`runUpgradeDownload`, `performUpgradeSwap`).

```
idle ─request─▶ accepted ─download-started─▶ downloading
                                                   │
                                          download-completed
                                                   ▼
                                                 staged
                                                   │
                                              swap-started
                                                   ▼
                                                swapping
                                               │   │   │
                                 swap-succeeded    swap-failed   swap-busy
                                       │          (retry<cap:    (free:
   deferred ◀─download-failed          ▼           →staged;       →staged,
       ▲   (insufficient-storage /    done         else defer)    refund attempt)
       │    download-failed)
       └── request ─▶ accepted   (a settled record never blocks a fresh ask)

                          cache-evicted: staged ─▶ accepted  (re-download the evicted bytes)
```

**`request` is the only way in.** It carries `targetModelId` and `targetSlot`
and comes from one place: the model tile's inline confirm. That confirm IS the
consent, so there is no offered/accept step. It is valid from idle and over any
settled record (a tile is always re-tappable) and refused while a cycle is
mid-flight. The `offered`/`declined` phases remain parseable for records written
before the pair selector; `reconcileUpgradeOnBoot` clears an `offered` one,
whose surface no longer exists.

**Rejection contract.** Invalid transitions **return the input record
unchanged** (never throw) — deliberate tolerance of racing events (two tabs,
stale UI). Only `reset` produces `null` (idle). This is Invariant I4.

**Deferral codes** (`UpgradeDeferralCode`): `insufficient-storage`,
`download-failed`, `swap-failed`. `MAX_SWAP_ATTEMPTS = 2`: a real swap failure
burns one attempt and retries via `staged`; at the cap it defers for good. A
`swap-busy` (runtime busy, nothing attempted) refunds the optimistically-charged
attempt and returns to `staged`.

**Binds the slot the record names** (Invariant I3). `performUpgradeSwap` calls
`prepareModelForSlot({ slot: record.targetSlot, … })` and never the other slot,
which keeps its own model bound and cached — so a failed swap is a pointer move,
not a re-download. The ledger records `swap-pass`/`swap-fail` for the *pull's*
result (distinct from the load/smoke rows `prepareModelForSlot` writes).

**No boot swap.** `hooks/local-ai/useModelUpgrade.ts` reconciles on boot and
resumes an interrupted download; a `staged` record becomes the tile's quiet
"ready, switch now" affordance and waits for the tap.
`reconcileUpgradeOnBoot()` repairs an interrupted swap by resetting
`swapping`→`staged` (the interrupted attempt stays counted, so a tab-crashing
swap can't retry forever). An interrupted **download** stays in `downloading`
and resumes via the download pipeline's per-file verify-skip.

**Per-slot in-flight question.** `isUpgradeInFlightForSlot(slot)` is what the
chat error surface asks: a pull preparing one slot says nothing about failures
on the model serving from the other.

---

## 6. Boot heal ordering

Two boot-time passes run from `bootstrap.ts` (once, before render):
`runSelfHeal()` then `reconcileReadySlots(resolveReconcileFilePlan, …)`. Both
are fully wrapped — self-heal must never crash boot.

### `runSelfHeal` steps, **in order** (the order is load-bearing)

1. **Artifact-swap evidence migration** (`ARTIFACT_SWAP_MIGRATIONS`). Clears
   stale ledger evidence + dead cache bytes for a model whose artifact was
   replaced in place. **Must run first** because step 0 below calls
   `recommend()`, which reads the ledger — stale rows have to be gone by then.
   Also flips a `ready` slot on the migrated id to `preparing`.
2. **Retired-model migrations** (`RETIRED_MODEL_MIGRATIONS`). Purges every
   surface a removed catalog id would otherwise strand: weight bytes, ledger
   rows, the retired runtime's private caches, the bound slot (eco-fast rebinds
   to the device default and goes `preparing`; eco-smart clears), the persisted
   selection (→ `eco-fast`, explicit demoted), and a pending upgrade record that
   targets/bases on the retired id. Leaves a one-time notice hint when the user
   was actually on the model. **Must run after step 1 and before step 0**: the
   former-default rebind reads slots and calls `recommend()`, so a slot still
   bound to a retired id has to be rebound/cleared first. This is Invariant I7.
3. **Former-default slot migration** (step 0 in source). An eco-fast slot still
   bound to a *former* everyday default (`FORMER_EVERYDAY_DEFAULT_IDS`) and never
   explicitly chosen is rebound to the current device-appropriate default and
   marked `preparing`. Device-aware (rebind no-ops on a low-memory device where
   the recommendation is unchanged) and explicit-choice exempt.
4. **Stale download-in-progress markers** older than 5 minutes.
5. **Stale smoke markers** for models no longer assigned to a slot.
6. **Legacy slot-key migration count** (report-only; the promotion itself
   happens as a side effect inside `slots.ts`).
7. **Expired-lease sweep** — reads the active heavy-work lease, which clears an
   expired lease in both mutual-exclusion domains as a side effect. Only
   *expired* leases are swept; a live lease may belong to a live other tab and
   the single-download invariant depends on it surviving.

Each marker-guarded migration writes its marker **last, only on full success**,
so a thrown sub-step leaves no marker and retries next boot with no half-applied
state trusted.

### `reconcileReadySlots` — the manifest-sizes-only rule

After self-heal, each `ready` slot is re-verified against its file plan. For a
ready slot, the plan is resolved via `resolveReconcileFilePlan`, then
`repairModelCache` removes any file whose stored byte size mismatches and reports
any file wholly missing; if anything was removed **or** missing, the slot flips
`ready`→`preparing` (and `onCacheRepaired` fires **only** when bytes were
actually removed — a wholly-missing file was never there to "clean up"). This is
Invariant I6.

The order-independent but load-bearing rule (the **2026-06-11 cache-wipe
incident**): `resolveReconcileFilePlan` returns **reviewed manifest sizes, or
null — never the heuristic estimator**. Verifying cached bytes against estimates
declares every healthy cache corrupt and wipes it (observed live: a manifest
timeout at boot erased a just-downloaded 1.4 GB model). So when the manifest is
unreachable this boot, reconcile **skips** the model (real corruption is still
caught at load time and on the next boot with a reachable manifest) and **never
wipes**. The harness `eco-force-cache-verified` seam force-skips the whole pass
so e2e fixtures priming `ready` slots without cache bytes aren't demoted.

---

## 7. Ownership summary

- **Selection** (`eco-selected-model` + `-explicit`) → `stores/chatStore.ts`.
- **Slots** (`eco-local-ai-slot-*` + `-status-*`) → `lifecycle/slots.ts` (sole).
- **Upgrade** (`eco-local-ai-upgrade-v1`) → `lifecycle/upgrade.ts`.
- **Evidence / cooldowns** → `evidence/ledger.ts`, `runtime/lifecycle.ts`.
- **Leases** → `lib/local-heavy-work-owner.ts`.
- **Boot heal** (migrations, markers, reconcile) → `lifecycle/self-heal.ts`,
  wired by `bootstrap.ts`.
- **Chunk parts** (`.ecopart.`) → `download/download.ts`.

Cross-module reads that must go through the owner (not the raw string):
everything reading a slot goes through `getSlot`/`setSlot`; self-heal's retired
detox is the one sanctioned exception that reads the raw slot id
(`readRawSlotIdForMigration`) — precisely because `getSlot` would null the
retired id it needs to detect.

---

## 8. Invariants I1–I7

Numbered 1:1 with `apps/web/src/local-ai/__tests__/state-invariants.test.ts`.

- **I1 — Selection totality.** `resolveSelectedModelId` returns a non-empty
  string and never throws across every legal slot state (empty/preparing/
  ready/error × bound/unbound, incl. a bound-but-uncataloged id).
  *(`local-ai/util.ts`, `lifecycle/slots.ts`)*
- **I2 — Explicit pick survives rehydration verbatim.** A persisted explicit
  catalog pick hydrates as itself, any prefix. *(`stores/chatStore.ts`)*
- **I3 — A pull binds the slot its record names.** `performUpgradeSwap` targets
  and binds `record.targetSlot`, and never mutates the other slot.
  *(`lifecycle/upgrade.ts`)*
- **I4 — Illegal pull transitions return the input unchanged** (never throw;
  only `reset` → null), and swaps cap at `MAX_SWAP_ATTEMPTS`.
  *(`lifecycle/upgrade.ts`)*
- **I5 — Phantom-pick rule.** Different-id / bind-from-empty forces `preparing`;
  same-id rebind preserves `ready`. *(`lifecycle/slots.ts`)*
- **I6 — `ready` never survives a failed verify.** Reconcile flips ready→
  preparing and fires `onCacheRepaired` on a removable file; force-skips under
  the harness seam; and SKIPS (never wipes) on a null plan.
  *(`lifecycle/self-heal.ts`)*
- **I7 — Retired-model detox leaves no dangling selection.** After `runSelfHeal`
  the slot is rebound/cleared to a catalog model and fresh chatStore hydration
  never resolves the retired id. *(`lifecycle/self-heal.ts`, `stores/chatStore.ts`)*

---

## Future direction

This document *freezes* the current surface; it does not endorse its breadth.
The selection/serving/bound/staged quartet spans five modules and two storage
areas, and the same fact ("which model") is encoded three ways (selection, slot
binding, upgrade target). A future consolidation could collapse this toward a
single owned *serving* value plus a *staged* value, with slots and selection
derived rather than independently persisted. That is out of scope here — the
invariants above are what any such consolidation must preserve.
