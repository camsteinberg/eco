// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Transformers.js v4 worker for the local-ai/ runtime.
 *
 * Implements the `WorkerInbound` / `WorkerOutbound` protocol from
 * `local-ai/runtime/transformers-adapter.ts`. The only file in the
 * project that imports `@huggingface/transformers`.
 *
 * Lifecycle:
 *   init → load model, send `ready`
 *   generate → stream tokens, send `done`
 *   abort → set flag, generator checks between tokens
 *   unload → discard pipeline, terminate via main thread
 *
 * Storage: uses CacheApiStorage to back TJS's customCache. The worker
 * opens the SAME Cache API name the main thread populates via the
 * download pipeline, so model weights are reused without re-fetch.
 *
 * This worker has no automated test coverage in vitest (jsdom has no
 * Worker context and no real WebGPU). The Playwright pass is the first
 * end-to-end exercise. The adapter side is fully unit-tested with a
 * fake worker.
 *
 * Why no `/// <reference lib="webworker" />`: that triple-slash directive
 * bleeds globally during type-check and changes how `Worker.addEventListener`
 * is typed in test files that exercise the legacy useLocalInference hook.
 * Instead, the worker self-types its own `self` binding via a narrow
 * structural type — keeps the worker self-contained.
 */

import {
  AutoTokenizer,
  AutoModelForCausalLM,
  TextStreamer,
  env,
} from '@huggingface/transformers';
import { CacheApiStorage, type Storage } from '../local-ai/download/storage';
import { createStorageBridge } from '../local-ai/runtime/storage-bridge';
import {
  createFilterChain,
  flushFilterChain,
  processThroughChain,
  type FilterChain,
} from '../local-ai/runtime/output-filter';
import {
  normalizeMessagesForTemplate,
  type SystemRoleSupport,
} from '../local-ai/runtime/chat-template-adapter';
import type {
  WorkerInbound,
  WorkerOutbound,
} from '../local-ai/runtime/transformers-adapter';
import { toTransformersGenerateArgs } from '../local-ai/runtime/transformers-generate-args';
import { buildKvReuseReport } from '../local-ai/runtime/kv-cache';
import { patchChatTemplateForKvReuse } from '../local-ai/runtime/template-patches';
import {
  decideCjkSuppression,
  startCjkTokenScan,
  type CjkSuppressionTelemetry,
  type CjkTokenScan,
} from '../local-ai/runtime/cjk-suppression';
import { classifyGenerationError } from './classify-generation-error';
import { ortWasmPaths, clampThreads, type OrtArtifact } from '../local-ai/runtime/ort-artifact';

// ─── Local self typing ─────────────────────────────────────────────────────

type WorkerSelf = {
  postMessage(message: WorkerOutbound): void;
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent<WorkerInbound>) => void,
  ): void;
  location: { origin: string };
  navigator: { gpu?: unknown; hardwareConcurrency?: number };
};

declare const self: WorkerSelf;

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Extract the constructor name from a tokenizer (or any unknown value). */
function tokenizerName(t: unknown): string {
  return (t as { constructor?: { name?: string } } | null)?.constructor?.name ?? 'unknown';
}

/**
 * Apply the ORT artifact + thread-pool measurement overrides to Transformers.js's
 * shared onnxruntime-web env. `env.backends.onnx.wasm` aliases ort's live
 * `ONNX_ENV.wasm` (TJS spreads the top level but keeps the nested `wasm` object
 * by reference), so mutating it here is exactly what ort reads at session create.
 *
 * - `artifact` → a `wasmPaths` OBJECT pointing at the same-origin `/ort/` variant.
 *   The object form is required to force a specific variant; a bare string prefix
 *   would just append the bundle's own default filename.
 * - `numThreads` → clamped to `[1, hardwareConcurrency]`. ort still falls back to
 *   1 without cross-origin isolation; the clamp only keeps the request honest.
 *
 * Invoked only when a lever is present, so the default path never touches env.
 */
function applyOrtRuntimeOverrides(artifact?: OrtArtifact, numThreads?: number): void {
  const wasmEnv = (env as unknown as {
    backends?: { onnx?: { wasm?: { wasmPaths?: unknown; numThreads?: number } } };
  }).backends?.onnx?.wasm;
  if (!wasmEnv) return;
  if (artifact) {
    wasmEnv.wasmPaths = ortWasmPaths(artifact);
  }
  if (typeof numThreads === 'number') {
    wasmEnv.numThreads = clampThreads(numThreads, self.navigator.hardwareConcurrency ?? 1);
  }
}

// ─── Worker state ──────────────────────────────────────────────────────────

