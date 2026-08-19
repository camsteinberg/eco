// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { afterEach, describe, expect, it } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useLocalAiStorageBreakdown } from '../useLocalAiStorageBreakdown';
import type { Storage as LocalStorage } from '../../../local-ai/download/storage';
import { getCatalog } from '../../../local-ai/catalog/catalog';
import { getDisplayInfo } from '../../../local-ai/display';

class FakeStorage implements LocalStorage {
  readonly backend = 'cache-api' as const;
  // modelId → { url → sizeBytes }
  private readonly perModel = new Map<string, Map<string, number>>();

  setBytes(modelId: string, url: string, sizeBytes: number): void {
    let inner = this.perModel.get(modelId);
    if (!inner) {
      inner = new Map();
      this.perModel.set(modelId, inner);
    }
    inner.set(url, sizeBytes);
  }

  failModel(modelId: string): void {
    this.perModel.set(modelId, MAP_THAT_THROWS);
  }

  async put(): Promise<void> { /* not used */ }
  async get() { return null; }
  async has() { return false; }
  async verify() { return false; }
  async remove(): Promise<void> { /* not used */ }
  async listForModel(modelId: string): Promise<{ url: string; sizeBytes: number | null }[]> {
    const inner = this.perModel.get(modelId);
    if (!inner) return [];
    if (inner === MAP_THAT_THROWS) throw new Error('boom');
    return Array.from(inner.entries()).map(([url, sizeBytes]) => ({ url, sizeBytes }));
  }
  async clearModel(modelId: string): Promise<void> { this.perModel.delete(modelId); }
}

// Sentinel to force listForModel to throw — covers the per-model error path.
const MAP_THAT_THROWS = new Map<string, number>();

afterEach(() => {
  // No global mocks to restore; FakeStorage is local.
});

