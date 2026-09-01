// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * PROMPT-EQUIVALENCE BASELINE for R4 (pure `assemble()` + one stream).
 *
 * Records, for a matrix of (model x conversation x custom-instructions x path),
 * the exact `{ messages, options }` that useChat hands to the inference seam —
 * i.e. the prompt as the model will actually see it. R4 moves prompt composition
 * out of `useChat` into a pure `assemble()`; this file is how "behaviour
 * identical" is proved rather than asserted.
 *
 * Two modes:
 *   PROMPT_BASELINE_WRITE=1 vitest run prompt-equivalence  -> (re)writes baseline.json
 *   vitest run prompt-equivalence                          -> compares against it
 *
 * The check is behavioural: it goes red when the assembled prompt changes, and
 * cannot be satisfied by renaming an identifier.
 *
 * Non-vacuity: the run prints the distinct value counts for every recorded
 * field. A baseline whose options or system prompts are constant across ten
 * models is a broken harness, not a passing one — see the s34 record.
 *
 * Fixtures are built from the real catalog (`getModel`), never cast into shape.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { SlotState } from '../../local-ai/lifecycle/slots';
import type { Slot } from '../../local-ai/types';

type RecordedCall = {
  messages: Array<{ role: string; content: string }>;
  modelId: string;
  options: Record<string, unknown>;
};

const shared = vi.hoisted(() => ({
  calls: [] as RecordedCall[],
  scripts: [] as string[][],
  fastSlotState: undefined as SlotState | undefined,
}));

/** Strip non-serialisable option values (callbacks, signals) — keep the data. */
function plainOptions(options: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(options ?? {})) {
    if (typeof v === 'function' || v instanceof AbortSignal) continue;
    out[k] = v;
  }
  return out;
}

vi.mock('../../local-ai/adapters/useChatLegacyShim', () => ({
  createLocalAiLegacyInference: () => ({
    generate: (
      messages: Array<{ role: string; content: string }>,
      modelId: string,
      options: Record<string, unknown> | undefined,
    ): ReadableStream<string> => {
      shared.calls.push({ messages, modelId, options: plainOptions(options) });
      const tokens = shared.scripts.shift() ?? ['ok'];
      return new ReadableStream<string>({
        start(controller) {
          for (const t of tokens) controller.enqueue(t);
          controller.close();
        },
      });
    },
  }),
}));

const EMPTY_SMART: SlotState = { slot: 'eco-smart' as Slot, modelId: null, model: null, status: 'empty' };

vi.mock('../../local-ai/lifecycle/slots', () => ({
  SLOTS: ['eco-fast', 'eco-smart'] as ReadonlyArray<Slot>,
  getSlot: (slot: Slot): SlotState => {
    if (slot === 'eco-smart') return EMPTY_SMART;
    return shared.fastSlotState ?? { slot: 'eco-fast' as Slot, modelId: null, model: null, status: 'empty' };
  },
  getSlotForModel: (modelId: string): Slot | null =>
    shared.fastSlotState?.modelId === modelId ? ('eco-fast' as Slot) : null,
  hasReadySlot: () => shared.fastSlotState?.status === 'ready',
  setSlotStorage: () => {},
  setSlot: () => {},
  setSlotStatus: () => {},
  subscribe: () => () => {},
  getDemotedFrom: () => undefined,
}));

vi.mock('../../local-ai/runtime/usage-store', () => ({
  getLastUsage: () => null,
  getLastTemplateName: () => null,
  setLastUsage: () => {},
  setLastTemplateName: () => {},
  ranToCapFromUsage: () => false,
}));

vi.mock('../../local-ai/lifecycle/generation-receipt', () => ({
  recordGenerationReceipt: () => {},
  recordGenerationReceiptAsync: () => {},
  hashSystemPrompt: async () => 'baseline',
}));

vi.mock('../../local-ai/lifecycle/recovery', () => ({
  resolveReadyLocalRecoveryModelId: async () => shared.fastSlotState?.modelId ?? null,
}));

