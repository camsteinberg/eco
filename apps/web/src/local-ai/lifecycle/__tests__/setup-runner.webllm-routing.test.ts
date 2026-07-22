// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Pins the runtime split in the real `defaultRunAttempt` download step: a
 * `webllm` model goes through the cache bridge; every other runtime keeps the
 * plain downloader. Misrouting a webllm model to `downloadModel` would leave
 * WebLLM's cache empty and its serving path broken.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelConfig, Slot } from '../../types';
import type { SmokeResult } from '../smoke';

vi.mock('../../download/download', () => ({
  downloadModel: vi.fn().mockResolvedValue(undefined),
  InsufficientStorageError: class InsufficientStorageError extends Error {},
}));
vi.mock('../../runtime/webllm-cache-bridge', () => ({
  bridgeDownloadWebLLMModel: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../smoke', () => ({ runSmoke: vi.fn() }));

import { DEFAULT_SEAMS } from '../setup-runner';
import { downloadModel } from '../../download/download';
import { bridgeDownloadWebLLMModel } from '../../runtime/webllm-cache-bridge';
import { runSmoke } from '../smoke';

const SLOT: Slot = 'eco-fast';
const passSmoke = (): SmokeResult => ({ passed: true, firstTokenMs: 12, durationMs: 80, tokensReceived: 6 });

const webllmModel = { id: 'candidate/qwen2-0.5b-webllm', runtime: 'webllm' } as ModelConfig;
const tjsModel = { id: 'candidate/qwen3.5-2b-onnx', runtime: 'transformers' } as ModelConfig;

describe('DEFAULT_SEAMS.runAttempt — runtime download routing', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(runSmoke).mockResolvedValue(passSmoke());
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('routes a webllm model through the cache bridge, not the plain downloader', async () => {
    vi.mocked(bridgeDownloadWebLLMModel).mockResolvedValue(undefined);

    const result = await DEFAULT_SEAMS.runAttempt(SLOT, webllmModel, vi.fn());

    expect(result).toEqual({ ok: true });
    expect(bridgeDownloadWebLLMModel).toHaveBeenCalledTimes(1);
    expect(downloadModel).not.toHaveBeenCalled();
  });

  it('routes a transformers model through the plain downloader, not the bridge', async () => {
    vi.mocked(downloadModel).mockResolvedValue(
      undefined as unknown as Awaited<ReturnType<typeof downloadModel>>,
    );

    const result = await DEFAULT_SEAMS.runAttempt(SLOT, tjsModel, vi.fn());

    expect(result).toEqual({ ok: true });
    expect(downloadModel).toHaveBeenCalledTimes(1);
    expect(bridgeDownloadWebLLMModel).not.toHaveBeenCalled();
  });

  it('classifies a bridge failure as phase "download" (uniform with the downloader)', async () => {
    vi.mocked(bridgeDownloadWebLLMModel).mockRejectedValue(new Error('cache contract broken'));

    const result = await DEFAULT_SEAMS.runAttempt(SLOT, webllmModel, vi.fn());

    expect(result).toEqual({ ok: false, phase: 'download', reason: 'cache contract broken' });
    expect(runSmoke).not.toHaveBeenCalled();
  });
});
