// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelConfig } from '../../types';
import type { TokenEvent } from '../../runtime/types';
import {
  _resetSmokeForTesting,
  computeSmokeLoadBudgetMs,
  hasSmokeGenerationFn,
  isSmokeActive,
  runSmoke,
  setSmokeGenerationFn,
  SMOKE_LOAD_BUDGET_MAX_MS,
  SMOKE_LOAD_BUDGET_MIN_MS,
  type SmokeGenerationFn,
} from '../smoke';
import { loadDiagnostics, clearDiagnostics } from '../../diagnostics/capture';

const webllmModelInCacheMock = vi.hoisted(() => vi.fn());
vi.mock('../../runtime/webllm-cache-bridge', () => ({
  webllmModelInCache: webllmModelInCacheMock,
}));

const MODEL: ModelConfig = {
  id: 'local/phi3-mini-4k-q4f16',
  friendlyName: 'Phi-3 Mini',
  vendor: 'Microsoft',
  sizeGB: 2.14,
  runtime: 'transformers',
  format: 'onnx-q4f16',
  capabilities: { intent: ['balanced'], tasks: ['chat'], contextTokens: 4096 },
  bestFor: 't', knownLimitation: 'k', evidenceTier: 'proven',
};

// ─── Cache stub ───────────────────────────────────────────────────────────
// Most smoke tests need to bypass the "model not downloaded" early exit.
// The jsdom environment has no `caches` global, so the cache probe returns
// null, triggering the guard. Stub `caches` to look like a populated cache.

function stubCachesWithFiles(): void {
  const fakeCache = {
    keys: async () => [new Request('https://example.com/model.onnx')],
    match: async () => new Response('x', { headers: { 'x-eco-cache-size-bytes': '1024' } }),
    put: async () => undefined,
    delete: async () => true,
  };
  const fakeCaches = {
    has: async () => true,
    open: async () => fakeCache,
    keys: async () => ['eco-local-ai-local_phi3-mini-4k-q4f16'],
    delete: async () => true,
  };
  vi.stubGlobal('caches', fakeCaches);
}

beforeEach(() => {
  _resetSmokeForTesting();
  clearDiagnostics();
  webllmModelInCacheMock.mockReset();
  // By default, stub caches so tests that exercise generation proceed past
  // the download guard. Tests that specifically test the empty-cache path
  // unstub before running.
  stubCachesWithFiles();
});

afterEach(() => {
  _resetSmokeForTesting();
  clearDiagnostics();
  vi.unstubAllGlobals();
});

// ─── Adaptive cold-load budget ──────────────────────────────────────────────
// The old fixed 120s load cap killed legit-but-slow loads on weak hardware:
// Cam's 4-core x86 iGPU laptop aborted a 1.15GB Bonsai load at exactly
// 120003ms (2026-07-01). The budget now scales with device weakness + model
// size, bounded to [MIN, MAX].

