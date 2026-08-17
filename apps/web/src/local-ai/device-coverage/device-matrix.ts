// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Device-matrix enumeration for the coverage audit. Defines the full universe
 * of device profiles the routing system can perceive (the six DeviceProfile
 * axes, all URL-forceable) crossed with the contextual dimensions that change
 * the setup outcome (ledger history, download result, smoke result).
 *
 * Pure data. `classify.ts` runs each cell through the real selection + setup
 * functions; `__tests__/coverage-matrix.test.ts` asserts the guarantee over
 * the product.
 */

import type { BrowserClass, DeviceProfile, WebGPUSupport } from '../types';

const BROWSERS: readonly BrowserClass[] = ['chromium', 'safari', 'firefox', 'mobile', 'unknown'];
const CAPS: readonly WebGPUSupport[] = ['webgpu', 'wasm-only', 'none'];
// 0 = deviceMemory unreported (Safari/Firefox/unknown). 8 = Chromium cap.
const MEMS: readonly number[] = [0, 2, 4, 8, 16];
const SHADER_F16: readonly (boolean | undefined)[] = [true, false, undefined];
const MOBILE: readonly boolean[] = [false, true];
// The WebGPU adapter's `maxBufferSize` ceiling in bytes. Only probed on WebGPU
// devices — the setup path leaves it `undefined` elsewhere (see DeviceProfile) —
// so it varies only under the `webgpu` cap. The two probed points bracket any
// future max-buffer floor: a tiny cap a floor would reject, and a large cap it
// would accept. No catalog rule declares `minMaxBufferBytes` today, so all three
// collapse to the same outcome; the axis is enumerated so the audit perceives it
// and gains below/above-floor coverage the moment a rule adds a floor.
const MAX_BUFFER_BYTES: readonly (number | undefined)[] = [undefined, 128_000_000, 2_147_483_648];

export type LedgerState =
  | 'fresh'
  | 'recent-smoke-failure'
  | 'download-fail-demoted'
  | 'currently-bound';
export type DownloadInjection = 'success' | 'transient-fail' | 'storage-fail';
export type SmokeInjection = 'pass' | 'fail';

export type MatrixCell = {
  profile: DeviceProfile;
  ledger: LedgerState;
  download: DownloadInjection;
  smoke: SmokeInjection;
};

export function enumerateProfiles(): DeviceProfile[] {
  const out: DeviceProfile[] = [];
  for (const browserClass of BROWSERS)
    for (const webgpuSupport of CAPS)
      for (const deviceMemoryGB of MEMS)
        for (const webgpuShaderF16 of SHADER_F16)
          for (const isMobile of MOBILE)
            // maxBufferBytes is a WebGPU-only probe; on every other cap the real
            // profiler leaves it unprobed, so don't fabricate values there.
            for (const webgpuMaxBufferBytes of webgpuSupport === 'webgpu'
              ? MAX_BUFFER_BYTES
              : [undefined])
              out.push({
                browserClass,
                webgpuSupport,
                deviceMemoryGB,
                isMobile,
                webgpuShaderF16,
                webgpuMaxBufferBytes,
                override: 'auto',
              });
  return out;
}

const LEDGERS: readonly LedgerState[] = [
  'fresh',
  'recent-smoke-failure',
  'download-fail-demoted',
  'currently-bound',
];

/**
 * Full cell product. The clean (fresh · success · pass) slice covers every
 * profile once; the failure injections add cascade/ladder coverage without
 * multiplying by every ledger state (that product is large and mostly
 * redundant — the ledger only gates admission, exercised on the fresh slice).
 */
export function enumerateCells(): MatrixCell[] {
  const profiles = enumerateProfiles();
  const cells: MatrixCell[] = [];
  for (const profile of profiles) {
    cells.push({ profile, ledger: 'fresh', download: 'success', smoke: 'pass' });
    cells.push({ profile, ledger: 'fresh', download: 'transient-fail', smoke: 'pass' });
    cells.push({ profile, ledger: 'fresh', download: 'storage-fail', smoke: 'pass' });
    cells.push({ profile, ledger: 'fresh', download: 'success', smoke: 'fail' });
  }
  for (const profile of profiles)
    for (const ledger of LEDGERS.filter((l) => l !== 'fresh'))
      cells.push({ profile, ledger, download: 'success', smoke: 'pass' });
  return cells;
}
