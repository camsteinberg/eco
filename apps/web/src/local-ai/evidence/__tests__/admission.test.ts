// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Phase E — evidence/admission.ts parametric tests.
 *
 * Verifies the unified admission gate produces the correct decision for
 * every (v1.0 catalog model × representative profile) pair. The expectation
 * table below is the spec — if a row changes, the catalog or compatibility
 * table should change first.
 *
 * Reasons asserted alongside decisions so we catch silent drift (e.g. a
 * 'with-warning' that came from the wrong path).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { admit } from '../admission';
import { CURRENT_LEDGER_VERSION } from '../ledger';
import { getModel } from '../../catalog/catalog';
import type { DeviceProfile } from '../../types';

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
});

const PROFILES = {
  chromiumHighMem: {
    browserClass: 'chromium',
    webgpuSupport: 'webgpu',
    deviceMemoryGB: 24,
    isMobile: false,
    override: 'auto',
  },
  chromiumCapableLaptop: {
    browserClass: 'chromium',
    webgpuSupport: 'webgpu',
    deviceMemoryGB: 8,
    isMobile: false,
    override: 'auto',
  },
  chromiumLowMem: {
    browserClass: 'chromium',
    webgpuSupport: 'webgpu',
    deviceMemoryGB: 4,
    isMobile: false,
    override: 'auto',
  },
  safariWasm: {
    browserClass: 'safari',
    webgpuSupport: 'wasm-only',
    deviceMemoryGB: 8,
    isMobile: false,
    override: 'auto',
  },
  firefoxWasm: {
    browserClass: 'firefox',
    webgpuSupport: 'wasm-only',
    deviceMemoryGB: 16,
    isMobile: false,
    override: 'auto',
  },
  mobileIphone: {
    browserClass: 'safari',
    webgpuSupport: 'wasm-only',
    deviceMemoryGB: 4,
    isMobile: true,
    override: 'auto',
  },
  belowFloor: {
    browserClass: 'unknown',
    webgpuSupport: 'none',
    deviceMemoryGB: 2,
    isMobile: false,
    override: 'auto',
  },
} as const satisfies Record<string, DeviceProfile>;

function model(id: string) {
  const m = getModel(id);
  if (!m) throw new Error(`expected catalog model ${id}`);
  return m;
}

// LFM2.5-1.2B is proven only on the high-memory-laptop class (its sole seed
// row), so it exercises the mirror of what Bonsai used to: proven-on-profile on
// high-memory, proven-elsewhere on the compatible-but-unseeded capable-laptop, and
// admitted with-warning down to its 4 GB floor (device-coverage audit 2026-08-17:
// the fast 1.2B floor dropped 8→4). (Bonsai retired 2026-07-11.)
describe('admit — LFM2.5 1.2B (proven on high-memory)', () => {
  const lfm = () => model('candidate/lfm2.5-1.2b-instruct-onnx');

  it('allowed on Chromium 24 GB (seed proof present for high-memory-laptop)', () => {
    // The high-memory benchmark row (2026-06-17) must be inside its 45-day TTL;
    // pin the clock to the snapshot date.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-19T00:00:00.000Z'));
    const r = admit(lfm(), PROFILES.chromiumHighMem);
    expect(r.decision).toBe('allowed');
    expect(r.reason).toBe('proven-on-this-profile');
    expect(r.hasSeedProof).toBe(true);
  });

  it('with-warning on Chromium 8 GB (no seed for capable-laptop class — proven elsewhere)', () => {
    const r = admit(lfm(), PROFILES.chromiumCapableLaptop);
    expect(r.decision).toBe('with-warning');
    expect(r.reason).toBe('proven-elsewhere');
  });

  it('with-warning on Chromium 4 GB (compat floor is now 4 GB — recovered band, unseeded)', () => {
    // The 1.2B floor dropped 8→4: a 4-7GB WebGPU device (reports device-memory 4)
    // now runs the 1.2B. It has no seed row for the low-memory-laptop class, so it is
    // admitted with-warning (proven elsewhere) and gated by the first-use smoke test,
    // rather than denied outright.
    const r = admit(lfm(), PROFILES.chromiumLowMem);
    expect(r.decision).toBe('with-warning');
    expect(r.reason).toBe('proven-elsewhere');
  });
});

