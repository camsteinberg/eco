// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * A fake WebLLM 0.2.84 engine whose request path follows the shipped library
 * (`@mlc-ai/web-llm/lib/index.js`) closely enough to show what lands in the KV
 * cache across turns. Only the tensors are fake: the pipeline keeps the ids it
 * has forwarded (`kv`), which is the ground truth the tests read.
 *
 * Modelled lines (the pnpm-patched build in node_modules):
 *   - `Conversation.getPromptArrayInternal` 9064: each message renders as
 *     role prefix + content + `seps[0]`; a reply header renders the role only.
 *   - `getPromptArrayLastRound` 9220: renders from `messages.length - 2`.
 *   - `compareConversationObject` 9319 and the engine's multi-round branch
 *     13368-13383: an equal stored conversation keeps the KV; an empty history
 *     always resets.
 *   - `prefillStep` 10273 / `getInputData` 11250: the system prefix ids and the
 *     whole conversation on an empty KV, the last round otherwise.
 *   - `decodeStep` 10410: forwards only the previous sampled id.
 *   - `processNextToken` 10486-10489: a stop id is never pushed or forwarded;
 *     a length stop (10516) leaves the last sampled id unforwarded.
 *   - `triggerStop` 10443: an interrupted reply is stored as decoded so far.
 *
 * The tokenizer encodes one id per character, except that "in" merges into
 * `IN_ID` — so a reply sampled as "i","n" re-encodes to a different id.
 */

import type { LogitProcessor } from '@mlc-ai/web-llm';
import type { ChatMessage } from '../../types';
import type { WebLLMChunk, WebLLMEngine } from '../../webllm-adapter';

export const IN_ID = 1000;
export const VOCAB_SIZE = 1001;
/** The model's stop id ('#'), which is also the first character of `SEP`. */
export const STOP_ID = '#'.codePointAt(0)!;
/** `seps[0]`: closes every message, like Qwen's `<|im_end|>\n`. */
export const SEP = '#\n';
export const SYSTEM_PREFIX_IDS = [2];

export const fakeTokenizer = {
  encode(text: string): Int32Array {
    const ids: number[] = [];
    for (let i = 0; i < text.length; ) {
      if (text.startsWith('in', i)) {
        ids.push(IN_ID);
        i += 2;
      } else {
        ids.push(text.codePointAt(i)!);
        i += 1;
      }
    }
    return Int32Array.from(ids);
  },
  decode(ids: Int32Array): string {
    return Array.from(ids, (id) => (id === IN_ID ? 'in' : String.fromCodePoint(id))).join('');
  },
};

export const SEP_IDS = Array.from(fakeTokenizer.encode(SEP));

type Role = 'user' | 'assistant';
type Message = [Role, string, string | undefined];

const ROLES: Record<Role, string> = { user: 'user', assistant: 'assistant' };

export class FakeConversation {
  messages: Message[] = [];
  override_system_message: string | undefined = undefined;
  function_string = '';
  use_function_calling = false;
  isTextCompletion = false;
  readonly config = {
    seps: [SEP],
    roles: ROLES,
    system_prefix_token_ids: SYSTEM_PREFIX_IDS,
  };

  /**
   * When set, an assistant message that is followed by a later message drops
   * this leading text — a template that rewrites history (as Qwen3's HF
   * template does with think blocks), i.e. one that is NOT append-only.
   */
  constructor(private readonly stripEarlierReplyPrefix?: string) {}

  private render(addSystem: boolean, startPos: number): string[] {
    const ret: string[] = [];
    if (addSystem) ret.push(`<system>\n${this.override_system_message ?? 'default'}${SEP}`);
    for (let i = startPos; i < this.messages.length; i++) {
      const [role, roleName, content] = this.messages[i]!;
      if (content === undefined) {
        ret.push(`<${roleName}>\n`);
        continue;
      }
      let text = content;
      const prefix = this.stripEarlierReplyPrefix;
      if (prefix && role === 'assistant' && i < this.messages.length - 1 && text.startsWith(prefix)) {
        text = text.slice(prefix.length);
      }
      ret.push(`<${roleName}>\n${text}${SEP}`);
    }
    return ret;
  }

  getPromptArray(_config: unknown): string[] {
    return this.render(true, 0);
  }

  getPromptArrayLastRound(_config: unknown): string[] {
    if (this.messages.length < 3) throw new Error('needs to call getPromptArray for the first message');
    return this.render(false, this.messages.length - 2);
  }

  appendMessage(role: Role, content: string): void {
    this.messages.push([role, ROLES[role], content]);
  }

