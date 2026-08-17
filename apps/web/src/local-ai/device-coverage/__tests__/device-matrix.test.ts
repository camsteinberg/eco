// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC
import { describe, expect, it } from 'vitest';
import { enumerateProfiles, enumerateCells } from '../device-matrix';

describe('device-matrix enumeration', () => {
  it('covers every axis value at least once', () => {
    const p = enumerateProfiles();
    const browsers = new Set(p.map((x) => x.browserClass));
    const caps = new Set(p.map((x) => x.webgpuSupport));
    const mems = new Set(p.map((x) => x.deviceMemoryGB));
    const maxBuffers = new Set(p.map((x) => x.webgpuMaxBufferBytes));
    expect(browsers).toEqual(new Set(['chromium', 'safari', 'firefox', 'mobile', 'unknown']));
    expect(caps).toEqual(new Set(['webgpu', 'wasm-only', 'none']));
    // 0 (unknown/Safari-Firefox) MUST be present — it is a named hunt (H2).
    expect(mems.has(0)).toBe(true);
    expect(mems).toEqual(new Set([0, 2, 4, 8, 16]));
    // The max-buffer axis: unprobed (undefined) plus two probed brackets.
    expect(maxBuffers).toEqual(new Set([undefined, 128_000_000, 2_147_483_648]));
  });

  it('probes maxBufferBytes only on WebGPU profiles', () => {
    // The real profiler leaves webgpuMaxBufferBytes undefined off WebGPU, so the
    // matrix must not fabricate probed values on wasm-only/none profiles.
    const probedOffWebgpu = enumerateProfiles().filter(
      (x) => x.webgpuSupport !== 'webgpu' && x.webgpuMaxBufferBytes !== undefined,
    );
    expect(probedOffWebgpu).toEqual([]);
  });

  it('crosses profiles with ledger + download + smoke injections', () => {
    const cells = enumerateCells();
    // Every profile appears under a fresh ledger with a clean download+smoke.
    const clean = cells.filter(
      (c) => c.ledger === 'fresh' && c.download === 'success' && c.smoke === 'pass',
    );
    expect(clean.length).toBe(enumerateProfiles().length);
    // The storage-fail and smoke-fail injections exist (cascade exercise).
    expect(cells.some((c) => c.download === 'storage-fail')).toBe(true);
    expect(cells.some((c) => c.smoke === 'fail')).toBe(true);
  });
});
