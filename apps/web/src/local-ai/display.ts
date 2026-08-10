// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Display-layer mapping for v1.0 catalog models.
 *
 * The catalog stores technical metadata (vendor, sizeGB, format). This
 * module remaps those to benefit-oriented, brand-safe copy per
 * DESIGN-REFERENCE.md:84 ("Never expose model names, VRAM, or token
 * counts in primary UI"). The raw metadata still appears behind the
 * "Show technical details" disclosure for transparency (AGPL).
 *
 * The mapping lives at the display boundary — no catalog data is mutated.
 */

import type { ModelConfig, Slot } from './types';
import { SLOTS, type SlotStatus } from './lifecycle/slots';
import { isLocalAiSlot } from './util';

export type DisplayInfo = {
  /** Branded friendly name: "Eco Balanced (Bonsai)" */
  friendlyName: string;
  /** One-line quality phrase: "Quickest replies · small footprint" */
  qualityPhrase: string;
  /** Tertiary provenance line: "Hugging Face · 1.0 GB" */
  provenance: string;
};

const DISPLAY_MAP: Record<string, Omit<DisplayInfo, 'provenance'> & { provider: string }> = {
  'local/phi3-mini-4k-q4f16': {
    friendlyName: 'Eco Reasoning (Microsoft)',
    qualityPhrase: 'Strongest at math and code',
    provider: 'Microsoft',
  },
  'candidate/lfm2.5-1.2b-instruct-onnx': {
    friendlyName: 'Eco Fast (Liquid)',
    qualityPhrase: 'The everyday default · quick, clear answers',
    provider: 'Liquid AI',
  },
  // The plain-int4 build of the same 1.2B, for older graphics hardware — same
  // model, so same "Eco Fast" branding (f16-less users get the same experience).
  'candidate/lfm2.5-1.2b-instruct-q4-onnx': {
    friendlyName: 'Eco Fast (Liquid)',
    qualityPhrase: 'The everyday default · quick, clear answers',
    provider: 'Liquid AI',
  },
  'candidate/lfm2.5-350m-onnx': {
    friendlyName: 'Eco Light (Liquid)',
    qualityPhrase: 'Smallest footprint · best for older devices',
    provider: 'Liquid AI',
  },
  'candidate/qwen3.5-2b-onnx': {
    friendlyName: 'Eco (Qwen)',
    qualityPhrase: 'A larger model · longer, slower answers',
    provider: 'Alibaba',
  },
  'local/qwen3-0.6b': {
    friendlyName: 'Eco Compact (Qwen)',
    qualityPhrase: 'Small + capable · good for limited devices',
    provider: 'Alibaba',
  },
  'candidate/gemma-4-e2b-litert': {
    friendlyName: 'Eco Capable (Gemma)',
    qualityPhrase: 'Strong all-round answers · runs on more devices',
    provider: 'Google',
  },
  'candidate/qwen2.5-0.5b-mlc': {
    friendlyName: 'Eco Mobile (Qwen)',
    qualityPhrase: 'Made for iPhone · quick private chat on the go',
    provider: 'Alibaba',
  },
};

/**
 * Return branded display copy for a catalog model id. Falls back to the
 * raw `ModelConfig.friendlyName` + vendor when the id isn't in the map
 * (future models, test fixtures).
 */
export function getDisplayInfo(
  modelId: string,
  fallback: { friendlyName: string; vendor: string; sizeGB: number },
): DisplayInfo {
  const entry = DISPLAY_MAP[modelId];
  if (entry) {
    return {
      friendlyName: entry.friendlyName,
      qualityPhrase: entry.qualityPhrase,
      provenance: `${entry.provider} · ${fallback.sizeGB.toFixed(1)} GB`,
    };
  }
  return {
    friendlyName: fallback.friendlyName,
    qualityPhrase: '',
    provenance: `${fallback.vendor} · ${fallback.sizeGB.toFixed(1)} GB`,
  };
}

/**
 * The model to present as "currently running": the one the chat's current
 * selection resolves to, matching how dispatch resolves a selection into a
 * slot. Only when the selection resolves to an empty slot does it fall back
 * fast-then-smart. A pure view over the slot snapshot — no storage reads —
 * so Settings can never out-vote the slot the chat actually uses (a stale
 * eco-fast binding out-named the serving eco-smart model live, 2026-08-05).
 */
export function resolveRunningModel(
  selectedModel: string,
  slots: Record<Slot, { model: ModelConfig | null; status: SlotStatus }>,
): { model: ModelConfig | null; status: SlotStatus | null } {
  const selectedSlot = isLocalAiSlot(selectedModel)
    ? selectedModel
    : SLOTS.find((slot) => slots[slot].model?.id === selectedModel) ?? null;
  if (selectedSlot && slots[selectedSlot].model) {
    return { model: slots[selectedSlot].model, status: slots[selectedSlot].status };
  }
  const fallback = SLOTS.find((slot) => slots[slot].model !== null) ?? null;
  if (fallback) {
    return { model: slots[fallback].model, status: slots[fallback].status };
  }
  return { model: null, status: null };
}
