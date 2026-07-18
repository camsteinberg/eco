// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetBootstrapForTesting,
  bootstrapLocalAi,
  resolveReconcileFilePlan,
} from '../bootstrap';
import {
  peekDownloadPlan,
  setDownloadPlanResolver,
} from '../download/download';
import { setWorkerFactory } from '../runtime/transformers-adapter';
import { setAdapterFactory } from '../runtime/lifecycle';
import { setSmokeGenerationFn } from '../lifecycle/smoke';

function resetAllSeams(): void {
  setDownloadPlanResolver(null);
  setWorkerFactory(null);
  setAdapterFactory(null);
  setSmokeGenerationFn(null);
  _resetBootstrapForTesting();
}

// MUST list every file in the qwen3-0.6b catalog artifact — the
// incomplete-manifest guard in fetchManifestPlan falls back to the
// heuristic plan if any catalog file is absent from the manifest. (The
// guard prevents silent download-plan truncation that would later fail
// the model load.) Sizes are synthetic test values; the bootstrap path
// trusts manifest sizeBytes by design.
const MANIFEST_RESPONSE = {
  modelId: 'local/qwen3-0.6b',
  hfId: 'econetworkai/Qwen3-0.6B-ONNX-external-data',
  revision: 'e059eaaf660ff62dbc8adcd1057488aa3ad0f5f9',
  files: [
    { path: 'onnx/model_q4f16.onnx', sizeBytes: 328_247, oid: 'sha-onnx' },
    { path: 'onnx/model_q4f16.onnx_data', sizeBytes: 569_493_504, oid: 'sha-onnx-data' },
    { path: 'added_tokens.json', sizeBytes: 1_024, oid: 'sha-added' },
    { path: 'chat_template.jinja', sizeBytes: 2_048, oid: 'sha-chat' },
    { path: 'config.json', sizeBytes: 1_234, oid: 'sha-config' },
    { path: 'generation_config.json', sizeBytes: 512, oid: 'sha-gen' },
    { path: 'merges.txt', sizeBytes: 4_096, oid: 'sha-merges' },
    { path: 'special_tokens_map.json', sizeBytes: 256, oid: 'sha-special' },
    { path: 'tokenizer.json', sizeBytes: 8_192, oid: 'sha-tokenizer' },
    { path: 'tokenizer_config.json', sizeBytes: 1_536, oid: 'sha-tcfg' },
    { path: 'vocab.json', sizeBytes: 3_072, oid: 'sha-vocab' },
  ],
};

function mockFetchManifest(response: Response): void {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);
}