type LoadedModel = {
  modelId: string;
  // Tokenizer / model types from TJS are structural and verbose; the worker
  // treats them as opaque after construction.
  tokenizer: unknown;
  model: unknown;
  backend: 'webgpu' | 'wasm';
  /** Per-model policy from init: gate CJK-token suppression per generation. */
  cjkSuppression: boolean;
};

let loaded: LoadedModel | null = null;
let abortFlag: { aborted: boolean; generationId: string } | null = null;

// ─── CJK-token suppression state (worker-internal) ───────────────────────────
//
// When the loaded model opts in (init.cjkSuppression — Qwen3.5 family, see
// lib/local-model-generation-profiles.ts), the worker scans the vocab once
// post-ready for CJK-script token ids. Each generation then consults the pure
// conversation gate (`decideCjkSuppression`) and, when it says suppress,
// passes the ids as TJS `suppress_tokens` (logits-level -Infinity ban). The
// scan runs chunked in the dead time between ready and the first user message;
// a generation that needs it earlier awaits `cjkScan.ready`. Reset alongside
// the model on init/unload — ids are vocab-specific.
let cjkScan: CjkTokenScan | null = null;

// ─── KV-cache reuse state (worker-internal) ──────────────────────────────────
//
// Multi-turn chat re-tokenizes the WHOLE conversation each turn, so without a
// cache the worker re-prefills every prior token before generating (measured
// 5–8s TTFT mid-conversation). Holding the prior turn's `past_key_values` lets
// TJS skip that reprefill (~10–20× faster, byte-identical in a throwaway
// spike) — but ONLY when the cached token sequence is a STRICT prefix of the
// new render. `decideKvReuse` (pure, unit-tested) is that gate.
//
// These two refs are kept CONSISTENT as a unit: `cachedTokenIds` is exactly the
// token sequence that `cachedPkv` covers. They are committed together ONLY on a
// clean, fully-completed generation, and invalidated together on ANY non-clean
// exit (abort/error) or model lifecycle change (init/unload). The worker holds
// ONE model at a time, so there is no cross-model cache contamination.
//
// ⚠️ CORRECTNESS HAZARD — do NOT "simplify" the invalidation away. TJS's
// `DynamicCache.update()` mutates the cache object IN PLACE every decode step.
// On the reuse path, an abort/error throws AFTER TJS has already grown the
// cache past `cachedTokenIds.length`. If we left it, the next turn's
// `decideKvReuse` could green-light reuse while TJS slices input_ids at the now-
// longer `get_seq_length()` → wrong slice → silent context corruption. So any
// non-clean exit MUST dispose + null both refs, forcing a clean full prefill
// next turn.
let cachedTokenIds: number[] | null = null;
let cachedPkv: unknown = null;

/**
 * Dispose the held KV cache (best-effort, async) and drop both refs.
 *
 * `dispose()` frees GPU-buffer tensors; it is async and CAN reject — we never
 * let a dispose failure crash generation, so the rejection is swallowed. Always
 * clears both refs even if dispose throws, so the worker can never reuse a
 * half-disposed / inconsistent cache.
 */
async function invalidateKvCache(): Promise<void> {
  const pkv = cachedPkv;
  cachedTokenIds = null;
  cachedPkv = null;
  await disposePkv(pkv);
}

/**
 * Dispose a KV cache's GPU tensors, best-effort. `dispose()` is async and CAN
 * reject; we swallow the rejection (a dispose failure must never crash
 * generation) and tolerate a cache object that doesn't expose `dispose`.
 */
async function disposePkv(pkv: unknown): Promise<void> {
  const dispose = (pkv as { dispose?: () => Promise<void> } | null)?.dispose;
  if (typeof dispose !== 'function') return;
  try {
    await dispose.call(pkv);
  } catch {
    // Best-effort: a failed GPU-tensor free is non-fatal to the worker.
  }
}

/** Read a TJS int64 token Tensor into a plain number[] (BigInt → Number). */
function idsOf(tensor: { data: ArrayLike<number | bigint> }): number[] {
  return Array.from(tensor.data, Number);
}

// ─── Message dispatch ──────────────────────────────────────────────────────

self.addEventListener('message', async (event: MessageEvent<WorkerInbound>) => {
  const msg = event.data;
  try {
    switch (msg.type) {
      case 'init':
        await handleInit(msg);
        break;
      case 'generate':
        await handleGenerate(msg);
        break;
      case 'abort':
        if (abortFlag && abortFlag.generationId === msg.generationId) {
          abortFlag.aborted = true;
        }
        break;
      case 'unload':
        await handleUnload();
        break;
    }
  } catch (err) {
    post({
      type: 'error',
      code: 'generation-failed',
      message: err instanceof Error ? err.message : String(err),
    });
  }
});

// ─── init ──────────────────────────────────────────────────────────────────

