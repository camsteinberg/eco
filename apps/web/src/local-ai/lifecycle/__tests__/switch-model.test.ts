// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * prepareModelForSlot — the extracted, React-free switch primitive
 * (instant-start slice 2a).
 *
 * Contract pinned here:
 *   - downloads go through downloadModel BEFORE the runtime load (the old
 *     Settings flow let the worker download implicitly, bypassing headroom
 *     preflight + chunked/SHA verification);
 *   - the whole operation runs under the 'switch-model' runtime lease, the
 *     download step additionally under the 'download' lease;
 *   - failure rolls the slot back to the previous model (or empty);
 *   - smoke failures record ledger evidence; download/load failures do not;
 *   - a 60s no-progress stall aborts the attempt;
 *   - every path releases its leases.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareModelForSlot, type SwitchModelSeams } from '../switch-model';
import { DownloadFailedError } from '../../download/download';
import type { ModelConfig, Slot } from '../../types';

const target = { id: 'local/next-model', friendlyName: 'Next' } as ModelConfig;
const previous = { id: 'local/prev-model', friendlyName: 'Prev' } as ModelConfig;
const suggested = { id: 'local/suggested', friendlyName: 'Suggested' } as ModelConfig;
const profile = { deviceMemoryGB: 16 } as unknown as ReturnType<SwitchModelSeams['getDeviceProfile']>;

type LeaseCalls = { acquired: string[]; released: string[] };

function makeSeams(overrides: Partial<SwitchModelSeams> = {}): {
  seams: SwitchModelSeams;
  calls: string[];
  leases: LeaseCalls;
} {
  const calls: string[] = [];
  const leases: LeaseCalls = { acquired: [], released: [] };
  const seams: SwitchModelSeams = {
    getModel: vi.fn((id: string) => (id === target.id ? target : null)),
    setSlot: vi.fn((_slot: Slot, model: ModelConfig | null) => {
      calls.push(`setSlot:${model?.id ?? 'null'}`);
    }),
    setSlotStatus: vi.fn((_slot: Slot, status: string) => {
      calls.push(`setSlotStatus:${status}`);
    }),
    acquireLease: vi.fn((kind: string) => {
      leases.acquired.push(kind);
      return {
        ok: true as const,
        lease: { ownerId: `${kind}:t`, kind, startedAt: 0, expiresAt: 1 },
        release: () => leases.released.push(kind),
      };
    }) as unknown as SwitchModelSeams['acquireLease'],
    describeBusy: vi.fn(() => 'busy copy'),
    download: vi.fn(async () => {
      calls.push('download');
    }),
    load: vi.fn(async () => {
      calls.push('load');
      return { backend: 'webgpu' as const };
    }),
    smoke: vi.fn(async () => {
      calls.push('smoke');
      return { passed: true as const, firstTokenMs: 123, durationMs: 1000, tokensReceived: 8 };
    }),
    recordEvidence: vi.fn((entry: unknown) => {
      calls.push(`evidence:${(entry as { outcome: string }).outcome}`);
    }),
    getDeviceProfile: vi.fn(() => profile),
    nextInCascade: vi.fn(() => suggested),
    deriveFailedConfidence: vi.fn(() => 'ledger' as const),
    ...overrides,
  };
  return { seams, calls, leases };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

async function run(
  seams: SwitchModelSeams,
  opts: Partial<Parameters<typeof prepareModelForSlot>[0]> = {},
) {
  const resultPromise = prepareModelForSlot({
    slot: 'eco-fast',
    modelId: target.id,
    previous,
    seams,
    ...opts,
  });
  await vi.runAllTimersAsync();
  return resultPromise;
}

describe('success path', () => {
  it('downloads through downloadModel BEFORE the runtime load, then smokes, binds, records a pass', async () => {
    const { seams, calls } = makeSeams();
    const result = await run(seams);

    expect(result.success).toBe(true);
    expect(calls).toEqual([
      'setSlot:local/next-model',
      'download',
      'load',
      'smoke',
      'evidence:smoke-pass',
      'setSlotStatus:ready',
    ]);
  });

  it('records firstTokenMs on the smoke-pass evidence', async () => {
    const { seams } = makeSeams();
    await run(seams);
    expect(seams.recordEvidence).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'smoke-pass', firstTokenMs: 123, modelId: target.id }),
    );
  });

  it('threads the resolved backend from the load into the smoke-pass evidence', async () => {
    const { seams } = makeSeams({
      load: vi.fn(async () => ({ backend: 'wasm' as const })),
    });
    await run(seams);
    expect(seams.recordEvidence).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'smoke-pass', backend: 'wasm', modelId: target.id }),
    );
  });

  it('acquires switch-model + download leases and releases both', async () => {
    const { seams, leases } = makeSeams();
    await run(seams);
    expect(leases.acquired).toEqual(['switch-model', 'download']);
    expect(leases.released).toEqual(expect.arrayContaining(['switch-model', 'download']));
  });
});

