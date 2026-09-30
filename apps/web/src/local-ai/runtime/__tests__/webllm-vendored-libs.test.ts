// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Every WebLLM entry's `quirks.webllmModelLibFile` must name a model library
 * that is actually vendored under `public/webllm/<WEBLLM_MODEL_LIB_VERSION>/`.
 *
 * The engine only fetches the library after the full weight download, so a
 * catalog entry pointing at a missing file fails late and with a cryptic MLC
 * error. The path is resolved through the real `webllmModelLibPathFor`, so a
 * change to the resolver or the version dir is covered too. Both lanes are
 * checked: an eval-lane entry with a dangling library is just as broken.
 */

import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ModelConfig } from '../../types';
import { getCatalog, getEvalLaneModels } from '../../catalog/catalog';
import catalogData from '../../catalog/catalog-data.json';
import { webllmModelLibPathFor } from '../webllm-config';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'public');

/** Every WebAssembly binary starts with these four bytes (`\0asm`). */
const WASM_MAGIC = [0x00, 0x61, 0x73, 0x6d];

const webllmModels = [...getCatalog(), ...getEvalLaneModels()].filter(
  (m) => m.runtime === 'webllm',
);

function readHead(path: string, length: number): number[] {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, 0);
    return [...buf];
  } finally {
    closeSync(fd);
  }
}

describe('vendored WebLLM model libraries', () => {
  it('covers every webllm entry in catalog-data.json (non-vacuous)', () => {
    const raw = catalogData.models as readonly { id: string; runtime: string }[];
    const rawIds = raw.filter((m) => m.runtime === 'webllm').map((m) => m.id);
    expect(rawIds.length).toBeGreaterThan(0);
    expect(webllmModels.map((m) => m.id).sort()).toEqual([...rawIds].sort());
  });

  it.each(webllmModels.map((m): [string, ModelConfig] => [m.id, m]))(
    '%s names a library that exists as a wasm file',
    (id, model) => {
      const libPath = join(PUBLIC_DIR, webllmModelLibPathFor(model));
      expect(existsSync(libPath), `${id}: quirks.webllmModelLibFile is not vendored at ${libPath}`)
        .toBe(true);
      expect(statSync(libPath).isFile(), `${id}: ${libPath} is not a file`).toBe(true);
      expect(readHead(libPath, WASM_MAGIC.length), `${id}: ${libPath} is not wasm`).toEqual(
        WASM_MAGIC,
      );
    },
  );
});
