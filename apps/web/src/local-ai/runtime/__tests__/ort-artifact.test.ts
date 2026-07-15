// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, expect, it } from 'vitest';
import {
  ORT_ARTIFACTS,
  ORT_ASSET_BASE_PATH,
  clampThreads,
  isOrtArtifact,
  ortArtifactFileNames,
  ortWasmPaths,
} from '../ort-artifact';

describe('ortArtifactFileNames — variant → onnxruntime-web dist filenames', () => {
  it('standard has no suffix', () => {
    expect(ortArtifactFileNames('standard')).toEqual({
      wasm: 'ort-wasm-simd-threaded.wasm',
      mjs: 'ort-wasm-simd-threaded.mjs',
    });
  });

  it('asyncify and jspi carry their suffix', () => {
    expect(ortArtifactFileNames('asyncify')).toEqual({
      wasm: 'ort-wasm-simd-threaded.asyncify.wasm',
      mjs: 'ort-wasm-simd-threaded.asyncify.mjs',
    });
    expect(ortArtifactFileNames('jspi')).toEqual({
      wasm: 'ort-wasm-simd-threaded.jspi.wasm',
      mjs: 'ort-wasm-simd-threaded.jspi.mjs',
    });
  });
});

describe('ortWasmPaths — same-origin wasmPaths object', () => {
  it('prefixes the served /ort/ base path by default', () => {
    expect(ortWasmPaths('jspi')).toEqual({
      wasm: '/ort/ort-wasm-simd-threaded.jspi.wasm',
      mjs: '/ort/ort-wasm-simd-threaded.jspi.mjs',
    });
  });

  it('uses ORT_ASSET_BASE_PATH as the default base', () => {
    expect(ortWasmPaths('standard').wasm.startsWith(ORT_ASSET_BASE_PATH)).toBe(true);
  });

  it('honors a custom base path', () => {
    expect(ortWasmPaths('asyncify', '/api/ort/')).toEqual({
      wasm: '/api/ort/ort-wasm-simd-threaded.asyncify.wasm',
      mjs: '/api/ort/ort-wasm-simd-threaded.asyncify.mjs',
    });
  });

  it('every catalogued artifact maps to a valid pair', () => {
    for (const artifact of ORT_ARTIFACTS) {
      const paths = ortWasmPaths(artifact);
      expect(paths.wasm).toMatch(/^\/ort\/ort-wasm-simd-threaded.*\.wasm$/);
      expect(paths.mjs).toMatch(/^\/ort\/ort-wasm-simd-threaded.*\.mjs$/);
    }
  });
});

describe('isOrtArtifact — type guard', () => {
  it.each(ORT_ARTIFACTS)('accepts %s', (value) => {
    expect(isOrtArtifact(value)).toBe(true);
  });

  it.each(['jsep', '', 'STANDARD', null, undefined, 3])('rejects %s', (value) => {
    expect(isOrtArtifact(value)).toBe(false);
  });
});

describe('clampThreads — clamp requested pool size to [1, max]', () => {
  it('passes through a value within range', () => {
    expect(clampThreads(4, 8)).toBe(4);
  });

  it('clamps above hardwareConcurrency down to max', () => {
    expect(clampThreads(32, 8)).toBe(8);
  });

  it('floors sub-1 and non-finite requests to 1', () => {
    expect(clampThreads(0, 8)).toBe(1);
    expect(clampThreads(-4, 8)).toBe(1);
    expect(clampThreads(Number.NaN, 8)).toBe(1);
  });

  it('truncates fractional requests', () => {
    expect(clampThreads(3.9, 8)).toBe(3);
  });

  it('treats a missing/invalid max as 1', () => {
    expect(clampThreads(4, 0)).toBe(1);
    expect(clampThreads(4, Number.NaN)).toBe(1);
  });
});