describe('busy runtime', () => {
  it('returns a busy result without touching the slot', async () => {
    const { seams } = makeSeams({
      acquireLease: vi.fn(() => ({
        ok: false as const,
        active: { ownerId: 'generation:x', kind: 'generation', startedAt: 0, expiresAt: 1 },
        reason: 'busy',
      })) as unknown as SwitchModelSeams['acquireLease'],
    });
    const result = await run(seams);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe('busy');
      expect(result.busyMessage).toBe('busy copy');
    }
    expect(seams.setSlot).not.toHaveBeenCalled();
  });
});

describe('unknown model', () => {
  it('returns unknown without touching the slot or leases', async () => {
    const { seams, leases } = makeSeams();
    const result = await run(seams, { modelId: 'local/not-in-catalog' });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.reason).toBe('unknown');
    expect(seams.setSlot).not.toHaveBeenCalled();
    expect(leases.released).toEqual(leases.acquired);
  });
});

describe('download failure', () => {
  it('rolls back to the previous model, suggests the next cascade candidate, records NO evidence', async () => {
    const { seams, calls, leases } = makeSeams({
      download: vi.fn(async () => {
        throw new Error('network sneeze');
      }),
    });
    const result = await run(seams);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe('load-failed');
      expect(result.failedModel?.id).toBe(target.id);
      expect(result.suggestedNext?.id).toBe(suggested.id);
      expect(result.fallbackUsed?.id).toBe(previous.id);
    }
    expect(calls).toContain('setSlot:local/prev-model');
    expect(calls).toContain('setSlotStatus:ready');
    expect(seams.recordEvidence).not.toHaveBeenCalled();
    expect(seams.load).not.toHaveBeenCalled();
    expect(leases.released).toEqual(expect.arrayContaining(['switch-model', 'download']));
  });
});

describe('network failure (download transport)', () => {
  it('classifies a DownloadFailedError as network-failed with NO cascade suggestion', async () => {
    const { seams, calls } = makeSeams({
      download: vi.fn(async () => {
        throw new DownloadFailedError('Network error fetching weights', {
          url: 'https://example.test/model.onnx',
        });
      }),
    });
    const result = await run(seams);

    expect(result.success).toBe(false);
    if (!result.success) {
      // The honest classification: this is about the connection, not the
      // device — so no hardware verdict and no downgrade suggestion.
      expect(result.reason).toBe('network-failed');
      expect(result.failedModel?.id).toBe(target.id);
      expect(result.suggestedNext).toBeNull();
      expect(result.fallbackUsed?.id).toBe(previous.id);
      expect(result.failedConfidence).toBeUndefined();
    }
    // Rolled back to the previous model, never reached the load step, and — as
    // for any download failure — left no durable evidence row.
    expect(calls).toContain('setSlot:local/prev-model');
    expect(seams.load).not.toHaveBeenCalled();
    expect(seams.recordEvidence).not.toHaveBeenCalled();
    expect(seams.nextInCascade).not.toHaveBeenCalled();
  });
});

describe('load failure', () => {
  it('rolls back and reports load-failed with confidence + suggestion', async () => {
    const { seams } = makeSeams({
      load: vi.fn(async () => {
        throw new Error('shader kaboom');
      }),
    });
    const result = await run(seams);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe('load-failed');
      expect(result.failedConfidence).toBe('ledger');
    }
    // slice 3: a load failure now leaves a durable load-fail row (the exact
    // evidence Cam's Gemma incident was missing) — and nothing else.
    expect(seams.recordEvidence).toHaveBeenCalledTimes(1);
    expect(seams.recordEvidence).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'load-fail', modelId: target.id }),
    );
  });
});