// Imports AFTER the mocks so the hook picks up the mocked seams.
import { useChat } from '../../hooks/useChat';
import { useChatStore } from '../../stores/chatStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { getModel } from '../../local-ai/catalog/catalog';
import { getCatalog } from '../../local-ai/catalog/catalog';

// ─── Matrix ────────────────────────────────────────────────────────────────

const MODEL_IDS = getCatalog().map((entry) => entry.id);

type Conversation = { name: string; turns: string[]; replies: string[][] };

/**
 * Chosen to span the intent classifier's live range (closed / open / code /
 * strict-format) and to make the recap machinery fire: the two-turn case has a
 * numeric assistant reply, which is what a figure recap attaches to.
 */
const CONVERSATIONS: Conversation[] = [
  { name: 'closed-fact', turns: ['what is the capital of France'], replies: [['Paris.']] },
  {
    name: 'open-explain',
    turns: ['how does a heat pump actually work, and is it worth it in an old house'],
    replies: [['A heat pump moves heat rather than making it.']],
  },
  { name: 'code', turns: ['write a python function that reverses a list'], replies: [['def rev(x): return x[::-1]']] },
  { name: 'strict-format', turns: ['reply with just the number: 17 * 23'], replies: [['391']] },
  {
    name: 'multi-turn-figure',
    turns: ['my package weighs 42.5 kg, what does that cost to ship', 'and if I split it into two boxes'],
    replies: [['At 42.5 kg the rate is about $86.'], ['Two boxes of 21.25 kg each would run about $54.']],
  },
  {
    // Stated details (place, date, time, headcount) plus a figure in the user
    // turns — this is the shape `buildDetailRecap` / `buildFigureRecap` were
    // measured on, and it is what makes the recap branch of assembly non-inert.
    name: 'multi-turn-recap',
    turns: [
      'im booking a table at the italian on bridgford road for sunday 8th march, 1pm, six of us',
      'nobody can do more than about 25 quid a head - can you draft the message to the group',
    ],
    replies: [['Sounds good.'], ['Here is a draft.']],
  },
];

const CUSTOM_INSTRUCTIONS = ['', 'Always answer in British English and keep it under three sentences.'];

const PATHS = ['send', 'edit', 'regenerate', 'offline-continue'] as const;
type Path = (typeof PATHS)[number];

/** Paths other than `send` run on this subset — the composition code is shared. */
const PATH_MODEL_SUBSET = ['candidate/lfm2.5-1.2b-instruct-onnx', 'local/qwen3-0.6b'];

const BASELINE_PATH = join(__dirname, 'baseline.json');
const WRITE = process.env.PROMPT_BASELINE_WRITE === '1';

function setModel(modelId: string): void {
  const model = getModel(modelId);
  if (!model) throw new Error(`catalog has no entry for ${modelId}`);
  shared.fastSlotState = { slot: 'eco-fast' as Slot, modelId, model, status: 'ready' };
}

function resetChatStore(modelId: string): void {
  useChatStore.setState({
    messages: [],
    composerDraft: '',
    streamPhase: 'idle',
    isStreaming: false,
    error: null,
    selectedModel: modelId,
    fileAttachments: [],
    approvedTools: [],
    activeToolCalls: [],
    localToolNoticeShown: false,
    routeRecommendationSnapshot: null,
  });
}

function lastAssistant() {
  return [...useChatStore.getState().messages].reverse().find((m) => m.role === 'assistant');
}

