// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect } from 'vitest';
import { buildSupportSummary } from '../support-summary';
import type { LocalAiDiagnostic } from '../capture';

const entry = (over: Partial<LocalAiDiagnostic> = {}): LocalAiDiagnostic => ({
  schemaVersion: 2, recordedAt: '2026-06-24T00:00:00Z', modelId: 'candidate/qwen3.5-2b-onnx',
  profileKey: 'chromium|high|webgpu', runtimeAdapter: 'transformers', resolvedBackend: 'wasm',
  outcome: 'smoke-fail',
  durations: { loadMs: null, firstTokenMs: null, totalMs: 1200 }, tokensReceived: 0,
  error: { message: 'std::bad_alloc' },
  webgpu: { available: true, adapterRequested: true },
  cache: null, env: { userAgent: 'x', deviceMemoryGB: 8, hardwareConcurrency: 8 }, events: [],
  ...over,
});

describe('buildSupportSummary', () => {
  it('summarizes the most recent failures compactly with no conversation content', () => {
    const out = buildSupportSummary([entry()]);
    expect(out).toContain('candidate/qwen3.5-2b-onnx');
    expect(out).toContain('std::bad_alloc');
    expect(out).toContain('chromium|high|webgpu');
    expect(out.length).toBeLessThan(1500); // mailto-body safe
  });

  it('surfaces the resolved execution provider when a webgpu device ran on wasm', () => {
    const out = buildSupportSummary([entry({ resolvedBackend: 'wasm' })]);
    expect(out).toContain('ep=wasm');
  });

  it('handles an empty ledger', () => {
    expect(buildSupportSummary([])).toContain('No diagnostics');
  });
});