describe('smoke failure', () => {
  it('records smoke-fail evidence, rolls back, reports smoke-failed', async () => {
    const { seams, calls } = makeSeams({
      smoke: vi.fn(async () => ({ passed: false as const, reason: 'no tokens', durationMs: 5 })),
    });
    const result = await run(seams);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe('smoke-failed');
      expect(result.suggestedNext?.id).toBe(suggested.id);
      expect(result.fallbackUsed?.id).toBe(previous.id);
    }
    expect(seams.recordEvidence).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'smoke-fail', modelId: target.id }),
    );
    expect(calls).toContain('setSlot:local/prev-model');
  });

  it('excludes the failed model from the cascade suggestion', async () => {
    const { seams } = makeSeams({
      smoke: vi.fn(async () => ({ passed: false as const, reason: 'no tokens', durationMs: 5 })),
    });
    await run(seams);
    expect(seams.nextInCascade).toHaveBeenCalledWith(
      target,
      'eco-fast',
      profile,
      undefined,
      { excludeIds: [target.id] },
    );
  });
});

describe('rollback with no previous model', () => {
  it('empties the slot', async () => {
    const { seams, calls } = makeSeams({
      load: vi.fn(async () => {
        throw new Error('kaboom');
      }),
    });
    await run(seams, { previous: null });
    expect(calls).toContain('setSlot:null');
    expect(calls).not.toContain('setSlotStatus:ready');
  });
});

describe('stall watchdog', () => {
  it('aborts a load that reports no progress for 60s', async () => {
    let abortSignal: AbortSignal | undefined;
    const { seams } = makeSeams({
      load: vi.fn(async (_model, options?: { signal?: AbortSignal }) => {
        abortSignal = options?.signal;
        // Hang until the watchdog aborts us.
        await new Promise<void>((_, reject) => {
          options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      }) as unknown as SwitchModelSeams['load'],
    });

    const resultPromise = prepareModelForSlot({
      slot: 'eco-fast',
      modelId: target.id,
      previous,
      seams,
    });
    await vi.advanceTimersByTimeAsync(61_000);
    const result = await resultPromise;

    expect(abortSignal?.aborted).toBe(true);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.reason).toBe('load-failed');
  });

  it('a progress callback resets the stall window', async () => {
    let tick: (() => void) | undefined;
    const { seams } = makeSeams({
      load: vi.fn(async (_model, options?: {
        signal?: AbortSignal;
        onLoadProgress?: (fraction: number) => void;
      }) => {
        let fraction = 0;
        return new Promise<{ backend: 'webgpu' }>((resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          tick = () => {
            fraction += 0.2;
            options?.onLoadProgress?.(fraction);
            if (fraction >= 1) resolve({ backend: 'webgpu' });
          };
        });
      }) as unknown as SwitchModelSeams['load'],
    });

    const resultPromise = prepareModelForSlot({
      slot: 'eco-fast',
      modelId: target.id,
      previous,
      seams,
    });

    // Five progress ticks 40s apart: each inside the 60s window, total 200s.
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(40_000);
      tick?.();
    }
    await vi.runAllTimersAsync();
    const result = await resultPromise;
    expect(result.success).toBe(true);
  });
});

describe('external cancel', () => {
  it('an aborted external signal rolls back and reports load-failed', async () => {
    const controller = new AbortController();
    const { seams, calls } = makeSeams({
      load: vi.fn(async (_model, options?: { signal?: AbortSignal }) => {
        await new Promise<void>((_, reject) => {
          options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      }) as unknown as SwitchModelSeams['load'],
    });

    const resultPromise = prepareModelForSlot({
      slot: 'eco-fast',
      modelId: target.id,
      previous,
      seams,
      signal: controller.signal,
    });
    controller.abort();
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.success).toBe(false);
    expect(calls).toContain('setSlot:local/prev-model');
  });
});

describe('progress forwarding', () => {
  it('forwards download + load progress to onProgress', async () => {
    const events: Array<{ kind: string }> = [];
    const { seams } = makeSeams({
      download: vi.fn(async (_model, options?: {
        onProgressEvent?: (e: { kind: string; phase: string; percent: number }) => void;
      }) => {
        options?.onProgressEvent?.({ kind: 'progress', phase: 'downloading', percent: 0.5 });
      }) as unknown as SwitchModelSeams['download'],
      load: vi.fn(async (_model, options?: {
        onLoadProgress?: (fraction: number) => void;
        onLifecycleEvent?: (e: { phase: string }) => void;
      }) => {
        options?.onLifecycleEvent?.({ phase: 'load-start' });
        options?.onLoadProgress?.(0.7);
      }) as unknown as SwitchModelSeams['load'],
    });

    await run(seams, {
      onProgress: (event) => events.push(event),
    });

    expect(events).toEqual([
      { kind: 'phase', phase: 'downloading' },
      { kind: 'download', fraction: 0.5 },
      { kind: 'phase', phase: 'load-start' },
      { kind: 'load', fraction: 0.7 },
    ]);
  });
});
