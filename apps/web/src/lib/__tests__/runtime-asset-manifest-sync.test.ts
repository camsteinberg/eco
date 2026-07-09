// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Drift guard: the runtime engine-asset manifest MUST match a pinned, inline
 * expected set. When the build's copied-asset list changes, this test fails
 * until the pinned list below is updated in the same commit — a forcing
 * function so a new/renamed engine static can never ship unnoticed.
 *
 * The build source of truth is `RUNTIME_ASSET_COPIES` in
 * `apps/web/scripts/copy-runtime-assets.mjs` (what `next build` copies into
 * public/). This test parses that file as text (no import, so it stays
 * decoupled from module/type resolution) and asserts it equals
 * `EXPECTED_RUNTIME_ASSETS`.
 *
 * Ops cross-check (kept out of this repo on purpose): the production/weekly
 * smoke probe — the `ENGINE_ASSETS` list in the ops-only
 * `production-web-smoke.sh` (now in the private notes repo) — probes these same
 * served URLs. That script must mirror `EXPECTED_RUNTIME_ASSETS` below so a
 * copied asset is never shipped unprobed (the #204 blind spot: "LiteRT/Gemma
 * assets never served in prod"). This test can only guard the in-repo half;
 * whoever edits the pinned list must also update the ops smoke list.
 *
 * A file's served URL path is `/<publicDir>/<file>`; kind is `wasm` for `.wasm`
 * (the smoke asserts application/wasm) and `js` otherwise.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const MJS_PATH = path.resolve(here, '../../../scripts/copy-runtime-assets.mjs');

type Asset = { path: string; kind: 'wasm' | 'js' };

const byPath = (a: Asset, b: Asset) => a.path.localeCompare(b.path);

/**
 * The runtime engine statics the build is expected to copy into public/, by
 * served URL path. Pinned inline so a change to
 * `copy-runtime-assets.mjs`'s `RUNTIME_ASSET_COPIES` forces a matching edit
 * here. When you change this list, also update the `ENGINE_ASSETS` list in the
 * ops-only `production-web-smoke.sh` so the prod smoke keeps probing every
 * served asset.
 */
const EXPECTED_RUNTIME_ASSETS: Asset[] = [
  { path: '/litert-wasm/litertlm_wasm_compat_internal.js', kind: 'js' },
  { path: '/litert-wasm/litertlm_wasm_compat_internal.wasm', kind: 'wasm' },
  { path: '/litert-wasm/litertlm_wasm_internal.js', kind: 'js' },
  { path: '/litert-wasm/litertlm_wasm_internal.wasm', kind: 'wasm' },
  { path: '/ort/ort-wasm-simd-threaded.asyncify.mjs', kind: 'js' },
  { path: '/ort/ort-wasm-simd-threaded.asyncify.wasm', kind: 'wasm' },
];

/** Expected assets from copy-runtime-assets.mjs RUNTIME_ASSET_COPIES. */
function parseManifest(src: string): Asset[] {
  const out: Asset[] = [];
  const blockRe = /publicDir:\s*'([^']+)'[\s\S]*?files:\s*\[([\s\S]*?)\]/g;
  let block: RegExpExecArray | null;
  while ((block = blockRe.exec(src)) !== null) {
    const publicDir = block[1]!;
    const filesBlock = block[2]!;
    const fileRe = /'([^']+)'/g;
    let file: RegExpExecArray | null;
    while ((file = fileRe.exec(filesBlock)) !== null) {
      const name = file[1]!;
      out.push({ path: `/${publicDir}/${name}`, kind: name.endsWith('.wasm') ? 'wasm' : 'js' });
    }
  }
  return out.sort(byPath);
}

describe('runtime asset manifest sync', () => {
  const manifest = parseManifest(readFileSync(MJS_PATH, 'utf8'));

  it('parses a non-empty list from the copy manifest (guards against a broken parser)', () => {
    expect(manifest.length).toBeGreaterThan(0);
  });

  it('the copied RUNTIME_ASSET_COPIES set matches the pinned EXPECTED_RUNTIME_ASSETS', () => {
    expect([...manifest].sort(byPath)).toEqual([...EXPECTED_RUNTIME_ASSETS].sort(byPath));
  });
});
