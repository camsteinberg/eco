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
    qualityPhrase: 'Quickest replies · light footprint',
    provider: 'Liquid AI',
  },
  'candidate/lfm2.5-350m-onnx': {
    friendlyName: 'Eco Light (Liquid)',
    qualityPhrase: 'Smallest footprint · best for older devices',
    provider: 'Liquid AI',
  },
  'candidate/qwen3.5-2b-onnx': {
    friendlyName: 'Eco (Qwen)',
    qualityPhrase: 'The everyday default · deeper, instruction-faithful answers',
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
