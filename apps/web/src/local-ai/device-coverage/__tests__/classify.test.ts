// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC
import { describe, expect, it } from 'vitest';
import { classifyCell, type CoverageOutcome } from '../classify';
import type { MatrixCell } from '../device-matrix';

const base = (over: Partial<MatrixCell['profile']>): MatrixCell => ({
  profile: {
    browserClass: 'chromium',
    webgpuSupport: 'webgpu',
    deviceMemoryGB: 16,
    isMobile: false,
    webgpuShaderF16: true,
    override: 'auto',
    ...over,
  },
  ledger: 'fresh',
  download: 'success',
  smoke: 'pass',
});

describe('classifyCell', () => {
  it('serves a capable Chromium/WebGPU/16GB device', async () => {
    const out = await classifyCell(base({}));
    expect(out.kind).toBe('served');
  });

  it('declines a no-WebGPU low-memory device via below-floor', async () => {
    const out = await classifyCell(base({ webgpuSupport: 'none', deviceMemoryGB: 2 }));
    expect(out).toEqual<CoverageOutcome>({ kind: 'declined', surface: 'below-floor' });
  });

  it('never returns served with an empty modelId', async () => {
    const out = await classifyCell(base({}));
    if (out.kind === 'served') expect(out.modelId.length).toBeGreaterThan(0);
  });
});
