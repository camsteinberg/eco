// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Copy runtime engine assets from node_modules into public/ before `next build`.
 *
 * Why static files instead of the /api/litert-wasm and /api/ort routes: those
 * routes stream from node_modules at request time, which requires the files to
 * exist in the deployed serverless bundle — and the current Next/Vercel build
 * does not honor `outputFileTracingIncludes` for grouped route functions, so
 * both routes 404 in production only (found 2026-07-03: every real-prod
 * LiteRT/Gemma load died instantly; the SW offline precache of /api/ort was
 * silently failing too). Static files under public/ are served by the CDN
 * with no function, no tracing, and no site-gate involvement — nothing left
 * to drift. The API routes remain for older cached clients and local dev.
 *
 * Wired as the first step of @eco/web's `build` script (not an npm pre-hook —
 * pnpm does not run pre/post scripts by default).
 */

import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, '..');

/**
 * A package's install dir via the app's own node_modules symlink (both are
 * direct dependencies). Not require.resolve('<pkg>/package.json') — modern
 * exports maps (onnxruntime-web) don't expose package.json.
 */
function packageDir(name) {
  const dir = path.join(webRoot, 'node_modules', name);
  if (!existsSync(dir)) {
    throw new Error(`[copy-runtime-assets] ${name} not found at ${dir} — run pnpm install`);
  }
  return dir;
}

/**
 * Single source of truth for the runtime engine statics: which package/subdir
 * they come from and where they land under public/. Exported (not just used
 * locally) so the production smoke probe can be kept in sync with it — the
 * drift test at
 * `apps/web/src/lib/__tests__/runtime-asset-manifest-sync.test.ts` fails if the
 * smoke script's asset list diverges from this manifest, which is exactly the
 * blind spot that let "LiteRT assets never served in prod" (#204) ship.
 *
 * `publicDir` is the directory name under public/; a file's served URL path is
 * `/<publicDir>/<file>`.
 */
export const RUNTIME_ASSET_COPIES = [
  {
    package: '@litert-lm/core',
    fromSubdir: 'wasm',
    publicDir: 'litert-wasm',
    files: [
      'litertlm_wasm_internal.js',
      'litertlm_wasm_internal.wasm',
      'litertlm_wasm_compat_internal.js',
      'litertlm_wasm_compat_internal.wasm',
    ],
  },
  {
    package: 'onnxruntime-web',
    fromSubdir: 'dist',
    publicDir: 'ort',
    // `asyncify` is the default artifact (also the WebGPU/JSEP carrier on TJS's
    // `onnxruntime-web/webgpu` path). `standard` and `jspi` are served so the
    // per-device serving matrix can force a leaner WASM-EP artifact via
    // `?eco-force-ort-artifact` (runtime/ort-artifact.ts) — the asyncify build's
    // instrumentation ~doubles the WASM binary, a working-set hypothesis for the
    // WebKit tab-kills. Selection is opt-in; nothing loads these by default.
    files: [
      'ort-wasm-simd-threaded.asyncify.mjs',
      'ort-wasm-simd-threaded.asyncify.wasm',
      'ort-wasm-simd-threaded.mjs',
      'ort-wasm-simd-threaded.wasm',
      'ort-wasm-simd-threaded.jspi.mjs',
      'ort-wasm-simd-threaded.jspi.wasm',
    ],
  },
];

export function copyRuntimeAssets() {
  for (const { package: pkg, fromSubdir, publicDir, files } of RUNTIME_ASSET_COPIES) {
    const from = path.join(packageDir(pkg), fromSubdir);
    const to = path.join(webRoot, 'public', publicDir);
    mkdirSync(to, { recursive: true });
    for (const file of files) {
      copyFileSync(path.join(from, file), path.join(to, file));
    }
    console.log(`[copy-runtime-assets] ${files.length} files → ${path.relative(webRoot, to)}/`);
  }
}

// Run the copy only when invoked as a script (`node scripts/copy-runtime-assets.mjs`),
// not when imported for the manifest (the drift test imports RUNTIME_ASSET_COPIES).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  copyRuntimeAssets();
}