describe('admit — Qwen3 (calculated coverage on low-memory + cross-browser)', () => {
  const qwen = () => model('local/qwen3-0.6b');

  it('allowed on Chromium 4 GB (calculated seed proof from backfill)', () => {
    // Backfill rows crossed their 45-day TTL on wall-clock 2026-07-01; pin to
    // the snapshot date like the sibling proof-present tests.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-19T00:00:00.000Z'));
    const r = admit(qwen(), PROFILES.chromiumLowMem);
    expect(r.decision).toBe('allowed');
    expect(r.reason).toBe('proven-on-this-profile');
    expect(r.seedProofSource).toBe('calculated');
  });

  it('allowed on Safari WASM (calculated seed proof from backfill)', () => {
    // Backfill rows must be inside their 45-day TTL; pin like the siblings.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-19T00:00:00.000Z'));
    const r = admit(qwen(), PROFILES.safariWasm);
    expect(r.decision).toBe('allowed');
    expect(r.reason).toBe('proven-on-this-profile');
    expect(r.seedProofSource).toBe('calculated');
  });

  it('allowed on Firefox WASM (calculated seed proof from backfill)', () => {
    // Backfill rows must be inside their 45-day TTL; pin like the siblings.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-19T00:00:00.000Z'));
    const r = admit(qwen(), PROFILES.firefoxWasm);
    expect(r.decision).toBe('allowed');
    expect(r.reason).toBe('proven-on-this-profile');
    expect(r.seedProofSource).toBe('calculated');
  });
});

describe('admit — LFM2.5 350M (CPU-EP-unloadable on WASM — Finding E)', () => {
  const lfm = () => model('candidate/lfm2.5-350m-onnx');

  // The 350m's block-quant embeddings need GatherBlockQuantized, absent on
  // ort-web's CPU EP — so it is incompatible (and therefore denied) on every
  // wasm-only device, no matter what the seed backfill says. Admission delegates
  // to compatibility, so the Finding E rule propagates here for free.
  it('denied on Firefox WASM (incompatible on the CPU EP)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-19T00:00:00.000Z'));
    const r = admit(lfm(), PROFILES.firefoxWasm);
    expect(r.decision).toBe('denied');
    expect(r.reason).toBe('incompatible-device');
  });

  it('denied on mobile Safari 4 GB (wasm-only → CPU EP)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-19T00:00:00.000Z'));
    const r = admit(lfm(), PROFILES.mobileIphone);
    expect(r.decision).toBe('denied');
    expect(r.reason).toBe('incompatible-device');
  });

  it('denied when below floor (webgpuSupport none)', () => {
    expect(admit(lfm(), PROFILES.belowFloor).decision).toBe('denied');
  });
});