describe('useLocalAiStorageBreakdown', () => {
  it('sums bytes across files per model and computes ecoTotalBytes', async () => {
    const storage = new FakeStorage();
    const [first, second] = getCatalog();
    if (!first || !second) throw new Error('catalog too small');
    storage.setBytes(first.id, 'a.bin', 100);
    storage.setBytes(first.id, 'b.bin', 250);
    storage.setBytes(second.id, 'c.bin', 700);

    const { result } = renderHook(() =>
      useLocalAiStorageBreakdown({
        storage,
        estimateBrowserStorage: async () => ({ usage: 5000, quota: 100_000 }),
      }),
    );

    await waitFor(() => expect(result.current.status).toBe('ready'));
    const data = result.current.data!;
    expect(data.ecoTotalBytes).toBe(1050);
    expect(data.browserUsage).toBe(5000);
    expect(data.browserQuota).toBe(100_000);
    expect(data.models).toHaveLength(2);
    const firstEntry = data.models.find((m) => m.id === first.id);
    expect(firstEntry?.sizeBytes).toBe(350);
    expect(firstEntry?.friendlyName).toBe(getDisplayInfo(first.id, first).friendlyName);
    expect(firstEntry?.vendor).toBe(first.vendor);
  });

  // The storage cards are primary UI, so they must name models the way the
  // rest of the product does. Reading model.friendlyName straight off the
  // catalog printed raw names ("SmolLM2 360M") on those cards.
  it('names models with their branded display name, not the raw catalog name', async () => {
    const storage = new FakeStorage();
    const smol = getCatalog().find((m) => m.id === 'candidate/smollm2-360m-instruct-onnx');
    if (!smol) throw new Error('catalog missing the SmolLM2 CPU floor model');
    expect(smol.friendlyName).toBe('SmolLM2 360M');
    storage.setBytes(smol.id, 'model_int8.onnx', 361_000_000);

    const { result } = renderHook(() =>
      useLocalAiStorageBreakdown({
        storage,
        estimateBrowserStorage: async () => null,
      }),
    );

    await waitFor(() => expect(result.current.status).toBe('ready'));
    const entry = result.current.data!.models.find((m) => m.id === smol.id);
    expect(entry?.friendlyName).toBe('Eco Tiny (SmolLM)');
  });

  it('filters out models with zero cached bytes', async () => {
    const storage = new FakeStorage();
    const [first] = getCatalog();
    if (!first) throw new Error('catalog too small');
    storage.setBytes(first.id, 'a.bin', 0);

    const { result } = renderHook(() =>
      useLocalAiStorageBreakdown({
        storage,
        estimateBrowserStorage: async () => ({ usage: 0, quota: 100 }),
      }),
    );

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.data?.models).toEqual([]);
    expect(result.current.data?.ecoTotalBytes).toBe(0);
  });

  it('treats null file sizeBytes as zero contribution', async () => {
    const storage = new FakeStorage();
    const [first] = getCatalog();
    if (!first) throw new Error('catalog too small');
    storage.setBytes(first.id, 'b.bin', 500);
    // Simulate a file with unknown size by using nullable shape via listForModel override
    storage.setBytes(first.id, 'null-size.bin', 0);

    const { result } = renderHook(() =>
      useLocalAiStorageBreakdown({
        storage,
        estimateBrowserStorage: async () => null,
      }),
    );

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.data?.ecoTotalBytes).toBe(500);
  });

  it('returns null browser totals when estimate is unavailable', async () => {
    const storage = new FakeStorage();
    const { result } = renderHook(() =>
      useLocalAiStorageBreakdown({
        storage,
        estimateBrowserStorage: async () => null,
      }),
    );

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.data?.browserUsage).toBeNull();
    expect(result.current.data?.browserQuota).toBeNull();
  });

  it('one failing model does not mask others', async () => {
    const storage = new FakeStorage();
    const [first, second] = getCatalog();
    if (!first || !second) throw new Error('catalog too small');
    storage.failModel(first.id);
    storage.setBytes(second.id, 'b.bin', 800);

    const { result } = renderHook(() =>
      useLocalAiStorageBreakdown({
        storage,
        estimateBrowserStorage: async () => ({ usage: 0, quota: 100 }),
      }),
    );

    await waitFor(() => expect(result.current.status).toBe('ready'));
    const data = result.current.data!;
    expect(data.models.find((m) => m.id === first.id)).toBeUndefined();
    expect(data.models.find((m) => m.id === second.id)?.sizeBytes).toBe(800);
  });

  it('refresh() triggers a recompute', async () => {
    const storage = new FakeStorage();
    const [first] = getCatalog();
    if (!first) throw new Error('catalog too small');
    storage.setBytes(first.id, 'a.bin', 200);

    const { result } = renderHook(() =>
      useLocalAiStorageBreakdown({
        storage,
        estimateBrowserStorage: async () => ({ usage: 0, quota: 100 }),
      }),
    );

    await waitFor(() => expect(result.current.data?.ecoTotalBytes).toBe(200));

    storage.setBytes(first.id, 'b.bin', 50);
    act(() => result.current.refresh());

    await waitFor(() => expect(result.current.data?.ecoTotalBytes).toBe(250));
  });

  it('reacts to refreshKey changes', async () => {
    const storage = new FakeStorage();
    const [first] = getCatalog();
    if (!first) throw new Error('catalog too small');
    storage.setBytes(first.id, 'a.bin', 100);

    const { result, rerender } = renderHook(
      ({ key }: { key: number }) =>
        useLocalAiStorageBreakdown({
          storage,
          estimateBrowserStorage: async () => ({ usage: 0, quota: 100 }),
          refreshKey: key,
        }),
      { initialProps: { key: 1 } },
    );

    await waitFor(() => expect(result.current.data?.ecoTotalBytes).toBe(100));

    storage.setBytes(first.id, 'b.bin', 400);
    rerender({ key: 2 });

    await waitFor(() => expect(result.current.data?.ecoTotalBytes).toBe(500));
  });
});