async function runCell(
  modelId: string,
  conversation: Conversation,
  customInstructions: string,
  path: Path,
): Promise<RecordedCall[]> {
  setModel(modelId);
  resetChatStore(modelId);
  useSettingsStore.setState({ customInstructions });
  shared.scripts = conversation.replies.map((r) => [...r]);
  shared.calls.length = 0;

  const { result } = renderHook(() => useChat());
  for (const turn of conversation.turns) {
    await act(async () => {
      await result.current.sendMessage(turn);
    });
  }

  if (path === 'send') return shared.calls.map((c) => c);

  // Everything below records only the follow-up action's calls.
  shared.calls.length = 0;
  shared.scripts = [['follow-up reply']];

  if (path === 'edit') {
    const firstUser = useChatStore.getState().messages.find((m) => m.role === 'user')!;
    await act(async () => {
      await result.current.editMessage(firstUser.id, `${conversation.turns[0]} (edited)`);
    });
  } else if (path === 'regenerate') {
    const assistant = lastAssistant()!;
    await act(async () => {
      await result.current.regenerateMessage(assistant.id);
    });
  } else {
    // offline-continue: an interrupted reply resumed with no network.
    const assistant = lastAssistant()!;
    act(() => {
      useChatStore.setState((s) => ({
        messages: s.messages.map((m) =>
          m.id === assistant.id
            ? { ...m, content: 'The first part of the answer was', status: 'complete' as const, streamInterrupted: true }
            : m,
        ),
      }));
    });
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    await act(async () => {
      await result.current.retryMessage(assistant.id);
    });
    onLine.mockRestore();
  }
  return shared.calls.map((c) => c);
}

type Cell = {
  key: string;
  modelId: string;
  conversation: string;
  customInstructions: 'none' | 'set';
  path: Path;
  calls: RecordedCall[];
};

beforeEach(() => {
  shared.calls.length = 0;
  shared.scripts = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('R4 prompt equivalence', () => {
  it('assembles the same {messages, options} as the recorded baseline', async () => {
    const cells: Cell[] = [];

    for (const modelId of MODEL_IDS) {
      for (const conversation of CONVERSATIONS) {
        for (const customInstructions of CUSTOM_INSTRUCTIONS) {
          for (const path of PATHS) {
            if (path !== 'send' && !PATH_MODEL_SUBSET.includes(modelId)) continue;
            const calls = await runCell(modelId, conversation, customInstructions, path);
            cells.push({
              key: `${modelId}|${conversation.name}|${customInstructions ? 'set' : 'none'}|${path}`,
              modelId,
              conversation: conversation.name,
              customInstructions: customInstructions ? 'set' : 'none',
              path,
              calls,
            });
          }
        }
      }
    }

    // ── Non-vacuity report ────────────────────────────────────────────────
    // Printed on every run. A field with one distinct value across the whole
    // matrix means the harness is not reaching the code it claims to guard.
    const distinct = (fn: (c: Cell) => string) => new Set(cells.map(fn)).size;
    const systemPrompts = new Set<string>();
    const optionSets = new Set<string>();
    let emptyCells = 0;
    for (const cell of cells) {
      if (cell.calls.length === 0) emptyCells++;
      for (const call of cell.calls) {
        const sys = call.messages.find((m) => m.role === 'system');
        if (sys) systemPrompts.add(sys.content);
        optionSets.add(JSON.stringify(call.options));
      }
    }
    // eslint-disable-next-line no-console
    console.log(
      [
        `[non-vacuity] cells=${cells.length} emptyCells=${emptyCells}`,
        `[non-vacuity] distinct system prompts=${systemPrompts.size}`,
        `[non-vacuity] distinct option sets=${optionSets.size}`,
        `[non-vacuity] distinct message shapes=${distinct((c) => JSON.stringify(c.calls.map((x) => x.messages.map((m) => m.role))))}`,
      ].join('\n'),
    );

    expect(emptyCells).toBe(0);
    expect(systemPrompts.size).toBeGreaterThan(1);
    expect(optionSets.size).toBeGreaterThan(1);

    const serialised = `${JSON.stringify(cells, null, 2)}\n`;
    if (WRITE) {
      writeFileSync(BASELINE_PATH, serialised);
      // eslint-disable-next-line no-console
      console.log(`[baseline] wrote ${cells.length} cells to ${BASELINE_PATH}`);
      return;
    }
    const expected = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Cell[];
    expect(cells).toEqual(expected);
  }, 600_000);
});