  appendReplyHeader(role: Role): void {
    this.messages.push([role, ROLES[role], undefined]);
  }

  finishReply(message: string): void {
    this.messages[this.messages.length - 1]![2] = message;
  }

  reset(): void {
    this.messages = [];
    this.override_system_message = undefined;
  }
}

/** `getConversationFromChatCompletionRequest` (lib 9399): every message but the last. */
export function conversationFromMessages(
  messages: ChatMessage[],
  stripEarlierReplyPrefix?: string,
): FakeConversation {
  const conv = new FakeConversation(stripEarlierReplyPrefix);
  messages.slice(0, -1).forEach((m, i) => {
    if (m.role === 'system') {
      if (i !== 0) throw new Error('system message must come first');
      conv.override_system_message = m.content;
    } else {
      conv.appendMessage(m.role as Role, m.content);
    }
  });
  return conv;
}

function sameConversation(a: FakeConversation, b: FakeConversation, contentBlind: boolean): boolean {
  if (a.override_system_message !== b.override_system_message && !contentBlind) return false;
  if (a.messages.length !== b.messages.length) return false;
  if (a.messages.length === 0) return true;
  return a.messages.every((m, i) => {
    const n = b.messages[i]!;
    return m[0] === n[0] && m[1] === n[1] && (contentBlind || m[2] === n[2]);
  });
}

/** The ids a full prefill of `messages` feeds — the KV every turn must match. */
export function fullPrefillIds(messages: ChatMessage[], stripEarlierReplyPrefix?: string): number[] {
  const conv = conversationFromMessages(messages, stripEarlierReplyPrefix);
  conv.appendMessage('user', messages[messages.length - 1]!.content);
  conv.appendReplyHeader('assistant');
  return [...SYSTEM_PREFIX_IDS, ...conv.getPromptArray(null).flatMap((s) => Array.from(fakeTokenizer.encode(s)))];
}

export class FakePipeline {
  readonly tokenizer = fakeTokenizer;
  readonly config = {};
  readonly slidingWindowSize = -1;
  readonly tvm = { beginScope: () => undefined, endScope: () => undefined };
  conversation = new FakeConversation();
  filledKVCacheLength = 0;
  logitProcessor: LogitProcessor | undefined = undefined;

  /** Ground truth: every id forwarded into the KV cache, in order. */
  kv: number[] = [];
  /** The KV when the first id of the latest reply was sampled. */
  kvAtFirstSample: number[] | null = null;
  /** The ids the latest prefill forwarded. */
  prefilled: number[] = [];
  /** Ids the logit processor changed at the latest first sample. */
  penalisedAtFirstSample: number[] = [];
  promptLen = 0;

  outputIds: number[] = [];
  outputMessage = '';
  stopTriggered = false;
  finishReason: string | undefined;
  private replies: number[][] = [];

  /** Script the next reply, as text (canonical ids) or as raw sampled ids. */
  queueReply(reply: string | number[]): void {
    this.replies.push(typeof reply === 'string' ? Array.from(fakeTokenizer.encode(reply)) : [...reply]);
  }

  getConversationObject(): FakeConversation {
    return this.conversation;
  }

  setConversation(conv: FakeConversation): void {
    this.conversation = conv;
  }

  resetChat(): void {
    this.conversation.reset();
    this.resetKVCache();
    this.filledKVCacheLength = 0;
    this.logitProcessor?.resetState();
  }

  resetKVCache(): void {
    this.kv = [];
  }

  async embedAndForward(inputData: unknown[], len: number): Promise<unknown> {
    for (const d of inputData) {
      if (Array.isArray(d)) this.kv.push(...(d as number[]));
    }
    this.filledKVCacheLength += len;
    return {};
  }

  async getInputData(): Promise<[unknown[], number, unknown]> {
    let tokens: number[] = [];
    let prompts: string[];
    if (this.filledKVCacheLength === 0) {
      tokens = [...this.conversation.config.system_prefix_token_ids];
      prompts = this.conversation.getPromptArray(this.config);
    } else {
      prompts = this.conversation.getPromptArrayLastRound(this.config);
    }
    let promptLen = 0;
    for (const p of prompts) {
      const encoded = Array.from(this.tokenizer.encode(p));
      promptLen += encoded.length;
      tokens.push(...encoded);
    }
    return [[tokens], promptLen, () => 0];
  }

