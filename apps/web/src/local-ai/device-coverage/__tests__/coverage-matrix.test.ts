// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { enumerateCells, type MatrixCell } from '../device-matrix';
import { classifyCell, type CoverageOutcome } from '../classify';
import { KNOWN_UNCOVERED } from '../known-uncovered';
import { logger } from '../../../lib/logger';

function describeProfile(c: MatrixCell): string {
  const p = c.profile;
  return `${p.browserClass}/${p.webgpuSupport}/f16=${String(p.webgpuShaderF16)}/`
    + `${p.deviceMemoryGB}GB/mobile=${p.isMobile}`;
}

describe('device-coverage guarantee', () => {
  const cells = enumerateCells();
  let outcomes: CoverageOutcome[] = [];
  let broken: MatrixCell[] = [];

  beforeAll(async () => {
    // The real cascade emits an advisory debug log ("nextInCascade called twice")
    // when the same failed model id passes through across the ~3k-cell census.
    // It's correctness-guarded telemetry, not a signal — mute it so the census
    // output stays readable.
    vi.spyOn(logger, 'debug').mockImplementation(() => {});
    outcomes = await Promise.all(cells.map(classifyCell));
    broken = cells.filter((_, i) => outcomes[i]!.kind === 'silent-broken');
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  it('every silent-broken cell is on the KNOWN_UNCOVERED allowlist', () => {
    const unlisted = broken.filter((c) => !KNOWN_UNCOVERED.some((e) => e.match(c)));
    // Deduplicated by profile for a readable failure — the ledger/injection
    // dimensions collapse onto the same selection-layer throw.
    const distinct = [...new Set(unlisted.map(describeProfile))].sort();
    expect(distinct).toEqual([]);
  });

  it('no allowlist entry is stale (each must still match a broken cell)', () => {
    const stale = KNOWN_UNCOVERED.filter((e) => !broken.some((c) => e.match(c)));
    expect(stale.map((e) => e.findingId)).toEqual([]);
  });

  it('census: emit the full classification for the audit report', () => {
    const counts: Record<CoverageOutcome['kind'], number> = {
      served: 0,
      declined: 0,
      'silent-broken': 0,
    };
    const byReason: Record<string, number> = {};
    for (const o of outcomes) {
      counts[o.kind]++;
      if (o.kind === 'silent-broken') byReason[o.reason] = (byReason[o.reason] ?? 0) + 1;
    }
    const distinctBroken = [...new Set(broken.map(describeProfile))].sort();
    expect(counts.served + counts.declined + counts['silent-broken']).toBe(cells.length);

    // Clean-slice coverage: the fresh · download-success · smoke-pass profiles —
    // "who does Eco serve when nothing goes wrong." This is the coverage number
    // that matters for the report; the rest of the matrix is failure-injection
    // that is SUPPOSED to decline.
    const clean = { served: 0, declinedBelowFloor: 0, declinedSetupError: 0 };
    cells.forEach((c, i) => {
      if (!(c.ledger === 'fresh' && c.download === 'success' && c.smoke === 'pass')) return;
      const o = outcomes[i]!;
      if (o.kind === 'served') clean.served++;
      else if (o.kind === 'declined' && o.surface === 'below-floor') clean.declinedBelowFloor++;
      else if (o.kind === 'declined') clean.declinedSetupError++;
    });
    // With nothing failing, no clean-slice profile should hit the recoverable
    // setup-error surface — every non-served clean profile is an honest decline.
    expect(clean.declinedSetupError).toBe(0);

    // eslint-disable-next-line no-console
    console.log('[coverage-census]', JSON.stringify({
      totalCells: cells.length,
      counts,
      silentBrokenByReason: byReason,
      distinctBrokenProfiles: distinctBroken,
      cleanSlice: clean,
    }, null, 2));
  });
});

describe('below-floor gate completeness (B1/B2 regression pin)', () => {
  beforeAll(() => {
    vi.spyOn(logger, 'debug').mockImplementation(() => {});
  });
  afterAll(() => {
    vi.restoreAllMocks();
  });

  const cell = (over: Partial<MatrixCell['profile']>): MatrixCell => ({
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

  // These profiles are NOT caught by isBelowFloor (capability !== 'none', or the
  // memory guard skips an unknown/0 reading), yet no model is assignable — so
  // coverage rests ENTIRELY on the setup-runner NoAssignableModelError catch
  // (setup-runner.ts:261). Pin them: if that catch is ever removed, these flip to
  // silent-broken and this test fails loudly instead of shipping a dead-end.
  it.each([
    ['B1 no-capability + 16GB', cell({ webgpuSupport: 'none', deviceMemoryGB: 16 })],
    ['B1 no-capability + unknown memory', cell({ webgpuSupport: 'none', deviceMemoryGB: 0 })],
    ['B2 webgpu + 2GB', cell({ webgpuSupport: 'webgpu', deviceMemoryGB: 2 })],
    ['B2 wasm-only + 2GB', cell({ webgpuSupport: 'wasm-only', deviceMemoryGB: 2 })],
  ])('%s declines via below-floor (not served, not silent-broken)', async (_label, c) => {
    const out = await classifyCell(c);
    expect(out).toEqual({ kind: 'declined', surface: 'below-floor' });
  });
});

describe('WebKit-mobile designed tier (D1 regression pins)', () => {
  beforeAll(() => {
    vi.spyOn(logger, 'debug').mockImplementation(() => {});
  });
  afterAll(() => {
    vi.restoreAllMocks();
  });

  const cell = (over: Partial<MatrixCell['profile']>): MatrixCell => ({
    profile: {
      browserClass: 'chromium',
      webgpuSupport: 'webgpu',
      deviceMemoryGB: 8,
      isMobile: false,
      webgpuShaderF16: true,
      override: 'auto',
      ...over,
    },
    ledger: 'fresh',
    download: 'success',
    smoke: 'pass',
  });

  // iOS WebKit now has a load-validated pick (Qwen2.5-0.5B via WebLLM/MLC) whose
  // resident working set stays inside the per-tab memory envelope, so a WebGPU iOS
  // device SERVES it. Every ONNX build still crash-loops on load and is gated
  // before load; if the validated pick regressed out, this would flip back to
  // declined/below-floor.
  it('safari + isMobile + webgpu + 8GB serves the WebKit-validated MLC pick', async () => {
    const out = await classifyCell(cell({ browserClass: 'safari', isMobile: true }));
    expect(out).toEqual({ kind: 'served', modelId: 'candidate/qwen2.5-0.5b-mlc', via: 'setup-ladder' });
  });

  // Android guard: Android Chrome is NOT implicated and must keep serving. This
  // pin protects it from an over-broad mobile gate.
  it('chromium + isMobile + webgpu + 8GB stays SERVED (Android is unaffected)', async () => {
    const out = await classifyCell(cell({ browserClass: 'chromium', isMobile: true }));
    expect(out.kind).toBe('served');
  });

  // The UA-stripped 'mobile' class is untouched by the WebKit-mobile gate.
  it("'mobile'-class + webgpu + 8GB behavior is unchanged (still served)", async () => {
    const out = await classifyCell(cell({ browserClass: 'mobile', isMobile: true }));
    expect(out.kind).toBe('served');
  });
});