// A completed chunked file is BOTH a manifest at the identity key (stamped with
// the aggregate size) and every chunk part as its own entry — summing all
// entries counts the file twice (verified live 2026-08-05: "Eco models use
// 2.6 GB, browser total 1.6 GB" in one sentence).
describe('useLocalAiStorageBreakdown — parts-native accounting', () => {
  it('counts a completed chunked file once, not manifest + parts', async () => {
    const storage = new FakeStorage();
    const [first] = getCatalog();
    if (!first) throw new Error('catalog too small');
    const base = 'https://eco-model.cache/weights.onnx';
    storage.setBytes(first.id, base, 1400);
    storage.setBytes(first.id, `${base}.ecopart.s1400.0`, 700);
    storage.setBytes(first.id, `${base}.ecopart.s1400.700`, 700);

    const { result } = renderHook(() =>
      useLocalAiStorageBreakdown({
        storage,
        estimateBrowserStorage: async () => null,
      }),
    );

    await waitFor(() => expect(result.current.status).toBe('ready'));
    const entry = result.current.data!.models.find((m) => m.id === first.id);
    expect(entry?.sizeBytes).toBe(1400);
    expect(result.current.data!.ecoTotalBytes).toBe(1400);
  });

  it('still counts orphan parts mid-download (no identity entry yet)', async () => {
    const storage = new FakeStorage();
    const [first] = getCatalog();
    if (!first) throw new Error('catalog too small');
    const base = 'https://eco-model.cache/weights.onnx';
    storage.setBytes(first.id, `${base}.ecopart.s1400.0`, 700);
    storage.setBytes(first.id, `${base}.ecopart.s1400.700`, 300);

    const { result } = renderHook(() =>
      useLocalAiStorageBreakdown({
        storage,
        estimateBrowserStorage: async () => null,
      }),
    );

    await waitFor(() => expect(result.current.status).toBe('ready'));
    const entry = result.current.data!.models.find((m) => m.id === first.id);
    expect(entry?.sizeBytes).toBe(1000);
  });
});

// A webllm model's weights live in WebLLM's own cache namespaces — its Eco
// namespace is deliberately emptied after staging, so an Eco-only sweep reads
// "nothing cached" while hundreds of MB sit on disk (the live 2026-08-05
// "nothing cached with 1.6GB on disk" story).
describe('useLocalAiStorageBreakdown — webllm lane', () => {
  it('includes bytes measured from the WebLLM cache for webllm-runtime models', async () => {
    const storage = new FakeStorage();
    const webllmModel = getCatalog().find((m) => m.runtime === 'webllm');
    if (!webllmModel) throw new Error('no webllm model in catalog');

    const { result } = renderHook(() =>
      useLocalAiStorageBreakdown({
        storage,
        estimateBrowserStorage: async () => null,
        measureWebllmModel: async (model) =>
          model.id === webllmModel.id ? 289_000_000 : null,
      }),
    );

    await waitFor(() => expect(result.current.status).toBe('ready'));
    const entry = result.current.data!.models.find((m) => m.id === webllmModel.id);
    expect(entry?.sizeBytes).toBe(289_000_000);
    expect(result.current.data!.ecoTotalBytes).toBe(289_000_000);
  });
});

describe('useLocalAiStorageBreakdown — unmeasurable storage', () => {
  it('reports measured: false when no cache backend is available', async () => {
    const { result } = renderHook(() =>
      useLocalAiStorageBreakdown({
        estimateBrowserStorage: async () => ({ usage: 1_600_000_000, quota: 12_000_000_000 }),
      }),
    );

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.data!.measured).toBe(false);
    expect(result.current.data!.models).toEqual([]);
  });

  it('reports measured: true when a backend answered', async () => {
    const storage = new FakeStorage();
    const { result } = renderHook(() =>
      useLocalAiStorageBreakdown({
        storage,
        estimateBrowserStorage: async () => null,
      }),
    );

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.data!.measured).toBe(true);
  });
});
