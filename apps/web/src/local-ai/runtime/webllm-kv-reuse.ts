// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Multi-turn KV-cache reuse for the WebLLM runtime, and the gate that keeps it
 * exact.
 *
 * WebLLM 0.2.84 keeps the previous turn's KV cache when the incoming history
 * equals its stored conversation (`compareConversationObject`,
 * `lib/index.js:9319`; the engine's branch at 13368-13383) and then prefills
 * only the last round (`getPromptArrayLastRound`, 9220). That round starts at
 * the new user message, but the separator that closes the previous reply
 * (`seps[0]`, `<|im_end|>\n` for Qwen) was never fed: the stop id is not
 * forwarded (10486-10489). Measured on Qwen2.5-0.5B, a model reading that cache
 * loops on its second turn.
 *
 * The gate wraps the loaded pipeline instance (the engine calls these methods
 * on `this`, so instance wrappers see every call):
 *   - `embedAndForward` / `resetKVCache`: it records every id forwarded into
 *     the KV cache, cleared with the cache.
 *   - `prepare()`, run by the adapter before each request: the cache may be
 *     kept only if the engine will take its multi-round branch AND the
 *     recorded ids are a strict prefix of the stored conversation's full
 *     render. Otherwise the adapter clears it through the public `resetChat()`
 *     and the whole conversation is prefilled.
 *   - `getInputData`: on a kept cache, the prefill feeds the rest of the full
 *     render after the ids already held — the separator included — instead of
 *     the engine's last-round ids, so the cache equals a full prefill of the
 *     conversation, id for id.
 *
 * A strict id prefix is the Transformers worker's rule too (`decideKvReuse`).
 * A reply whose sampled ids re-encode differently (same text, different ids)
 * is not a prefix, so that turn re-reads the conversation in canonical ids and
 * the turns after it reuse again.
 */

import {
  buildKvReuseReport,
  decideKvReuse,
  divergenceWindow,
  longestCommonPrefixLen,
  type KvReuseReport,
} from './kv-cache';
import type { ChatMessage } from './types';

/** The fields of WebLLM 0.2.84's `LLMChatPipeline` the gate reads and wraps. */
type GatePipeline = {
  tokenizer: { encode(text: string): Int32Array; decode(ids: Int32Array): string };
  conversation: {
    messages: Array<[string, string, unknown]>;
    override_system_message?: string;
    function_string?: string;
    use_function_calling?: boolean;
    isTextCompletion?: boolean;
    config: { system_prefix_token_ids?: number[] | null; roles?: Record<string, string> };
    getPromptArray(config: unknown): (string | (string | object)[])[];
  };
  config: unknown;
  filledKVCacheLength: number;
  slidingWindowSize?: number;
  tvm?: { beginScope(): void; endScope(): void };
  embedAndForward(inputData: unknown[], len: number): Promise<unknown>;
  resetKVCache(): void;
  getInputData(): Promise<[unknown[], number, unknown]>;
};

const gates = new WeakMap<object, WebLLMKvGate>();

export class WebLLMKvGate {
  private readonly pipeline: GatePipeline;
  private ids: number[] = [];
  /** The KV ids when this request began, before any reset. */
  private held: number[] = [];
  private lastReport: KvReuseReport | null = null;

  /**
   * Wrap `pipeline` once. Null when it is not reachable or its shape is not
   * the one this gate knows — the adapter then clears the conversation before
   * every request.
   */
  static install(pipeline: unknown): WebLLMKvGate | null {
    if (!isGatePipeline(pipeline)) return null;
    let gate = gates.get(pipeline);
    if (!gate) {
      gate = new WebLLMKvGate(pipeline);
      gates.set(pipeline, gate);
    }
    return gate;
  }

  private constructor(pipeline: GatePipeline) {
    this.pipeline = pipeline;

    const forward = pipeline.embedAndForward.bind(pipeline);
    pipeline.embedAndForward = (inputData, len) => {
      for (const data of inputData) {
        // An image stands for many positions; one entry for it leaves the count
        // short of the engine's, which no later request will reuse.
        if (Array.isArray(data)) this.ids.push(...(data as number[]));
        else this.ids.push(-1);
      }
      return forward(inputData, len);
    };

    const resetKVCache = pipeline.resetKVCache.bind(pipeline);
    pipeline.resetKVCache = () => {
      this.ids = [];
      resetKVCache();
    };

    const getInputData = pipeline.getInputData.bind(pipeline);
    pipeline.getInputData = () => this.inputData(getInputData);
  }

  /**
   * Every id in the KV cache, in order. Read after prefill, it is the whole
   * prompt the model sampled from — on a reused turn, including the ids it
   * generated in earlier replies.
   */
  get kvIds(): readonly number[] {
    return this.ids;
  }

  /** This request's reuse report: set during prefill, null before it. */
  get report(): KvReuseReport | null {
    return this.lastReport;
  }

  /**
   * Whether the KV cache may be kept for `messages`. Called once per request,
   * before `create()`; false means the caller must clear the conversation.
   */
  prepare(messages: readonly ChatMessage[]): boolean {
    const p = this.pipeline;
    this.held = [...this.ids];
    this.lastReport = null;
    // A sliding window evicts from the cache, so the recorded ids stop
    // describing it.
    if (p.slidingWindowSize != null && p.slidingWindowSize !== -1) return false;
    // A forward the gate did not see (or one that threw) leaves the counts apart.
    if (this.ids.length === 0 || this.ids.length !== p.filledKVCacheLength) return false;
    if (!engineKeepsConversation(p.conversation, messages)) return false;
    // The cache holds the stored conversation's render minus the separator that
    // closes the last reply; any other difference (an interrupted reply's ids, a
    // reply sampled in ids that re-encode differently) is a re-read.
    const stored = renderIds(p);
    return stored !== null && decideKvReuse(this.ids, stored).reuse;
  }

  private async inputData(
    original: () => Promise<[unknown[], number, unknown]>,
  ): Promise<[unknown[], number, unknown]> {
    const p = this.pipeline;
    if (p.conversation.isTextCompletion) return original();
    // The conversation now carries the new user message and the reply header,
    // so this is exactly what a full prefill feeds (`getInputData`, 11266-11320).
    const full = renderIds(p);

    if (p.filledKVCacheLength === 0) {
      const out = await original();
      this.lastReport = full ? this.missReport(this.held, full) : null;
      return out;
    }

    if (
      full &&
      this.ids.length === p.filledKVCacheLength &&
      decideKvReuse(this.ids, full).reuse
    ) {
      // Called for its image-size callback; its last-round ids are replaced.
      const [, , getEmbedSize] = await original();
      const rest = full.slice(this.ids.length);
      this.lastReport = { decision: 'reuse', cachedLen: this.ids.length, promptLen: full.length };
      return [[rest], rest.length, getEmbedSize];
    }

    // Defensive: `prepare()` let the cache through, yet it is not a prefix of
    // the new render. Only a template that rewrites earlier messages once a new
    // one follows can do this, and no shipping WebLLM entry has one. Clear the
    // cache in place (what `resetChat()` does, minus the conversation) so the
    // engine takes its full-prefill branch.
    const kept = this.ids;
    p.tvm?.beginScope();
    try {
      p.resetKVCache();
    } finally {
      p.tvm?.endScope();
    }
    p.filledKVCacheLength = 0;
    const out = await original();
    const at = full ? longestCommonPrefixLen(kept, full) : 0;
    this.lastReport = {
      decision: 'miss',
      reason: 'reset-during-prefill',
      cachedLen: kept.length,
      promptLen: full ? full.length : out[1],
      ...(full
        ? { commonPrefixLen: at, divergence: divergenceWindow(kept, full, at, (ids) => this.decode(ids)) }
        : {}),
    };
    return out;
  }

  private missReport(held: readonly number[], full: readonly number[]): KvReuseReport {
    const report = buildKvReuseReport(held, full);
    if (report.decision === 'reuse') {
      // The held ids were a prefix of this render, but the cache was cleared
      // before prefill anyway: the engine's own conversation check differed, or
      // the gate could not vouch for the cache.
      return {
        decision: 'miss',
        reason: 'reset-before-prefill',
        cachedLen: report.cachedLen,
        promptLen: report.promptLen,
      };
    }
    if (report.reason === 'not-strict-prefix' && report.commonPrefixLen !== undefined) {
      report.divergence = divergenceWindow(held, full, report.commonPrefixLen, (ids) => this.decode(ids));
    }
    return report;
  }

  private decode(ids: readonly number[]): string {
    return this.pipeline.tokenizer.decode(Int32Array.from(ids));
  }
}

/**
 * Whether WebLLM will keep its stored conversation, and so its KV cache, for
 * `messages`: a mirror of `compareConversationObject` (lib 9319) against the
 * history as `getConversationFromChatCompletionRequest` (9399) builds it — all
 * messages but the last, a leading system message as the override — plus the
 * engine's reset on an empty history (13375). It is at least as strict as the
 * engine: a wrong "resets" costs one re-read, and a wrong "keeps" lands on the
 * engine's own reset or the prefix check at prefill.
 */
function engineKeepsConversation(
  conv: GatePipeline['conversation'],
  messages: readonly ChatMessage[],
): boolean {
  const history = messages.slice(0, -1);
  const system = history[0]?.role === 'system' ? history[0].content : undefined;
  const turns = system === undefined ? history : history.slice(1);
  if (turns.length === 0 || turns.length !== conv.messages.length) return false;
  if (
    conv.override_system_message !== system ||
    (conv.function_string ?? '') !== '' ||
    conv.use_function_calling === true ||
    conv.isTextCompletion === true
  ) {
    return false;
  }
  return turns.every((m, i) => {
    const [role, roleName, content] = conv.messages[i]!;
    return m.role === role && m.content === content && roleName === conv.config.roles?.[m.role];
  });
}

/**
 * The ids a full prefill of the pipeline's current conversation feeds: the
 * system prefix ids, then each piece of `getPromptArray()` encoded separately
 * (`getInputData`, lib 11266-11320). Null when a piece carries an image.
 */
function renderIds(p: GatePipeline): number[] | null {
  const out = [...(p.conversation.config.system_prefix_token_ids ?? [])];
  for (const piece of p.conversation.getPromptArray(p.config)) {
    for (const part of typeof piece === 'string' ? [piece] : piece) {
      if (typeof part !== 'string') return null;
      out.push(...p.tokenizer.encode(part));
    }
  }
  return out;
}

function isGatePipeline(value: unknown): value is GatePipeline {
  if (typeof value !== 'object' || value === null) return false;
  const p = value as {
    tokenizer?: { encode?: unknown; decode?: unknown };
    conversation?: { getPromptArray?: unknown; messages?: unknown };
    filledKVCacheLength?: unknown;
    embedAndForward?: unknown;
    resetKVCache?: unknown;
    getInputData?: unknown;
  };
  return (
    typeof p.tokenizer?.encode === 'function' &&
    typeof p.tokenizer.decode === 'function' &&
    typeof p.conversation?.getPromptArray === 'function' &&
    Array.isArray(p.conversation.messages) &&
    typeof p.filledKVCacheLength === 'number' &&
    typeof p.embedAndForward === 'function' &&
    typeof p.resetKVCache === 'function' &&
    typeof p.getInputData === 'function'
  );
}