describe('admit — runtime ledger override', () => {
  it('stays allowed with seed proof even without ledger (backfill covers safari wasm)', () => {
    // Backfill rows must be inside their 45-day TTL; pin like the siblings.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-19T00:00:00.000Z'));
    const qwen = model('local/qwen3-0.6b');
    // After backfill: Safari WASM has calculated seed proof → already allowed.
    const r = admit(qwen, PROFILES.safariWasm);
    expect(r.decision).toBe('allowed');
    expect(r.reason).toBe('proven-on-this-profile');
    expect(r.hasSeedProof).toBe(true);
    expect(r.seedProofSource).toBe('calculated');
  });

  it('promotes to allowed via ledger when seed proof is absent (proven-elsewhere profile)', () => {
    // Use a profile that has no seed proof: LFM2.5-1.2B is seeded only for
    // high-memory-laptop, so on capable-laptop (8 GB) it is compatible but
    // unseeded → with-warning, until a ledger success promotes it.
    const lfm = model('candidate/lfm2.5-1.2b-instruct-onnx');
    expect(admit(lfm, PROFILES.chromiumCapableLaptop).decision).toBe('with-warning');

    localStorage.setItem(
      'eco-local-ai-ledger-v1',
      JSON.stringify([
        {
          modelId: 'candidate/lfm2.5-1.2b-instruct-onnx',
          profileKey: 'chromium|capable-laptop|webgpu',
          outcome: 'smoke-pass',
          recordedAt: new Date().toISOString(),
          ledgerVersion: CURRENT_LEDGER_VERSION,
        },
      ]),
    );

    const after = admit(lfm, PROFILES.chromiumCapableLaptop);
    expect(after.decision).toBe('allowed');
    expect(after.reason).toBe('ledger-success');
    expect(after.hasLedgerSuccess).toBe(true);
  });

  it('reports recentFailureCount when the ledger has smoke-fail entries', () => {
    const qwen = model('local/qwen3-0.6b');
    localStorage.setItem(
      'eco-local-ai-ledger-v1',
      JSON.stringify([
        {
          modelId: 'local/qwen3-0.6b',
          profileKey: `chromium|low-memory-laptop|webgpu`,
          outcome: 'smoke-fail',
          recordedAt: new Date().toISOString(),
          ledgerVersion: CURRENT_LEDGER_VERSION,
        },
        {
          modelId: 'local/qwen3-0.6b',
          profileKey: `chromium|low-memory-laptop|webgpu`,
          outcome: 'generate-fail',
          recordedAt: new Date().toISOString(),
          ledgerVersion: CURRENT_LEDGER_VERSION,
        },
      ]),
    );
    const r = admit(qwen, PROFILES.chromiumLowMem);
    expect(r.recentFailureCount).toBe(2);
  });

  it('reports recentDownloadFailureCount from genuine download-fail rows in the window', () => {
    const qwen = model('local/qwen3-0.6b');
    localStorage.setItem(
      'eco-local-ai-ledger-v1',
      JSON.stringify([
        {
          modelId: 'local/qwen3-0.6b',
          profileKey: 'chromium|low-memory-laptop|webgpu',
          outcome: 'download-fail',
          errorCode: 'failed',
          recordedAt: new Date().toISOString(),
          ledgerVersion: CURRENT_LEDGER_VERSION,
        },
        {
          modelId: 'local/qwen3-0.6b',
          profileKey: 'chromium|low-memory-laptop|webgpu',
          outcome: 'download-fail',
          errorCode: 'aborted', // a user cancel — not counted
          recordedAt: new Date().toISOString(),
          ledgerVersion: CURRENT_LEDGER_VERSION,
        },
      ]),
    );
    const r = admit(qwen, PROFILES.chromiumLowMem);
    expect(r.recentDownloadFailureCount).toBe(1);
    // Download failures don't touch the smoke-failure count.
    expect(r.recentFailureCount).toBe(0);
  });

  it('seedProofSource distinguishes benchmark from calculated', () => {
    // The high-memory LFM2.5-1.2B benchmark seed is dated 2026-06-19; the
    // LFM2.5-350M high-memory row was backfilled as calculated (2026-05-18). Both
    // must be inside their 45-day TTL, so pin the clock to the benchmark date.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-19T00:00:00.000Z'));
    const bench = model('candidate/lfm2.5-1.2b-instruct-onnx');
    const lfm = model('candidate/lfm2.5-350m-onnx');
    expect(admit(bench, PROFILES.chromiumHighMem).seedProofSource).toBe('benchmark');
    // LFM2.5-350M on high-memory was backfilled as calculated.
    expect(admit(lfm, PROFILES.chromiumHighMem).seedProofSource).toBe('calculated');
  });
});