describe('bootstrap manifest integration', () => {
  beforeEach(() => {
    resetAllSeams();
  });

  afterEach(() => {
    resetAllSeams();
    vi.restoreAllMocks();
  });

  it('uses manifest sizeBytes when the manifest endpoint returns valid JSON', async () => {
    mockFetchManifest(
      new Response(JSON.stringify(MANIFEST_RESPONSE), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await bootstrapLocalAi({ skipSelfHeal: true });

    const { getModel } = await import('../catalog/catalog');
    const model = getModel('local/qwen3-0.6b')!;
    expect(model).not.toBeNull();

    const plan = await peekDownloadPlan(model);
    expect(plan).not.toBeNull();
    expect(plan!.modelId).toBe('local/qwen3-0.6b');

    // The plan should use the manifest's exact sizeBytes. endsWith (not
    // includes) so the small graph file is selected, not its .onnx_data sibling.
    const onnxFile = plan!.files.find((f) => f.url.endsWith('model_q4f16.onnx'));
    expect(onnxFile).toBeDefined();
    expect(onnxFile!.sizeBytes).toBe(328_247);

    const onnxDataFile = plan!.files.find((f) => f.url.endsWith('model_q4f16.onnx_data'));
    expect(onnxDataFile).toBeDefined();
    expect(onnxDataFile!.sizeBytes).toBe(569_493_504);

    const configFile = plan!.files.find((f) => f.url.includes('config.json'));
    expect(configFile).toBeDefined();
    expect(configFile!.sizeBytes).toBe(1_234);
  });

  it('falls back to heuristic sizes when the manifest returns 404', async () => {
    mockFetchManifest(
      new Response(JSON.stringify({ error: 'model_not_in_catalog' }), {
        status: 404,
      }),
    );

    await bootstrapLocalAi({ skipSelfHeal: true });

    const { getModel } = await import('../catalog/catalog');
    const model = getModel('local/qwen3-0.6b')!;
    const plan = await peekDownloadPlan(model);
    expect(plan).not.toBeNull();
    expect(plan!.modelId).toBe('local/qwen3-0.6b');

    // Heuristic sizes are estimates — they won't match the manifest's exact bytes.
    // The key assertion is that the plan is still produced (no crash).
    expect(plan!.files.length).toBeGreaterThan(0);
    for (const file of plan!.files) {
      expect(file.sizeBytes).toBeGreaterThan(0);
      expect(file.url).toContain('/api/local-models/');
    }
  });

  it('falls back to heuristic sizes when fetch throws a network error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await bootstrapLocalAi({ skipSelfHeal: true });

    const { getModel } = await import('../catalog/catalog');
    const model = getModel('local/qwen3-0.6b')!;
    const plan = await peekDownloadPlan(model);
    expect(plan).not.toBeNull();
    expect(plan!.files.length).toBeGreaterThan(0);

    // Should have logged a warning.
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('manifest fetch failed'),
    );

    warnSpy.mockRestore();
  });

  it('falls back to heuristic sizes when the manifest response has malformed JSON', async () => {
    mockFetchManifest(new Response('not json', { status: 200 }));

    await bootstrapLocalAi({ skipSelfHeal: true });

    const { getModel } = await import('../catalog/catalog');
    const model = getModel('local/qwen3-0.6b')!;
    const plan = await peekDownloadPlan(model);
    expect(plan).not.toBeNull();
    expect(plan!.files.length).toBeGreaterThan(0);
  });

  it('falls back when manifest response is missing required fields', async () => {
    mockFetchManifest(
      new Response(JSON.stringify({ modelId: 'local/qwen3-0.6b' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await bootstrapLocalAi({ skipSelfHeal: true });

    const { getModel } = await import('../catalog/catalog');
    const model = getModel('local/qwen3-0.6b')!;
    const plan = await peekDownloadPlan(model);
    expect(plan).not.toBeNull();
    expect(plan!.files.length).toBeGreaterThan(0);
  });

  it('fetches the manifest URL using the catalog model id as a path with cache + abort signal', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(MANIFEST_RESPONSE), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await bootstrapLocalAi({ skipSelfHeal: true });

    const { getModel } = await import('../catalog/catalog');
    const model = getModel('local/qwen3-0.6b')!;
    await peekDownloadPlan(model);

    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0]!;
    expect(url).toBe('/api/local-models/manifest/local/qwen3-0.6b');
    expect((init as RequestInit).cache).toBe('force-cache');
    // AbortSignal.timeout(3000) is opaque from the outside; the signal
    // object should be present and not yet aborted at call time.
    const signal = (init as RequestInit).signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal!.aborted).toBe(false);
  });

  it('flags every heuristic-fallback file as an estimate size (never an integrity criterion)', async () => {
    mockFetchManifest(
      new Response(JSON.stringify({ error: 'model_not_in_catalog' }), { status: 404 }),
    );

    await bootstrapLocalAi({ skipSelfHeal: true });

    const { getModel } = await import('../catalog/catalog');
    const model = getModel('local/qwen3-0.6b')!;
    const plan = await peekDownloadPlan(model);
    expect(plan!.files.length).toBeGreaterThan(0);
    for (const file of plan!.files) {
      expect(file.sizeIsEstimate).toBe(true);
    }
  });

  it('does NOT flag manifest-based plan files as estimates (reviewed sizes are exact)', async () => {
    mockFetchManifest(
      new Response(JSON.stringify(MANIFEST_RESPONSE), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await bootstrapLocalAi({ skipSelfHeal: true });

    const { getModel } = await import('../catalog/catalog');
    const model = getModel('local/qwen3-0.6b')!;
    const plan = await peekDownloadPlan(model);
    for (const file of plan!.files) {
      expect(file.sizeIsEstimate).toBeUndefined();
    }
  });

  it('retries once after a transient fetch failure and uses the manifest on the second attempt', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(
        new Response(JSON.stringify(MANIFEST_RESPONSE), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await bootstrapLocalAi({ skipSelfHeal: true });

    const { getModel } = await import('../catalog/catalog');
    const model = getModel('local/qwen3-0.6b')!;
    const plan = await peekDownloadPlan(model);

    expect(plan).not.toBeNull();
    // The second attempt succeeded → manifest-based (exact sizes, no estimate flags).
    const onnxData = plan!.files.find((f) => f.url.endsWith('model_q4f16.onnx_data'));
    expect(onnxData!.sizeBytes).toBe(569_493_504);
    for (const file of plan!.files) {
      expect(file.sizeIsEstimate).toBeUndefined();
    }
    // Both attempts were observed (first rejected, second resolved).
    expect(spy).toHaveBeenCalledTimes(2);

    warnSpy.mockRestore();
  });

  it('falls back to heuristic sizes when the manifest omits files present in the catalog artifact', async () => {
    // Manifest returns only ONE of the catalog's files. Without the
    // incomplete-manifest guard, the silent filter-out would produce a
    // plan that skips the missing catalog files entirely, and the model
    // would fail at load time. The fix is: if any catalog file is missing
    // from the manifest, treat as a fetch failure and fall back to the
    // heuristic plan (which lists every catalog file with an estimate).
    mockFetchManifest(
      new Response(JSON.stringify({
        modelId: 'local/qwen3-0.6b',
        hfId: 'econetworkai/Qwen3-0.6B-ONNX-external-data',
        revision: 'e059eaaf660ff62dbc8adcd1057488aa3ad0f5f9',
        files: [
          { path: 'config.json', sizeBytes: 1_234, oid: 'def456' },
        ],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await bootstrapLocalAi({ skipSelfHeal: true });

    const { getModel } = await import('../catalog/catalog');
    const model = getModel('local/qwen3-0.6b')!;
    const plan = await peekDownloadPlan(model);
    expect(plan).not.toBeNull();

    // Heuristic fallback lists EVERY catalog file (more than the 1 the
    // manifest returned), and each has a positive estimated size.
    expect(plan!.files.length).toBeGreaterThan(1);
    for (const file of plan!.files) {
      expect(file.sizeBytes).toBeGreaterThan(0);
    }

    // Should have logged the incomplete-manifest warning.
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('missing'),
    );

    warnSpy.mockRestore();
  });
});

describe('boot reconcile plan resolver (cache-wipe regression, 2026-06-11)', () => {
  beforeEach(() => {
    resetAllSeams();
  });

  afterEach(() => {
    resetAllSeams();
    vi.restoreAllMocks();
  });

  it('returns reviewed manifest sizes when the manifest is reachable', async () => {
    mockFetchManifest(
      new Response(JSON.stringify(MANIFEST_RESPONSE), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const files = await resolveReconcileFilePlan('local/qwen3-0.6b');
    expect(files).not.toBeNull();
    const onnxFile = files!.find((f) => f.url.endsWith('model_q4f16.onnx'));
    expect(onnxFile!.sizeBytes).toBe(328_247);
  });

  it('returns null — NOT heuristic sizes — when the manifest is unreachable', async () => {
    // The incident: reconcile verified a freshly-downloaded healthy cache
    // against heuristic ESTIMATES after a manifest timeout, declared every
    // file corrupt, deleted 1.4GB, and flipped the ready slot to
    // 'preparing'. Reconcile must skip verification entirely (null plan)
    // when reviewed sizes are unavailable.
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const files = await resolveReconcileFilePlan('local/qwen3-0.6b');
    expect(files).toBeNull();

    warnSpy.mockRestore();
  });

  it('returns null for non-catalog model ids', async () => {
    const files = await resolveReconcileFilePlan('local/not-a-model');
    expect(files).toBeNull();
  });
});
