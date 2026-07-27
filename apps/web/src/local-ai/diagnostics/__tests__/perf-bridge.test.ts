// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const harnessEnabled = vi.hoisted(() => ({ value: true }));

vi.mock('../../../lib/validation-harness', () => ({
  isValidationHarnessEnabled: () => harnessEnabled.value,
}));

import {
  PERF_BRIDGE_VERSION,
  installPerfBridge,
  uninstallPerfBridge,
} from '../perf-bridge';
import {
  clearGenerationReceipts,
  recordGenerationReceipt,
  recordGenerationReceiptAsync,
} from '../../lifecycle/generation-receipt';

beforeEach(() => {
  harnessEnabled.value = true;
  uninstallPerfBridge();
  clearGenerationReceipts();
});

afterEach(() => {
  uninstallPerfBridge();
  clearGenerationReceipts();
});

describe('installPerfBridge', () => {
  it('does nothing when the validation harness is disabled', () => {
    harnessEnabled.value = false;
    expect(installPerfBridge()).toBe(false);
    expect(window.__ecoPerf).toBeUndefined();
  });

  it('installs a versioned read-only bridge when the harness is enabled', () => {
    expect(installPerfBridge()).toBe(true);
    expect(window.__ecoPerf?.version).toBe(PERF_BRIDGE_VERSION);
  });

  it('is idempotent — a second install keeps the same object', () => {
    installPerfBridge();
    const first = window.__ecoPerf;
    expect(installPerfBridge()).toBe(true);
    expect(window.__ecoPerf).toBe(first);
  });

  it('reports no active model before one is loaded', () => {
    installPerfBridge();
    expect(window.__ecoPerf?.activeModelId()).toBeNull();
  });

  // A turn can record two receipts (primary + repair) and each lands a
  // microtask after its hash resolves. Without this signal the harness reads
  // the ring mid-flight and measures the previous turn.
  it('exposes in-flight receipt recordings so a harness can wait for them', async () => {
    installPerfBridge();
    expect(window.__ecoPerf?.pendingReceipts()).toBe(0);

    recordGenerationReceiptAsync('sys', (systemPromptHash) => ({
      generationId: 'gen-pending',
      generationRole: 'primary',
      modelId: 'candidate/lfm2.5-350m-onnx',
      timestamp: 1,
      templateName: null,
      systemPromptHash,
      samplingProfile: {},
      promptTokens: 1,
      completionTokens: 1,
      durationMs: 1,
      status: 'complete',
    }));

    expect(window.__ecoPerf?.pendingReceipts()).toBe(1);
    await vi.waitFor(() => expect(window.__ecoPerf?.pendingReceipts()).toBe(0));
    expect(window.__ecoPerf?.receipts()).toHaveLength(1);
  });

  it('reads through to the live generation-receipt buffer', () => {
    installPerfBridge();
    expect(window.__ecoPerf?.receipts()).toEqual([]);

    recordGenerationReceipt({
      generationId: 'gen-1',
      generationRole: 'primary',
      modelId: 'candidate/lfm2.5-350m-onnx',
      timestamp: 1,
      templateName: null,
      systemPromptHash: '00000000',
      samplingProfile: {},
      promptTokens: 3,
      completionTokens: 7,
      durationMs: 900,
      firstTokenMs: 120,
      status: 'complete',
    });

    const receipts = window.__ecoPerf?.receipts() ?? [];
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.firstTokenMs).toBe(120);
    expect(receipts[0]?.completionTokens).toBe(7);
  });

  it('honours the receipt limit argument', () => {
    installPerfBridge();
    for (let i = 0; i < 3; i++) {
      recordGenerationReceipt({
        generationId: `gen-${i}`,
        generationRole: 'primary',
        modelId: 'candidate/lfm2.5-350m-onnx',
        timestamp: i,
        templateName: null,
        systemPromptHash: '00000000',
        samplingProfile: {},
        promptTokens: 0,
        completionTokens: 0,
        durationMs: 0,
        status: 'complete',
      });
    }
    // Newest first, per getRecentReceipts.
    expect(window.__ecoPerf?.receipts(1)).toHaveLength(1);
    expect(window.__ecoPerf?.receipts(1)[0]?.generationId).toBe('gen-2');
  });
});
