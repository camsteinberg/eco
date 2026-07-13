// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SETUP_FAILURE_LOG_TAG,
  formatSetupAttemptFailure,
  logSetupAttemptFailure,
} from '../setup-diagnostics';

/**
 * On-device setup failures must be visible in the USER's own devtools.
 *
 * The setup cascade swallows each model's real failure reason behind a generic
 * "couldn't get one running" screen, and `logger.error` routes to Sentry (not
 * the console) in production — so a real-hardware failure (e.g. a WebGPU/iGPU
 * wall the catalog can't predict) is currently undiagnosable from the field.
 * This captures the exact error + phase to `console.error` so it always shows.
 */
describe('formatSetupAttemptFailure', () => {
  it('captures model, runtime, phase, and reason', () => {
    const out = formatSetupAttemptFailure({
      modelId: 'candidate/gemma-4-e2b-litert',
      runtime: 'litert',
      phase: 'load-or-smoke',
      reason: 'WebGPU device lost',
    });
    expect(out).toMatchObject({
      modelId: 'candidate/gemma-4-e2b-litert',
      runtime: 'litert',
      phase: 'load-or-smoke',
      reason: 'WebGPU device lost',
    });
  });

  it('extracts the error name and a truncated stack from a thrown Error', () => {
    const err = new Error('shader-f16 not enabled');
    err.name = 'OperationError';
    const out = formatSetupAttemptFailure({
      modelId: 'local/qwen3-0.6b',
      runtime: 'transformers',
      phase: 'download',
      reason: err.message,
      error: err,
    });
    expect(out.errorName).toBe('OperationError');
    expect(out.stack).toContain('shader-f16 not enabled');
    // Stack is truncated to keep the console line readable.
    expect((out.stack ?? '').split('\n').length).toBeLessThanOrEqual(4);
  });

  it('tolerates a non-Error thrown value (no errorName/stack)', () => {
    const out = formatSetupAttemptFailure({
      modelId: 'm',
      runtime: 'transformers',
      phase: 'download',
      reason: 'string failure',
      error: 'boom',
    });
    expect(out.errorName).toBeUndefined();
    expect(out.stack).toBeUndefined();
    expect(out.reason).toBe('string failure');
  });
});

describe('logSetupAttemptFailure', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes a tagged structured entry to console.error so it is visible in prod devtools', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logSetupAttemptFailure({
      modelId: 'candidate/gemma-4-e2b-litert',
      runtime: 'litert',
      phase: 'load-or-smoke',
      reason: 'WebGPU device lost',
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toBe(SETUP_FAILURE_LOG_TAG);
    expect(spy.mock.calls[0]![1]).toMatchObject({
      modelId: 'candidate/gemma-4-e2b-litert',
      phase: 'load-or-smoke',
      reason: 'WebGPU device lost',
    });
  });
});
