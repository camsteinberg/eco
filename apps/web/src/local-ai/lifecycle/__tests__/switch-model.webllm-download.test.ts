// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * prepareModelForSlot's DEFAULT download seam — Settings → Switch AI.
 *
 * A `webllm` model must stage through the WebLLM cache bridge, exactly as setup
 * (`setup-runner.ts`) and the upgrade download (`upgrade.ts`) do: the bridge runs
 * Eco's verified download, then pre-stages the bytes in WebLLM's own cache so
 * the engine's load is a cache hit. A plain `downloadModel` writes Eco's staging
 * cache only, so the load then asks for files nothing serves. Every other
 * runtime keeps the plain downloader.
 *
 * Both functions are stubbed so the routing is assertable; every other seam is
 * injected, so only the default `download` runs for real.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareModelForSlot, type SwitchModelSeams } from '../switch-model';
import { getModel } from '../../catalog/catalog';
import { downloadModel } from '../../download/download';
import { bridgeDownloadWebLLMModel } from '../../runtime/webllm-cache-bridge';

vi.mock('../../runtime/webllm-cache-bridge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../runtime/webllm-cache-bridge')>();
  return { ...actual, bridgeDownloadWebLLMModel: vi.fn(async () => {}) };
});

vi.mock('../../download/download', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../download/download')>();
  return { ...actual, downloadModel: vi.fn(async () => {}) };
});

function seamsWithDefaultDownload(): Partial<SwitchModelSeams> {
  return {
    getModel: (id: string) => getModel(id),
    setSlot: vi.fn(),
    setSlotStatus: vi.fn(),
    acquireLease: vi.fn((kind: string) => ({
      ok: true as const,
      lease: { ownerId: `${kind}:t`, kind, startedAt: 0, expiresAt: 1 },
      release: () => undefined,
    })) as unknown as SwitchModelSeams['acquireLease'],
    describeBusy: vi.fn(() => 'busy'),
    load: vi.fn(async () => ({ backend: 'webgpu' as const })),
    smoke: vi.fn(async () => ({ passed: true as const, firstTokenMs: 1, durationMs: 1, tokensReceived: 4 })),
    recordEvidence: vi.fn(),
    getDeviceProfile: vi.fn(() => ({
      browserClass: 'safari', webgpuSupport: 'webgpu', deviceMemoryGB: 0, isMobile: false, override: 'auto', webgpuShaderF16: true,
    } as const)),
    nextInCascade: vi.fn(() => null),
    deriveFailedConfidence: vi.fn(() => null),
  };
}

async function switchTo(modelId: string) {
  const settled = prepareModelForSlot({
    slot: 'eco-fast',
    modelId,
    previous: null,
    seams: seamsWithDefaultDownload(),
  });
  await vi.runAllTimersAsync();
  return settled;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(bridgeDownloadWebLLMModel).mockClear();
  vi.mocked(downloadModel).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Settings → Switch AI — the default download seam', () => {
  it('stages a webllm model through the WebLLM cache bridge', async () => {
    const mlc = getModel('candidate/qwen3-0.6b-mlc-q0f16')!;
    const result = await switchTo(mlc.id);

    expect(result.success).toBe(true);
    expect(bridgeDownloadWebLLMModel).toHaveBeenCalledTimes(1);
    expect(bridgeDownloadWebLLMModel).toHaveBeenCalledWith(
      mlc,
      expect.objectContaining({ tracker: expect.anything() as unknown }),
    );
    expect(downloadModel).not.toHaveBeenCalled();
  });

  it('keeps the plain downloader for every other runtime', async () => {
    const onnx = getModel('local/qwen3-0.6b')!;
    const result = await switchTo(onnx.id);

    expect(result.success).toBe(true);
    expect(downloadModel).toHaveBeenCalledTimes(1);
    expect(downloadModel).toHaveBeenCalledWith(
      onnx,
      expect.objectContaining({ tracker: expect.anything() as unknown }),
    );
    expect(bridgeDownloadWebLLMModel).not.toHaveBeenCalled();
  });
});