describe('computeSmokeLoadBudgetMs', () => {
  const STRONG = { deviceMemoryGB: 8, hardwareConcurrency: 12, isMobile: false };

  it('gives a strong device + small model the MIN floor', () => {
    expect(computeSmokeLoadBudgetMs({ ...STRONG, modelSizeGB: 0.5 })).toBe(
      SMOKE_LOAD_BUDGET_MIN_MS,
    );
  });

  it('adds headroom for a large model on a strong device', () => {
    const small = computeSmokeLoadBudgetMs({ ...STRONG, modelSizeGB: 0.5 });
    const large = computeSmokeLoadBudgetMs({ ...STRONG, modelSizeGB: 2 });
    expect(large).toBeGreaterThan(small);
  });

  it('widens the budget for a weak device (low core count)', () => {
    const strong = computeSmokeLoadBudgetMs({ ...STRONG, modelSizeGB: 0.5 });
    const weak = computeSmokeLoadBudgetMs({
      deviceMemoryGB: 8,
      hardwareConcurrency: 4,
      isMobile: false,
      modelSizeGB: 0.5,
    });
    expect(weak).toBeGreaterThan(strong);
  });

  it('treats low reported memory as weak', () => {
    const weak = computeSmokeLoadBudgetMs({
      deviceMemoryGB: 4,
      hardwareConcurrency: 12,
      isMobile: false,
      modelSizeGB: 0.5,
    });
    expect(weak).toBeGreaterThan(SMOKE_LOAD_BUDGET_MIN_MS);
  });

  it('treats mobile as weak', () => {
    const weak = computeSmokeLoadBudgetMs({
      deviceMemoryGB: 8,
      hardwareConcurrency: 12,
      isMobile: true,
      modelSizeGB: 0.5,
    });
    expect(weak).toBeGreaterThan(SMOKE_LOAD_BUDGET_MIN_MS);
  });

  it('does NOT treat unreported memory (0) as a weakness signal on its own', () => {
    expect(
      computeSmokeLoadBudgetMs({
        deviceMemoryGB: 0,
        hardwareConcurrency: 12,
        isMobile: false,
        modelSizeGB: 0.5,
      }),
    ).toBe(SMOKE_LOAD_BUDGET_MIN_MS);
  });

  it('does NOT treat unknown core count (null) as a weakness signal on its own', () => {
    expect(
      computeSmokeLoadBudgetMs({
        deviceMemoryGB: 8,
        hardwareConcurrency: null,
        isMobile: false,
        modelSizeGB: 0.5,
      }),
    ).toBe(SMOKE_LOAD_BUDGET_MIN_MS);
  });

  it('never exceeds the MAX ceiling (weak device + large model)', () => {
    expect(
      computeSmokeLoadBudgetMs({
        deviceMemoryGB: 2,
        hardwareConcurrency: 2,
        isMobile: true,
        modelSizeGB: 4,
      }),
    ).toBe(SMOKE_LOAD_BUDGET_MAX_MS);
  });

  it('never falls below the MIN floor (missing model size)', () => {
    expect(computeSmokeLoadBudgetMs({ ...STRONG })).toBeGreaterThanOrEqual(
      SMOKE_LOAD_BUDGET_MIN_MS,
    );
  });

  it("regression: Cam's device (4 cores, 1.15GB Bonsai) far exceeds the old 120003ms abort", () => {
    const budget = computeSmokeLoadBudgetMs({
      deviceMemoryGB: 8,
      hardwareConcurrency: 4,
      isMobile: false,
      modelSizeGB: 1.15,
    });
    expect(budget).toBeGreaterThanOrEqual(240_000);
    expect(budget).toBeLessThanOrEqual(SMOKE_LOAD_BUDGET_MAX_MS);
  });
});

// ─── Generation seam DI ────────────────────────────────────────────────────

describe('generation seam DI', () => {
  it('returns a passed:false when no seam registered', async () => {
    expect(hasSmokeGenerationFn()).toBe(false);
    const r = await runSmoke('eco-fast', MODEL, { skipDiagnostics: true });
    expect(r.passed).toBe(false);
  });

  it('uses registered seam when no override', async () => {
    let invoked = false;
    setSmokeGenerationFn(async function* (): AsyncIterable<TokenEvent> {
      invoked = true;
      yield { kind: 'token', text: 'OK' };
      yield { kind: 'done' };
    });
    expect(hasSmokeGenerationFn()).toBe(true);
    await runSmoke('eco-fast', MODEL, { skipDiagnostics: true });
    expect(invoked).toBe(true);
  });

  it('per-call override takes precedence', async () => {
    const seam: SmokeGenerationFn = async function* (): AsyncIterable<TokenEvent> {
      yield { kind: 'token', text: 'override' };
      yield { kind: 'done' };
    };
    const r = await runSmoke('eco-fast', MODEL, { generationFn: seam, skipDiagnostics: true });
    expect(r.passed).toBe(true);
  });
});

// ─── Happy path ────────────────────────────────────────────────────────────