async function handleInit(msg: Extract<WorkerInbound, { type: 'init' }>): Promise<void> {
  // A (re)load means the model — and therefore the tokenizer/vocab the cached
  // token ids belong to — is changing. Drop any held KV cache so a model switch
  // can never reuse another model's KV state, and drop the CJK token-id scan
  // for the same reason (ids index another model's vocab).
  await invalidateKvCache();
  cjkScan = null;

  const storage: Storage = new CacheApiStorage();
  const bridge = createStorageBridge({ storage, modelId: msg.modelId });

  // Configure TJS to consume our cache exclusively. allowRemoteModels=true is
  // safe because the customCache resolves first; remote falls through only
  // when the bridge returns undefined (the download pipeline should have
  // pre-populated everything, but allowing the fall-through means the first
  // load on a fresh device can still complete by hitting the proxy directly).
  env.useCustomCache = true;
  // TJS v4 doesn't declare customCache on the exported env type; assign through
  // a cast so the rest of the file keeps its strict typing.
  (env as unknown as { customCache: unknown }).customCache = bridge;
  env.allowRemoteModels = true;
  (env as unknown as { remoteHost?: string }).remoteHost = self.location.origin;
  (env as unknown as { remotePathTemplate?: string }).remotePathTemplate =
    '/api/local-models/{model}/resolve/{revision}/';

  // ── ORT artifact / thread-pool overrides (measurement levers) ─────────
  // Applied ONLY when the adapter forwarded a lever. With neither present the
  // worker touches nothing here, so onnxruntime-web resolves its WASM artifact
  // and thread count exactly as it does today (bundler import.meta.url asset +
  // crossOriginIsolated-keyed numThreads) — a byte-for-byte-unchanged default.
  applyOrtRuntimeOverrides(msg.ortArtifact, msg.numThreads);

  const wantsWasm = msg.forceWasm === true || !(await hasUsableWebGPU());
  const backend: 'webgpu' | 'wasm' = wantsWasm ? 'wasm' : 'webgpu';

  // TJS options are structurally typed and version-volatile; pass through
  // as a loosely-typed object to keep the worker resilient to v4.x patches.
  //
  // CRITICAL: `revision` must match what the download pipeline used when
  // populating the Cache API. Without this, TJS constructs URLs with
  // `resolve/main/` while our cache stores entries under the pinned
  // revision hash — causing a cache miss on the .onnx_data file and
  // triggering a ~2 GB re-fetch that hangs in the worker context.
  const progressCallback = (item: unknown): void => {
    const p = item as { loaded?: number; total?: number };
    if (typeof p.loaded === 'number' && typeof p.total === 'number') {
      post({ type: 'progress', loaded: p.loaded, total: p.total });
    }
  };
  const baseOptions: Record<string, unknown> = {
    device: backend,
  };
  if (msg.revision) {
    baseOptions.revision = msg.revision;
  }
  const tokenizerOptions: Record<string, unknown> = {
    ...baseOptions,
    progress_callback: progressCallback,
  };

  try {
    // Use hfId for from_pretrained so TJS constructs URLs matching the proxy
    // allowlist (e.g. 'microsoft/Phi-3-mini-4k-instruct-onnx-web') instead
    // of the v1 catalog id (e.g. 'local/phi3-mini-4k-q4f16') which 403s.
    const tokenizer = await AutoTokenizer.from_pretrained(
      msg.hfId,
      tokenizerOptions as Parameters<typeof AutoTokenizer.from_pretrained>[1],
    );

    // ── Standalone chat_template.jinja fallback ───────────────────────
    // Some repos (e.g. Gemma 4) ship the chat template ONLY as a separate
    // chat_template.jinja instead of embedding it in tokenizer_config.json.
    // TJS's AutoTokenizer reads only the embedded field (the .jinja file is
    // an AutoProcessor concern), so without this the template smoke below
    // fails with "tokenizer.chat_template is not set". Fetch the pinned file
    // through the same-origin proxy (it is part of the reviewed artifact
    // allowlist) and assign it. Best-effort: any miss leaves chat_template
    // unset and the smoke below reports template-missing, same as before.
    const tokenizerWithTemplate = tokenizer as { chat_template?: unknown };
    if (tokenizerWithTemplate.chat_template == null) {
      try {
        const templateUrl = `${self.location.origin}/api/local-models/${msg.hfId}/resolve/${msg.revision ?? 'main'}/chat_template.jinja`;
        const res = await fetch(templateUrl);
        if (res.ok) {
          const template = await res.text();
          if (template.length > 0) {
            tokenizerWithTemplate.chat_template = template;
          }
        }
      } catch {
        // Fall through — the template smoke below surfaces the failure.
      }
    }

    // ── KV-reuse template patch (Qwen3.5-shaped templates) ────────────
    // Restores the strict-prefix property across turns by rendering history
    // assistant turns exactly as they were generated (empty think block
    // included) — see template-patches.ts for the full mechanism. Applied
    // BEFORE the smoke so the smoke exercises what generate() will use.
    // No-match templates pass through byte-identical.
    if (typeof tokenizerWithTemplate.chat_template === 'string') {
      const patchResult = patchChatTemplateForKvReuse(tokenizerWithTemplate.chat_template);
      if (patchResult.patched) {
        tokenizerWithTemplate.chat_template = patchResult.template;
      }
    }

    // ── Boot-time template smoke ──────────────────────────────────────
    // Verify the tokenizer has a working apply_chat_template BEFORE
    // spending time loading multi-GB model weights. Without this gate,
    // a model with a broken/missing template would load successfully
    // then produce garbage on every generate() call.
    const templateFn = (tokenizer as { apply_chat_template?: (msgs: unknown[], opts: Record<string, unknown>) => string }).apply_chat_template;
    if (typeof templateFn !== 'function') {
      post({
        type: 'error',
        code: 'template-missing',
        message: `Tokenizer for ${msg.modelId} does not expose apply_chat_template. Model cannot generate coherent output.`,
        details: { tokenizerName: tokenizerName(tokenizer), modelId: msg.modelId },
      });
      return;
    }
    try {
      const smokeResult = templateFn.call(
        tokenizer,
        [{ role: 'user', content: 'hi' }],
        // enable_thinking:false mirrors the real generate render below so the
        // smoke exercises the same template path. It's an unknown/ignored
        // kwarg for non-thinking templates; if a template errored on it, this
        // smoke would catch it before we load multi-GB weights.
        { tokenize: false, add_generation_prompt: true, enable_thinking: false },
      );
      if (!smokeResult || typeof smokeResult !== 'string' || smokeResult.length === 0) {
        post({
          type: 'error',
          code: 'template-missing',
          message: `apply_chat_template returned empty/falsy for ${msg.modelId}. Template may be misconfigured.`,
          details: { tokenizerName: tokenizerName(tokenizer), modelId: msg.modelId },
        });
        return;
      }
    } catch (smokeErr) {
      const smokeMessage = smokeErr instanceof Error ? smokeErr.message : String(smokeErr);
      post({
        type: 'error',
        code: 'template-missing',
        message: `apply_chat_template smoke failed for ${msg.modelId}: ${smokeMessage}`,
        details: {
          tokenizerName: tokenizerName(tokenizer),
          modelId: msg.modelId,
          originalError: smokeMessage,
        },
      });
      return;
    }

    // Models with ONNX external data files (e.g. Phi-3's model_q4f16.onnx_data)
    // require `use_external_data_format` so TJS loads and mounts the weight
    // file(s) alongside the graph file. Some HF repos omit this from their
    // config.json, so the adapter derives a per-file chunk map from the pinned
    // catalog artifact list and signals us via msg.externalDataChunks
    // (e.g. { 'decoder_model_merged_q4f16.onnx': 2 } for multi-chunk exports).
    // A boolean `true` here would override a repo's own per-file map and mount
    // only chunk 0 — the map is always exact, so it is safe as an override.
    //
    // The `revision` field is propagated from baseOptions so TJS constructs
    // cache-lookup URLs matching the download pipeline's pinned revision.
    // Qwen3.5 text-only split exports must skip TJS's eager progress metadata
    // preflight: TJS 4.2.0 asks metadata for the multimodal vision sessions
    // before the later AutoModelForCausalLM textOnly resolver narrows sessions.
    const modelOptions: Record<string, unknown> = {
      ...baseOptions,
      dtype: msg.dtype,
      ...(msg.skipModelProgressPreflight === true
        ? {}
        : { progress_callback: progressCallback }),
    };
    if (msg.externalDataChunks && Object.keys(msg.externalDataChunks).length > 0) {
      modelOptions.use_external_data_format = msg.externalDataChunks;
    }

    const model = await AutoModelForCausalLM.from_pretrained(
      msg.hfId,
      modelOptions as Parameters<typeof AutoModelForCausalLM.from_pretrained>[1],
    );
    loaded = {
      modelId: msg.modelId,
      tokenizer,
      model,
      backend,
      cjkSuppression: msg.cjkSuppression === true,
    };
    post({ type: 'ready', backend });

    // ── CJK vocab scan (opt-in models only) ───────────────────────────
    // Started AFTER ready so it never delays the load signal; the chunked
    // scan yields between blocks, so a generate arriving mid-scan is not
    // blocked behind the full vocab walk (it awaits `cjkScan.ready` only
    // when the gate actually wants suppression). An unresolvable vocab
    // size leaves `cjkScan` null — generations report `scan-failed` and
    // proceed unguarded (visible in receipts, never fatal).
    if (msg.cjkSuppression === true) {
      const vocabSize = resolveVocabSize(model, tokenizer);
      if (vocabSize != null && vocabSize > 0) {
        const decodeToken = (id: number): string =>
          (tokenizer as { decode: (ids: number[], args?: Record<string, unknown>) => string })
            .decode([id], { skip_special_tokens: false, clean_up_tokenization_spaces: false });
        cjkScan = startCjkTokenScan(decodeToken, vocabSize);
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = classifyInitError(message);
    post({ type: 'error', code, message });
  }
}

/**
 * A usable WebGPU means a real adapter, not just the API surface: some
 * environments expose `navigator.gpu` while `requestAdapter()` resolves null
 * (blocklisted driver, software-only GPU). Choosing the WebGPU EP there fails
 * deep inside session init; falling back to the WASM EP keeps the device
 * working instead.
 *
 * The probe is time-bounded like the main-thread one (device/profile.ts
 * PROBE_TIMEOUT_MS): a wedged driver must not hang `handleInit` forever. On
 * timeout we fall back to the optimistic API-presence verdict — exactly the
 * pre-probe behavior, so a slow-but-working adapter is never downgraded.
 */
const WORKER_GPU_PROBE_TIMEOUT_MS = 4_000;

async function hasUsableWebGPU(): Promise<boolean> {
  // WebGPU types aren't wired into the worker lib; a structural cast keeps
  // the probe typed without pulling main-thread type deps into the worker.
  const gpu = (self.navigator as { gpu?: { requestAdapter?: () => Promise<object | null> } } | undefined)?.gpu;
  if (!gpu || typeof gpu.requestAdapter !== 'function') return false;
  try {
    // NB: called as gpu.requestAdapter() — a detached reference loses its
    // receiver and throws Illegal invocation (the #196 fetch bug class).
    const adapter = await Promise.race([
      gpu.requestAdapter(),
      new Promise<'timeout'>((resolve) => {
        setTimeout(() => resolve('timeout'), WORKER_GPU_PROBE_TIMEOUT_MS);
      }),
    ]);
    if (adapter === 'timeout') return true; // optimistic: API present, probe slow
    return adapter !== null;
  } catch {
    return false;
  }
}

/**
 * Resolve the model's vocab size — the index space `suppress_tokens` bans
 * against (the logits width). Mirrors TJS's own `_prepare_generation_config`
 * flattening: top-level `vocab_size`, else nested `text_config` / `decoder` /
 * `generator` (multimodal-wrapper configs like Qwen3.5's nest it). Tokenizer
 * vocab length is the last resort; ids beyond the tokenizer's decodable range
 * are skipped by the scan anyway.
 */
function resolveVocabSize(model: unknown, tokenizer: unknown): number | null {
  const config = (model as { config?: Record<string, unknown> } | null)?.config;
  if (config) {
    const candidates: unknown[] = [
      config.vocab_size,
      ...['text_config', 'decoder', 'generator'].map((key) => {
        const nested = config[key];
        return nested && typeof nested === 'object'
          ? (nested as Record<string, unknown>).vocab_size
          : undefined;
      }),
    ];
    for (const candidate of candidates) {
      if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0) {
        return candidate;
      }
    }
  }
  const vocab = (tokenizer as { model?: { vocab?: { length?: unknown } } } | null)?.model?.vocab;
  return typeof vocab?.length === 'number' && vocab.length > 0 ? vocab.length : null;
}

/**
 * Per-generation CJK-suppression resolution: policy flag → conversation gate
 * → scan state. Returns the telemetry that rides the `done` message; when
 * `applied` is true the caller attaches `cjkScan.ids` as `suppress_tokens`.
 * Awaits the scan ONLY on the suppression path (gate-escaped turns never
 * block on it).
 */
async function resolveCjkSuppression(
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[],
): Promise<CjkSuppressionTelemetry> {
  if (!loaded?.cjkSuppression) {
    return { enabled: false, applied: false, reason: 'disabled', bannedTokenCount: 0 };
  }
  const scanMs = (): { scanMs?: number } =>
    cjkScan?.scanMs != null ? { scanMs: cjkScan.scanMs } : {};

  const decision = decideCjkSuppression(messages);
  if (!decision.suppress) {
    return { enabled: true, applied: false, reason: decision.reason, bannedTokenCount: 0, ...scanMs() };
  }
  if (!cjkScan) {
    return { enabled: true, applied: false, reason: 'scan-failed', bannedTokenCount: 0 };
  }
  await cjkScan.ready;
  if (cjkScan.failed || cjkScan.ids == null) {
    return { enabled: true, applied: false, reason: 'scan-failed', bannedTokenCount: 0, ...scanMs() };
  }
  if (cjkScan.ids.length === 0) {
    return { enabled: true, applied: false, reason: 'scan-empty', bannedTokenCount: 0, ...scanMs() };
  }
  return { enabled: true, applied: true, reason: 'applied', bannedTokenCount: cjkScan.ids.length, ...scanMs() };
}

function classifyInitError(message: string): 'webgpu-unavailable' | 'oom' | 'init-failed' {
  const m = message.toLowerCase();
  if (m.includes('webgpu') && (m.includes('unavailable') || m.includes('not supported'))) {
    return 'webgpu-unavailable';
  }
  if (m.includes('out of memory') || m.includes('oom')) return 'oom';
  return 'init-failed';
}

// ─── generate ──────────────────────────────────────────────────────────────

async function handleGenerate(msg: Extract<WorkerInbound, { type: 'generate' }>): Promise<void> {
  if (!loaded) {
    post({
      type: 'error',
      generationId: msg.generationId,
      code: 'init-failed',
      message: 'Worker is not loaded',
    });
    return;
  }

  abortFlag = { aborted: false, generationId: msg.generationId };
  const filters: FilterChain = createFilterChain([
    '<|endoftext|>',
    '<|im_end|>',
    '<|end_of_turn|>',
    '<|eot_id|>',
    // Phi-3's turn-ender (token 32007) in text form. Harmless for other
    // models — they never emit this literal string.
    '<|end|>',
  ]);

  let promptTokens = 0;
  let completionTokens = 0;
  let seq = 0;

  const tokenizer = loaded.tokenizer as {
    apply_chat_template?: (messages: unknown[], options: Record<string, unknown>) => string;
    constructor?: { name?: string };
  } & ((text: string, options?: Record<string, unknown>) => Promise<unknown>);

  try {
    // ── Gate: refuse to generate without apply_chat_template ──────────
    // Without a proper chat template the model sees noise and emits noise.
    // This was previously a silent fallback to "SYSTEM:\nUSER:\nASSISTANT:"
    // which no model is trained on — the exact root cause of "word salad"
    // output. We now refuse loudly so the error surfaces in the UI.
    if (typeof tokenizer.apply_chat_template !== 'function') {
      post({
        type: 'error',
        generationId: msg.generationId,
        code: 'template-missing',
        message: 'Model tokenizer does not expose apply_chat_template — refusing to generate to avoid garbage output.',
        details: {
          tokenizerName: tokenizerName(tokenizer),
          modelId: loaded.modelId,
        },
      });
      return;
    }

    // ── Normalize system role per model's template strategy ───────────
    const strategy: SystemRoleSupport = msg.systemRoleStrategy ?? 'native';
    const normalizedMessages = normalizeMessagesForTemplate(
      msg.messages.map((m) => ({ role: m.role, content: m.content })),
      strategy,
    );

    let inputText: string;
    try {
      inputText = tokenizer.apply_chat_template!(
        normalizedMessages,
        // enable_thinking:false disables the Qwen3-arch <think> reasoning mode.
        // v1 surfaces NO reasoning UX, and thinking-on models burn the entire
        // token budget on hidden <think> blocks (real-hardware baseline: empty
        // answers, ~3254ms TTFT). It's an unknown/ignored kwarg for
        // non-thinking templates (Bonsai/Phi-3 ignore it; the boot-time
        // template smoke at handleInit catches any template that errors on it).
        { tokenize: false, add_generation_prompt: true, enable_thinking: false },
      );
    } catch (templateErr) {
      const templateMessage = templateErr instanceof Error ? templateErr.message : String(templateErr);
      post({
        type: 'error',
        generationId: msg.generationId,
        code: 'template-missing',
        message: `apply_chat_template threw: ${templateMessage}`,
        details: {
          tokenizerName: tokenizerName(tokenizer),
          modelId: loaded.modelId,
          originalError: templateMessage,
        },
      });
      return;
    }

    // TJS v4 renamed `return_tensors` → `return_tensor`. The legacy worker
    // hasn't migrated yet; this is the right shape going forward.
    const inputs = await tokenizer(inputText, { return_tensor: 'pt' });
    const inputIdsTensor = (inputs as {
      input_ids?: { data: ArrayLike<number | bigint>; dims?: number[] };
    }).input_ids;
    // FULL prompt length — receipts/impact rely on this meaning the whole
    // rendered prompt, NOT "new tokens only". Do not repurpose it for the KV
    // delta; the KV math uses `newTokenIds` below instead.
    promptTokens = inputIdsTensor?.dims?.[1] ?? 0;

    // ── KV-cache reuse decision ───────────────────────────────────────
    // `newTokenIds` is the full tokenization of this turn's render. Reuse is
    // valid iff the previously-cached sequence is a strict prefix of it; the
    // pure `decideKvReuse` gate enforces that. Non-prefix renders (edit,
    // regenerate, model switch, grounded front-injection) automatically miss
    // and prefill from scratch — identical to the pre-cache behavior — so no
    // special-casing is needed here. Sampling/option changes do NOT change
    // `newTokenIds`, so the gate correctly KEEPS the cache across them.
    const newTokenIds = inputIdsTensor ? idsOf(inputIdsTensor) : [];
    // The report embeds the gate decision (`decision: 'reuse' | 'miss'`) plus
    // the divergence point on a prefix miss. It leaves the worker on the
    // `done` message — receipts/diagnostics need it to tell a template-shaped
    // prefix miss from a runtime that never returned a cache (the two looked
    // identical from outside during the Qwen3.5 swap-gate failure).
    const kvReuse = buildKvReuseReport(cachedTokenIds ?? [], newTokenIds);

    // ── CJK suppression (opt-in models, conversation-gated) ───────────
    // Gates on the RAW msg.messages (system/user/assistant roles intact —
    // the gate must see roles, and normalizeMessagesForTemplate may have
    // merged the system turn away). Awaits the post-ready vocab scan only
    // when suppression is actually wanted.
    const cjkSuppression = await resolveCjkSuppression(msg.messages);

    const streamer = new TextStreamer(
      tokenizer as unknown as ConstructorParameters<typeof TextStreamer>[0],
      {
        skip_prompt: true,
        // `text` is whatever TextStreamer decoded for this step — it already
        // carries its own leading/trailing whitespace (e.g. " France"). We pass
        // it through `processThroughChain` (think/disclaimer/stop filters, none
        // of which delete inter-word spaces) and then concatenate verbatim in the
        // main-thread token batcher. So the occasional "capital ofFrance"
        // missing-space artifact is NOT introduced by our streaming/concat path —
        // it's a model/tokenizer decode artifact (a SentencePiece/BPE merge that
        // drops the expected ▁ leading space at a token boundary), observed on
        // both LFM2.5-1.2B and LFM2-2.6B. There is no clean host-side fix: we
        // cannot reliably distinguish a legitimately-joined word from a dropped
        // boundary space without a dictionary, and guessing would corrupt valid
        // output (URLs, code, compounds). Tracked as a model-side follow-up.
        callback_function: (text: string) => {
          if (abortFlag?.aborted) {
            throw new Error('__eco_abort__');
          }
          completionTokens++;
          const visible = processThroughChain(filters, text);
          if (visible.length > 0) {
            seq++;
            post({ type: 'token', generationId: msg.generationId, seq, text: visible });
          }
        },
      },
    );

    const model = loaded.model as {
      generate: (args: Record<string, unknown>) => Promise<{
        sequences?: { data: ArrayLike<number | bigint> };
        past_key_values?: unknown;
      }>;
    };
    // Forward the FULL per-model sampling profile (temperature + top_p/top_k/
    // repetition_penalty/no_repeat_ngram_size) via the pure, unit-tested
    // mapping. Default maxTokens is 512 to align with the runtime contract +
    // callers; callers pass an explicit value, so this only bounds an omission.
    //
    // `return_dict_in_generate: true` makes `generate` resolve to an object
    // ({ sequences, past_key_values, ... }) instead of a bare Tensor, so we can
    // capture the post-generation cache. It ALSO sets TJS's `keepCacheAlive`,
    // meaning TJS will NOT dispose the cache itself — ownership transfers to us
    // (we dispose on miss/invalidation). The streamer/filter/completionTokens
    // path is unchanged by this flag (spike-confirmed).
    //
    // On reuse we ALSO pass the held `past_key_values`. We keep sending the FULL
    // input_ids + attention_mask: TJS's decoder slices to only the NEW tokens
    // when a cache is present (spike-confirmed). We do NOT slice input_ids
    // ourselves — getting that off-by-one wrong is silent corruption.
    const generateArgs: Record<string, unknown> = {
      ...(inputs as Record<string, unknown>),
      ...toTransformersGenerateArgs(msg.options, { maxTokens: 512 }),
      return_dict_in_generate: true,
      streamer,
    };
    if (kvReuse.decision === 'reuse') {
      generateArgs.past_key_values = cachedPkv;
    }
    if (cjkSuppression.applied && cjkScan?.ids) {
      // TJS picks `suppress_tokens` off the kwargs into GenerationConfig →
      // SuppressTokensLogitsProcessor sets those logits to -Infinity each
      // step. Logits-level only: no effect on KV state or token ids. Copied
      // so the cached scan can never alias whatever TJS does with the arg.
      generateArgs.suppress_tokens = [...cjkScan.ids];
    }
    const out = await model.generate(generateArgs);

    // ── Commit the cache (clean completion only) ──────────────────────
    // We only reach here when generate resolved WITHOUT throwing — i.e. no
    // abort, no error. `out.sequences` is the full token sequence the returned
    // cache now covers, so committing both together keeps `cachedTokenIds` and
    // `cachedPkv` consistent.
    //
    // On a MISS, `out.past_key_values` is a NEW object (TJS built a fresh cache
    // because we passed none) — the OLD `cachedPkv` is now orphaned and must be
    // disposed to free its GPU tensors. On a REUSE, `out.past_key_values` IS the
    // same object we passed in, mutated to be longer — disposing it would free
    // the very cache we want to keep, so we must NOT dispose; the identity check
    // (`!== out.past_key_values`) distinguishes the two cases.
    // Commit only a CONSISTENT pair: the returned cache AND the sequence it
    // covers. If either is missing (e.g. a runtime/arch that doesn't round-trip
    // `past_key_values`), commit NOTHING — committing ids without a cache would
    // make the next turn's gate report "reuse" while generate silently full-
    // prefills against a null cache. `cacheCommitted` reports which case this
    // turn was, so that failure mode is visible in receipts instead of latent.
    const nextPkv = out.past_key_values ?? null;
    const nextIds = out.sequences ? idsOf(out.sequences) : null;
    const cacheCommitted = nextPkv != null && nextIds != null;
    if (cachedPkv && cachedPkv !== nextPkv) {
      await disposePkv(cachedPkv);
    }
    if (cacheCommitted) {
      cachedPkv = nextPkv;
      cachedTokenIds = nextIds;
    } else {
      // Ownership of a returned-but-uncommittable cache transferred to us
      // (keepCacheAlive) — free it rather than leak its GPU tensors.
      if (nextPkv && nextPkv !== cachedPkv) {
        await disposePkv(nextPkv);
      }
      cachedPkv = null;
      cachedTokenIds = null;
    }

    const tail = flushFilterChain(filters);
    if (tail.length > 0) {
      seq++;
      post({ type: 'token', generationId: msg.generationId, seq, text: tail });
    }
    post({
      type: 'done',
      generationId: msg.generationId,
      promptTokens,
      completionTokens,
      tokenizerName: tokenizerName(tokenizer),
      kvReuse: { ...kvReuse, cacheCommitted },
      cjkSuppression,
    });
  } catch (err) {
    // ⚠️ INVALIDATE on ANY non-clean exit — both abort AND error. The reuse
    // path may have thrown AFTER TJS already grew `cachedPkv` in place past
    // `cachedTokenIds.length` (its `get_seq_length()` is now longer than the ids
    // we recorded). Leaving the stale-but-mutated cache would let the next
    // turn's gate green-light a reuse while TJS slices at the longer length →
    // wrong input slice → silent context corruption. Dropping it forces a clean
    // full prefill next turn. Done BEFORE any early return so no path can skip
    // it. (We never reach the commit code above on a throw, so there is no
    // completed-cache to keep here.)
    await invalidateKvCache();
    const message = err instanceof Error ? err.message : String(err);
    if (message === '__eco_abort__' || abortFlag?.aborted) {
      // Caller already knows about the abort; nothing more to do.
      return;
    }
    // Error-path only: the posted error carries `message` but not the stack,
    // and TJS failures deep in the generation loop are undiagnosable without
    // one (the KV-reuse vision-encoder crash took a stack to localize).
    console.error('[eco/local-ai-worker] generation failed', err);
    const code = classifyGenerationError(message);
    post({ type: 'error', generationId: msg.generationId, code, message });
  } finally {
    abortFlag = null;
  }
}

// ─── unload ─────────────────────────────────────────────────────────────────

async function handleUnload(): Promise<void> {
  // Drop the held KV cache alongside the model so its GPU tensors are freed and
  // a later (re)load never inherits a stale cache. The CJK scan goes with it —
  // its token ids index this model's vocab.
  await invalidateKvCache();
  cjkScan = null;
  if (!loaded) return;
  const model = loaded.model as { dispose?: () => Promise<void> | void };
  try {
    if (typeof model.dispose === 'function') {
      await model.dispose();
    }
  } catch {
    // Best-effort; the main thread will terminate the worker after this.
  }
  loaded = null;
}

// ─── Post helper ───────────────────────────────────────────────────────────

function post(message: WorkerOutbound): void {
  self.postMessage(message);
}