  async prefillStep(input: string, maxTokens: number): Promise<void> {
    this.outputIds = [];
    this.outputMessage = '';
    this.stopTriggered = false;
    this.finishReason = undefined;
    this.conversation.appendMessage('user', input);
    this.conversation.appendReplyHeader('assistant');
    const [inputData, promptLen] = await this.getInputData();
    this.promptLen = promptLen;
    const ids = (inputData as number[][]).flat();
    this.prefilled = ids;
    await this.embedAndForward(inputData, ids.length);
    this.kvAtFirstSample = [...this.kv];
    this.processNextToken(this.sample(true), maxTokens);
  }

  async decodeStep(maxTokens: number): Promise<void> {
    await this.embedAndForward([[this.outputIds[this.outputIds.length - 1]!]], 1);
    this.processNextToken(this.sample(false), maxTokens);
  }

  private sample(first: boolean): number {
    const logits = new Float32Array(VOCAB_SIZE).fill(1);
    const out = this.logitProcessor ? this.logitProcessor.processLogits(logits) : logits;
    if (first) {
      this.penalisedAtFirstSample = [];
      out.forEach((v, id) => {
        if (v !== 1) this.penalisedAtFirstSample.push(id);
      });
    }
    // An exhausted script stays queued so the NEXT sample is the stop id.
    const token = this.replies[0]?.shift() ?? STOP_ID;
    this.logitProcessor?.processSampledToken(token);
    return token;
  }

  private processNextToken(token: number, maxTokens: number): void {
    if (token === STOP_ID) {
      this.replies.shift();
      this.stopTriggered = true;
      this.finishReason = 'stop';
    } else {
      this.outputIds.push(token);
    }
    this.outputMessage = this.tokenizer.decode(Int32Array.from(this.outputIds));
    if (!this.stopTriggered && this.outputIds.length >= maxTokens) {
      this.replies.shift();
      this.stopTriggered = true;
      this.finishReason = 'length';
    }
    if (this.stopTriggered) this.conversation.finishReply(this.outputMessage);
  }

  triggerStop(): void {
    if (this.stopTriggered) return;
    this.replies.shift();
    this.stopTriggered = true;
    this.finishReason = 'abort';
    this.conversation.finishReply(this.outputMessage);
  }
}

export const FAKE_MLC_ID = 'SmolLM2-1.7B-Instruct-q4f16_1-MLC';

export type FakeEngineOptions = {
  /**
   * Simulates an engine whose conversation compare ignores message text, so it
   * keeps its KV for a history the caller has edited. The adapter must not
   * rely on the engine's compare for correctness.
   */
  contentBlindCompare?: boolean;
  stripEarlierReplyPrefix?: string;
};

export class FakeMlcEngine implements WebLLMEngine {
  readonly pipeline = new FakePipeline();
  readonly loadedModelIdToPipeline = new Map<string, unknown>([[FAKE_MLC_ID, this.pipeline]]);
  resetChatCalls = 0;
  /** Whether the latest request kept its KV through the engine's own compare. */
  multiRound = false;

  constructor(private readonly options: FakeEngineOptions = {}) {
    this.pipeline.conversation = new FakeConversation(options.stripEarlierReplyPrefix);
  }

  async reload(): Promise<void> {}
  async unload(): Promise<void> {}

  async resetChat(): Promise<void> {
    this.resetChatCalls++;
    this.pipeline.resetChat();
  }

  interruptGenerate(): void {
    this.pipeline.triggerStop();
  }

  readonly chat = {
    completions: {
      create: async (args: { messages: ChatMessage[]; max_tokens?: number }): Promise<AsyncIterable<WebLLMChunk>> =>
        this.stream(args.messages, args.max_tokens ?? 512),
    },
  };

  private async *stream(messages: ChatMessage[], maxTokens: number): AsyncGenerator<WebLLMChunk> {
    const p = this.pipeline;
    const newConv = conversationFromMessages(messages, this.options.stripEarlierReplyPrefix);
    const same = sameConversation(p.getConversationObject(), newConv, this.options.contentBlindCompare === true);
    this.multiRound = same && newConv.messages.length > 0;
    if (!this.multiRound) {
      p.resetChat();
      p.setConversation(newConv);
    }
    await p.prefillStep(messages[messages.length - 1]!.content, maxTokens);

    let sent = 0;
    const chunk = (): WebLLMChunk => {
      const delta = p.outputMessage.slice(sent);
      sent = p.outputMessage.length;
      return {
        choices: [
          {
            delta: delta ? { content: delta } : {},
            ...(p.stopTriggered ? { finish_reason: p.finishReason } : {}),
          },
        ],
      };
    };
    yield chunk();
    while (!p.stopTriggered) {
      await p.decodeStep(maxTokens);
      yield chunk();
    }
    yield { choices: [], usage: { prompt_tokens: p.promptLen, completion_tokens: p.outputIds.length } };
  }
}
