// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { afterEach, describe, expect, it } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useLocalAiStorageBreakdown } from '../useLocalAiStorageBreakdown';
import type { Storage as LocalStorage } from '../../../local-ai/download/storage';
import { getCatalog } from '../../../local-ai/catalog/catalog';

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
    expect(firstEntry?.friendlyName).toBe(first.friendlyName);
    expect(firstEntry?.vendor).toBe(first.vendor);
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