describe('runSmoke — happy path', () => {
  it('returns passed:true on first token', async () => {
    let nowMs = 1000;
    const seam: SmokeGenerationFn = async function* (): AsyncIterable<TokenEvent> {
      nowMs += 200;
      yield { kind: 'token', text: 'OK' };
      yield { kind: 'done' };
    };
    const r = await runSmoke('eco-fast', MODEL, {
      generationFn: seam,
      now: () => nowMs,
      skipDiagnostics: true,
    });
    expect(r.passed).toBe(true);
    if (r.passed) {
      expect(r.firstTokenMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('stops at SMOKE_MAX_TOKENS (no runaway)', async () => {
    let count = 0;
    const seam: SmokeGenerationFn = async function* (): AsyncIterable<TokenEvent> {
      while (true) {
        count++;
        yield { kind: 'token', text: `t${count}` };
      }
    };
    const r = await runSmoke('eco-fast', MODEL, { generationFn: seam, skipDiagnostics: true });
    expect(r.passed).toBe(true);
    if (r.passed) {
      expect(r.tokensReceived).toBeLessThanOrEqual(8);
    }
  });
});

// ─── Active flag (L3 HIGH-02 / L4 HIGH-03 regression) ──────────────────────

describe('runSmoke — active flag always released', () => {
  it('isSmokeActive is false after a successful smoke', async () => {
    const seam: SmokeGenerationFn = async function* (): AsyncIterable<TokenEvent> {
      yield { kind: 'token', text: 'OK' };
      yield { kind: 'done' };
    };
    await runSmoke('eco-fast', MODEL, { generationFn: seam, skipDiagnostics: true });
    expect(isSmokeActive('eco-fast')).toBe(false);
  });

  it('isSmokeActive is false after a failing smoke', async () => {
    const seam: SmokeGenerationFn = async function* (): AsyncIterable<TokenEvent> {
      yield { kind: 'error', reason: 'broke' };
    };
    await runSmoke('eco-fast', MODEL, { generationFn: seam, skipDiagnostics: true });
    expect(isSmokeActive('eco-fast')).toBe(false);
  });

  it('isSmokeActive is false after a synchronous throw inside the seam', async () => {
    // eslint-disable-next-line require-yield -- deliberately throws before any yield to exercise the cleanup path
    const seam: SmokeGenerationFn = async function* (): AsyncIterable<TokenEvent> {
      throw new Error('synchronous failure inside generator');
    };
    const r = await runSmoke('eco-fast', MODEL, { generationFn: seam, skipDiagnostics: true });
    expect(r.passed).toBe(false);
    expect(isSmokeActive('eco-fast')).toBe(false);
  });

  it('isSmokeActive is false after the seam throws BEFORE yielding anything', async () => {
    const seam: SmokeGenerationFn = () => {
      throw new Error('seam exploded sync');
    };
    const r = await runSmoke('eco-fast', MODEL, { generationFn: seam, skipDiagnostics: true });
    expect(r.passed).toBe(false);
    expect(isSmokeActive('eco-fast')).toBe(false);
  });

  it('rejects concurrent smoke for the same slot', async () => {
    let release: (() => void) | null = null;
    const blockerSeam: SmokeGenerationFn = async function* (): AsyncIterable<TokenEvent> {
      await new Promise<void>((r) => { release = r; });
      yield { kind: 'token', text: 'OK' };
      yield { kind: 'done' };
    };
    const first = runSmoke('eco-fast', MODEL, { generationFn: blockerSeam, skipDiagnostics: true });
    // Wait several ticks so the first call enters the active set.
    // The async WebGPU + cache probes add extra micro-task yields before
    // the generation seam is reached.
    for (let i = 0; i < 10; i++) await Promise.resolve();
    const second = await runSmoke('eco-fast', MODEL, { generationFn: blockerSeam, skipDiagnostics: true });
    expect(second.passed).toBe(false);
    if (!second.passed) {
      expect(second.reason).toMatch(/already running/i);
    }
    release!();
    await first;
  });
});

// ─── Timeout ───────────────────────────────────────────────────────────────

describe('runSmoke — timeout', () => {
  it('aborts after timeoutMs and returns passed:false with timeout reason', async () => {
    const seam: SmokeGenerationFn = async function* (_, __, opts): AsyncIterable<TokenEvent> {
      await new Promise<void>((_resolve, reject) => {
        opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
      yield { kind: 'token', text: 'never' };
    };
    const r = await runSmoke('eco-fast', MODEL, {
      generationFn: seam,
      timeoutMs: 50,
      skipDiagnostics: true,
    });
    expect(r.passed).toBe(false);
    if (!r.passed) {
      expect(r.reason).toMatch(/timed out|smoke produced no tokens|aborted/i);
    }
  });
});

// ─── Load budget vs token deadline ─────────────────────────────────────────
//
// A first-time visitor's model load is COLD (Cache API read + ONNX session
// create + WebGPU shader compile) and routinely exceeds the token deadline.
// The load phase has its own generous budget; the token deadline starts only
// after the seam signals load completion via `opts.onLoadComplete()`.
// Regression: prod fresh-profile setup failed at 15s with "Load aborted"
// (2026-06-09) because one combined deadline covered load + first token.

describe('runSmoke — load budget separate from token deadline', () => {
  it('passes when load outlasts the token deadline but finishes within the load budget', async () => {
    const seam: SmokeGenerationFn = async function* (_, __, opts): AsyncIterable<TokenEvent> {
      // Cold load: 120ms — longer than the 50ms token deadline below.
      await new Promise((resolve) => setTimeout(resolve, 120));
      opts.onLoadComplete?.();
      yield { kind: 'token', text: 'OK' };
      yield { kind: 'done' };
    };
    const r = await runSmoke('eco-fast', MODEL, {
      generationFn: seam,
      timeoutMs: 50,
      loadTimeoutMs: 5_000,
      skipDiagnostics: true,
    });
    expect(r.passed).toBe(true);
  });

  it('fails when load exceeds the load budget', async () => {
    const seam: SmokeGenerationFn = async function* (_, __, opts): AsyncIterable<TokenEvent> {
      await new Promise<void>((_resolve, reject) => {
        opts.signal.addEventListener('abort', () => reject(new Error('Load aborted')));
      });
      yield { kind: 'token', text: 'never' };
    };
    const r = await runSmoke('eco-fast', MODEL, {
      generationFn: seam,
      timeoutMs: 5_000,
      loadTimeoutMs: 50,
      skipDiagnostics: true,
    });
    expect(r.passed).toBe(false);
    if (!r.passed) {
      expect(r.reason).toMatch(/timed out|aborted/i);
    }
  });

  it('starts the token deadline only after load completes', async () => {
    let abortedDuringGeneration = false;
    const seam: SmokeGenerationFn = async function* (_, __, opts): AsyncIterable<TokenEvent> {
      await new Promise((resolve) => setTimeout(resolve, 80));
      opts.onLoadComplete?.();
      // Generation hangs — the 50ms token deadline must fire even though the
      // load budget (5s) is nowhere near exhausted.
      await new Promise<void>((_resolve, reject) => {
        opts.signal.addEventListener('abort', () => {
          abortedDuringGeneration = true;
          reject(new Error('aborted'));
        });
      });
      yield { kind: 'token', text: 'never' };
    };
    const r = await runSmoke('eco-fast', MODEL, {
      generationFn: seam,
      timeoutMs: 50,
      loadTimeoutMs: 5_000,
      skipDiagnostics: true,
    });
    expect(r.passed).toBe(false);
    expect(abortedDuringGeneration).toBe(true);
  });

  it('records honest loadMs in diagnostics (measured at onLoadComplete, not seam construction)', async () => {
    const seam: SmokeGenerationFn = async function* (_, __, opts): AsyncIterable<TokenEvent> {
      await new Promise((resolve) => setTimeout(resolve, 100));
      opts.onLoadComplete?.();
      yield { kind: 'token', text: 'OK' };
      yield { kind: 'done' };
    };
    const r = await runSmoke('eco-fast', MODEL, {
      generationFn: seam,
      loadTimeoutMs: 5_000,
    });
    expect(r.passed).toBe(true);
    const diags = loadDiagnostics();
    const last = diags[diags.length - 1]!;
    expect(last.durations.loadMs).toBeGreaterThanOrEqual(60);
  });

  it('legacy seams that never call onLoadComplete still work (first event implies load done)', async () => {
    const seam: SmokeGenerationFn = async function* (): AsyncIterable<TokenEvent> {
      yield { kind: 'token', text: 'OK' };
      yield { kind: 'done' };
    };
    const r = await runSmoke('eco-fast', MODEL, { generationFn: seam, skipDiagnostics: true });
    expect(r.passed).toBe(true);
  });
});

// ─── External signal ──────────────────────────────────────────────────────

describe('runSmoke — external signal', () => {
  it('caller-aborted signal returns passed:false cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const seam: SmokeGenerationFn = async function* (_, __, opts): AsyncIterable<TokenEvent> {
      await new Promise<void>((_resolve, reject) => {
        if (opts.signal.aborted) reject(new Error('aborted'));
        opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
      yield { kind: 'token', text: 'never' };
    };
    const r = await runSmoke('eco-fast', MODEL, {
      generationFn: seam,
      signal: controller.signal,
      skipDiagnostics: true,
    });
    expect(r.passed).toBe(false);
  });
});

// ─── Diagnostic capture ──────────────────────────────────────────────────

describe('runSmoke — diagnostic capture', () => {
  it('records a diagnostic entry on smoke-pass', async () => {
    const seam: SmokeGenerationFn = async function* (): AsyncIterable<TokenEvent> {
      yield { kind: 'token', text: 'OK' };
      yield { kind: 'done' };
    };
    await runSmoke('eco-fast', MODEL, { generationFn: seam });
    const entries = loadDiagnostics();
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    expect(entry.outcome).toBe('smoke-pass');
    expect(entry.modelId).toBe('local/phi3-mini-4k-q4f16');
    expect(entry.schemaVersion).toBe(2);
    expect(entry.runtimeAdapter).toBe('transformers');
    expect(entry.tokensReceived).toBeGreaterThanOrEqual(1);
    expect(entry.error).toBeNull();
  });

  it('records a diagnostic entry on smoke-fail', async () => {
    const seam: SmokeGenerationFn = async function* (): AsyncIterable<TokenEvent> {
      yield { kind: 'error', reason: 'init-failed' };
    };
    await runSmoke('eco-fast', MODEL, { generationFn: seam });
    const entries = loadDiagnostics();
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    expect(entry.outcome).toBe('smoke-fail');
    expect(entry.error).not.toBeNull();
  });

  it('records a diagnostic on exception throw', async () => {
    // eslint-disable-next-line require-yield
    const seam: SmokeGenerationFn = async function* (): AsyncIterable<TokenEvent> {
      throw new Error('shader compilation failed');
    };
    await runSmoke('eco-fast', MODEL, { generationFn: seam });
    const entries = loadDiagnostics();
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    expect(entry.outcome).toBe('smoke-fail');
    expect(entry.error?.message).toBe('shader compilation failed');
    expect(entry.error?.name).toBe('Error');
  });

  it('diagnostic contains expected lifecycle phases', async () => {
    const seam: SmokeGenerationFn = async function* (): AsyncIterable<TokenEvent> {
      yield { kind: 'token', text: 'OK' };
      yield { kind: 'done' };
    };
    await runSmoke('eco-fast', MODEL, { generationFn: seam });
    const entry = loadDiagnostics()[0]!;
    const phases = entry.events.map((e) => e.phase);
    expect(phases).toContain('webgpu-probe');
    expect(phases).toContain('load-start');
  });

  it('diagnostic contains env info', async () => {
    const seam: SmokeGenerationFn = async function* (): AsyncIterable<TokenEvent> {
      yield { kind: 'token', text: 'OK' };
      yield { kind: 'done' };
    };
    await runSmoke('eco-fast', MODEL, { generationFn: seam });
    const entry = loadDiagnostics()[0]!;
    expect(entry.env).toBeDefined();
    expect(typeof entry.env.userAgent).toBe('string');
  });

  it('diagnostic contains webgpu probe data', async () => {
    const seam: SmokeGenerationFn = async function* (): AsyncIterable<TokenEvent> {
      yield { kind: 'token', text: 'OK' };
      yield { kind: 'done' };
    };
    await runSmoke('eco-fast', MODEL, { generationFn: seam });
    const entry = loadDiagnostics()[0]!;
    expect(entry.webgpu).toBeDefined();
    expect(typeof entry.webgpu.available).toBe('boolean');
    expect(typeof entry.webgpu.adapterRequested).toBe('boolean');
  });

  it('diagnostic records durations.totalMs', async () => {
    let nowMs = 1000;
    const seam: SmokeGenerationFn = async function* (): AsyncIterable<TokenEvent> {
      nowMs += 500;
      yield { kind: 'token', text: 'OK' };
      yield { kind: 'done' };
    };
    await runSmoke('eco-fast', MODEL, {
      generationFn: seam,
      now: () => nowMs,
    });
    const entry = loadDiagnostics()[0]!;
    expect(entry.durations.totalMs).toBeGreaterThan(0);
  });

  it('skipDiagnostics prevents recording', async () => {
    const seam: SmokeGenerationFn = async function* (): AsyncIterable<TokenEvent> {
      yield { kind: 'token', text: 'OK' };
      yield { kind: 'done' };
    };
    await runSmoke('eco-fast', MODEL, { generationFn: seam, skipDiagnostics: true });
    expect(loadDiagnostics()).toHaveLength(0);
  });

  it('diagnostic recording never breaks the smoke result', async () => {
    // Mock recordDiagnostic to throw — smoke should still return normally
    const origSetItem = localStorage.setItem.bind(localStorage);
    localStorage.setItem = () => {
      throw new Error('Storage full');
    };
    try {
      const seam: SmokeGenerationFn = async function* (): AsyncIterable<TokenEvent> {
        yield { kind: 'token', text: 'OK' };
        yield { kind: 'done' };
      };
      const result = await runSmoke('eco-fast', MODEL, { generationFn: seam });
      // Should still return the correct result despite recording failure
      expect(result.passed).toBe(true);
    } finally {
      localStorage.setItem = origSetItem;
    }
  });

  it('records a diagnostic when no generation function is registered (early-return)', async () => {
    // No seam registered — should still capture a diagnostic
    expect(hasSmokeGenerationFn()).toBe(false);
    const result = await runSmoke('eco-fast', MODEL);
    expect(result.passed).toBe(false);
    if (!result.passed) {
      expect(result.reason).toMatch(/no smoke generation function/i);
    }
    const entries = loadDiagnostics();
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    expect(entry.outcome).toBe('smoke-fail');
    expect(entry.modelId).toBe('local/phi3-mini-4k-q4f16');
    expect(entry.error?.message).toMatch(/no smoke generation function/i);
    expect(entry.events.length).toBeGreaterThanOrEqual(1);
    expect(entry.webgpu).toBeDefined();
  });

  it('records a diagnostic when slot is already busy (early-return)', async () => {
    let release: (() => void) | null = null;
    const blockerSeam: SmokeGenerationFn = async function* (): AsyncIterable<TokenEvent> {
      await new Promise<void>((r) => { release = r; });
      yield { kind: 'token', text: 'OK' };
      yield { kind: 'done' };
    };
    setSmokeGenerationFn(blockerSeam);

    const first = runSmoke('eco-fast', MODEL);
    // Wait for the first call to enter the active set (past the async probes).
    for (let i = 0; i < 10; i++) await Promise.resolve();

    const second = await runSmoke('eco-fast', MODEL);
    expect(second.passed).toBe(false);
    if (!second.passed) {
      expect(second.reason).toMatch(/already running/i);
    }

    // The second (early-return) call should have recorded a diagnostic
    const entries = loadDiagnostics();
    const busyEntry = entries.find((e) => e.error?.message.match(/already running/i));
    expect(busyEntry).toBeDefined();
    expect(busyEntry!.outcome).toBe('smoke-fail');
    expect(busyEntry!.webgpu).toBeDefined();

    release!();
    await first;
  });

  it('skipDiagnostics prevents recording on early-return paths', async () => {
    // No seam registered, but skipDiagnostics is true
    expect(hasSmokeGenerationFn()).toBe(false);
    await runSmoke('eco-fast', MODEL, { skipDiagnostics: true });
    expect(loadDiagnostics()).toHaveLength(0);
  });
});

// ─── Empty cache early exit (Phi-3 download orchestration) ───────────────

describe('runSmoke — empty cache early exit', () => {
  beforeEach(() => {
    // Remove the caches stub so the cache probe returns null (no Cache API),
    // simulating a never-downloaded model.
    vi.unstubAllGlobals();
  });

  it('returns "Model not yet downloaded" when cache has no files', async () => {
    // Register a seam that should NOT be called — the empty-cache guard
    // must fire before the generation function is invoked.
    let seamCalled = false;
    const seam: SmokeGenerationFn = async function* (): AsyncIterable<TokenEvent> {
      seamCalled = true;
      yield { kind: 'token', text: 'OK' };
      yield { kind: 'done' };
    };
    setSmokeGenerationFn(seam);

    // Without the caches global, the cache probe returns null — which
    // triggers the early exit. This matches the "never downloaded" state.
    const r = await runSmoke('eco-fast', MODEL, { skipDiagnostics: true });
    expect(r.passed).toBe(false);
    if (!r.passed) {
      expect(r.reason).toBe('Model not yet downloaded');
    }
    expect(seamCalled).toBe(false);
  });

  it('releases the active flag even on cache-empty early exit', async () => {
    setSmokeGenerationFn(async function* (): AsyncIterable<TokenEvent> {
      yield { kind: 'token', text: 'OK' };
      yield { kind: 'done' };
    });
    await runSmoke('eco-fast', MODEL, { skipDiagnostics: true });
    expect(isSmokeActive('eco-fast')).toBe(false);
  });

  it('records a diagnostic on cache-empty early exit', async () => {
    setSmokeGenerationFn(async function* (): AsyncIterable<TokenEvent> {
      yield { kind: 'token', text: 'OK' };
      yield { kind: 'done' };
    });
    const r = await runSmoke('eco-fast', MODEL);
    expect(r.passed).toBe(false);
    if (!r.passed) {
      expect(r.reason).toBe('Model not yet downloaded');
    }
    const entries = loadDiagnostics();
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    expect(entry.outcome).toBe('smoke-fail');
    expect(entry.error?.message).toBe('Model not yet downloaded');
    expect(entry.events.some((e) => e.phase === 'load-fail')).toBe(true);
  });
});

// ─── WebLLM cache gate ───────────────────────────────────────────────────
// A `webllm` model never persists in Eco storage: the cache bridge stages
// files there during download, copies them into WebLLM's own Cache API
// namespaces, and deletes each staging copy. The download-guard for that
// runtime must therefore consult WebLLM's cache, not the Eco namespace —
// otherwise every successfully downloaded webllm model reads as "not yet
// downloaded" and setup declines the device (observed on-device 2026-07-23).

describe('runSmoke — webllm cache gate', () => {
  const WEBLLM_MODEL: ModelConfig = {
    ...MODEL,
    id: 'candidate/qwen2.5-0.5b-mlc',
    friendlyName: 'Qwen2.5 0.5B',
    vendor: 'Alibaba',
    sizeGB: 0.27,
    runtime: 'webllm',
    format: 'mlc-q4f16',
  };

  it('runs generation when WebLLM has the model cached even though Eco staging is empty', async () => {
    // Post-bridge state: Eco staging cache empty by design.
    vi.unstubAllGlobals();
    webllmModelInCacheMock.mockResolvedValue(true);

    let seamCalled = false;
    setSmokeGenerationFn(async function* (): AsyncIterable<TokenEvent> {
      seamCalled = true;
      yield { kind: 'token', text: 'OK' };
      yield { kind: 'done' };
    });

    const r = await runSmoke('eco-fast', WEBLLM_MODEL, { skipDiagnostics: true });
    expect(seamCalled).toBe(true);
    expect(r.passed).toBe(true);
  });

  it('still early-exits when the model is missing from the WebLLM cache, even if Eco staging has files', async () => {
    // Mid-download leftovers in staging must not count as downloaded:
    // running smoke then would let the engine fetch weights from the
    // network, which the bridge exists to prevent.
    webllmModelInCacheMock.mockResolvedValue(false);
    let seamCalled = false;
    setSmokeGenerationFn(async function* (): AsyncIterable<TokenEvent> {
      seamCalled = true;
      yield { kind: 'token', text: 'OK' };
      yield { kind: 'done' };
    });

    const r = await runSmoke('eco-fast', WEBLLM_MODEL);
    expect(r.passed).toBe(false);
    if (!r.passed) {
      expect(r.reason).toBe('Model not yet downloaded');
    }
    expect(seamCalled).toBe(false);
    const entry = loadDiagnostics()[0]!;
    expect(
      entry.events.some((e) => e.phase === 'cache-probe' && e.note === 'webllm cache: miss'),
    ).toBe(true);
  });

  it('does not consult the WebLLM cache for non-webllm runtimes', async () => {
    vi.unstubAllGlobals();
    setSmokeGenerationFn(async function* (): AsyncIterable<TokenEvent> {
      yield { kind: 'token', text: 'OK' };
      yield { kind: 'done' };
    });
    const r = await runSmoke('eco-fast', MODEL, { skipDiagnostics: true });
    expect(r.passed).toBe(false);
    expect(webllmModelInCacheMock).not.toHaveBeenCalled();
  });
});

// ─── Filtered-only output (Qwen3 reasoning model) ────────────────────────

describe('runSmoke — filtered output (reasoning model)', () => {
  it('passes when worker reports completionTokens > 0 but no visible tokens reached main thread', async () => {
    // Simulates a reasoning model like Qwen3 0.6B where ALL output is
    // consumed by the ThinkTagFilter / StopSequenceFilter: the worker
    // generates tokens internally (completionTokens > 0) but the output
    // filter chain strips everything, so zero `token` events reach the
    // main thread. The `done` event carries the worker's completionTokens.
    const seam: SmokeGenerationFn = async function* (): AsyncIterable<TokenEvent> {
      // No `token` events — simulates the filter chain eating everything.
      // The `done` event reports that the worker DID produce tokens.
      yield { kind: 'done', completionTokens: 12, promptTokens: 5 };
    };
    const r = await runSmoke('eco-fast', MODEL, {
      generationFn: seam,
      skipDiagnostics: true,
    });
    expect(r.passed).toBe(true);
    if (r.passed) {
      // tokensReceived should reflect the worker's count when no visible tokens
      expect(r.tokensReceived).toBe(12);
      // firstTokenMs is 0 since no token event was observed on the main thread
      expect(r.firstTokenMs).toBe(0);
    }
  });

  it('still fails when worker reports completionTokens=0 and no visible tokens', async () => {
    const seam: SmokeGenerationFn = async function* (): AsyncIterable<TokenEvent> {
      yield { kind: 'done', completionTokens: 0 };
    };
    const r = await runSmoke('eco-fast', MODEL, {
      generationFn: seam,
      skipDiagnostics: true,
    });
    expect(r.passed).toBe(false);
    if (!r.passed) {
      expect(r.reason).toMatch(/no tokens/i);
    }
  });

  it('still fails when worker reports completionTokens > 0 but there was an error', async () => {
    const seam: SmokeGenerationFn = async function* (): AsyncIterable<TokenEvent> {
      yield { kind: 'error', reason: 'device lost mid-generation' };
    };
    const r = await runSmoke('eco-fast', MODEL, {
      generationFn: seam,
      skipDiagnostics: true,
    });
    expect(r.passed).toBe(false);
  });

  it('prefers visible token count when both visible and worker tokens exist', async () => {
    let nowMs = 1000;
    const seam: SmokeGenerationFn = async function* (): AsyncIterable<TokenEvent> {
      nowMs += 100;
      yield { kind: 'token', text: 'OK' };
      yield { kind: 'done', completionTokens: 5 };
    };
    const r = await runSmoke('eco-fast', MODEL, {
      generationFn: seam,
      now: () => nowMs,
      skipDiagnostics: true,
    });
    expect(r.passed).toBe(true);
    if (r.passed) {
      // When visible tokens exist, tokensReceived reflects the main-thread count
      expect(r.tokensReceived).toBe(1);
      expect(r.firstTokenMs).toBeGreaterThan(0);
    }
  });
});

// ─── Event labeling (load-fail vs generation-fail) ───────────────────────

describe('runSmoke — event phase labeling', () => {
  it('labels errors during generation iteration as generation-fail', async () => {
    // The seam returns an iterable (load succeeds), but the iteration throws.
    const seam: SmokeGenerationFn = async function* (): AsyncIterable<TokenEvent> {
      yield { kind: 'token', text: 'OK' };
      throw new Error('ONNX runtime error during generation');
    };
    await runSmoke('eco-fast', MODEL, { generationFn: seam });
    const entry = loadDiagnostics()[0]!;
    expect(entry.outcome).toBe('smoke-fail');
    const phases = entry.events.map((e) => e.phase);
    // load-finish should be present (seam returned successfully).
    expect(phases).toContain('load-finish');
    // The throw should be labeled generation-fail, NOT load-fail.
    expect(phases).toContain('generation-fail');
    expect(phases).not.toContain('load-fail');
  });

  it('labels errors before iterable creation as load-fail', async () => {
    // The seam throws synchronously (load fails).
    const seam: SmokeGenerationFn = () => {
      throw new Error('WebGPU device creation failed');
    };
    await runSmoke('eco-fast', MODEL, { generationFn: seam });
    const entry = loadDiagnostics()[0]!;
    expect(entry.outcome).toBe('smoke-fail');
    const phases = entry.events.map((e) => e.phase);
    // load-finish should NOT be present (seam threw before returning).
    expect(phases).not.toContain('load-finish');
    // The throw should be labeled load-fail.
    expect(phases).toContain('load-fail');
    expect(phases).not.toContain('generation-fail');
  });
});

// ─── Cache file name capture ──────────────────────────────────────────────

describe('runSmoke — cache file name capture', () => {
  it('captures file names from the cache probe in diagnostic events and cache field', async () => {
    const fakeCache = {
      keys: async () => [
        new Request('https://example.com/onnx/model_q4f16.onnx'),
        new Request('https://example.com/onnx/model_q4f16.onnx_data'),
        new Request('https://example.com/tokenizer.json'),
      ],
      match: async () => new Response('x', { headers: { 'x-eco-cache-size-bytes': '1024' } }),
      put: async () => undefined,
      delete: async () => true,
    };
    vi.stubGlobal('caches', {
      has: async () => true,
      open: async () => fakeCache,
      keys: async () => ['eco-local-ai-local_phi3-mini-4k-q4f16'],
      delete: async () => true,
    });

    const seam: SmokeGenerationFn = async function* (): AsyncIterable<TokenEvent> {
      yield { kind: 'token', text: 'OK' };
      yield { kind: 'done' };
    };
    await runSmoke('eco-fast', MODEL, { generationFn: seam });
    const entry = loadDiagnostics()[0]!;

    // The cache field should contain file names
    expect(entry.cache).toBeDefined();
    expect(entry.cache!.files).toBeDefined();
    expect(entry.cache!.files).toEqual(['model_q4f16.onnx', 'model_q4f16.onnx_data', 'tokenizer.json']);
    expect(entry.cache!.fileCount).toBe(3);

    // The cache-probe event note should list the file names
    const cacheEvent = entry.events.find((e) => e.phase === 'cache-probe');
    expect(cacheEvent).toBeDefined();
    expect(cacheEvent!.note).toContain('model_q4f16.onnx');
    expect(cacheEvent!.note).toContain('model_q4f16.onnx_data');
    expect(cacheEvent!.note).toContain('tokenizer.json');
  });

  it('caps file names at 20 entries', async () => {
    const requests: Request[] = [];
    for (let i = 0; i < 25; i++) {
      requests.push(new Request(`https://example.com/file_${i}.bin`));
    }
    const fakeCache = {
      keys: async () => requests,
      match: async () => new Response('x', { headers: { 'x-eco-cache-size-bytes': '100' } }),
      put: async () => undefined,
      delete: async () => true,
    };
    vi.stubGlobal('caches', {
      has: async () => true,
      open: async () => fakeCache,
      keys: async () => ['eco-local-ai-local_phi3-mini-4k-q4f16'],
      delete: async () => true,
    });

    const seam: SmokeGenerationFn = async function* (): AsyncIterable<TokenEvent> {
      yield { kind: 'token', text: 'OK' };
      yield { kind: 'done' };
    };
    await runSmoke('eco-fast', MODEL, { generationFn: seam });
    const entry = loadDiagnostics()[0]!;

    // Should be capped at 20 file names even though 25 exist
    expect(entry.cache!.files).toHaveLength(20);
    expect(entry.cache!.fileCount).toBe(25);
  });
});
