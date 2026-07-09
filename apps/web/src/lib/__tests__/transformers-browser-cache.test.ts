// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type FakeFile = Uint8Array & {
  size: number;
  text: () => Promise<string>;
};

function makeFakeFile(chunks: BlobPart[]): FakeFile {
  const encodedChunks = chunks.map((chunk) => {
    if (typeof chunk === 'string') {
      return new TextEncoder().encode(chunk);
    }
    if (ArrayBuffer.isView(chunk)) {
      return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    }
    if (chunk instanceof ArrayBuffer) {
      return new Uint8Array(chunk);
    }
    throw new TypeError('Unsupported fake OPFS chunk');
  });
  const size = encodedChunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const bytes = new Uint8Array(size) as FakeFile;
  let offset = 0;
  for (const chunk of encodedChunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  Object.defineProperty(bytes, 'size', { value: size });
  Object.defineProperty(bytes, 'text', {
    value: async () => new TextDecoder().decode(bytes),
  });
  return bytes;
}

class FakeFileHandle {
  constructor(
    private readonly files: Map<string, FakeFile>,
    private readonly name: string,
  ) {}

  async getFile(): Promise<FakeFile> {
    const file = this.files.get(this.name);
    if (!file) {
      throw new DOMException('File not found', 'NotFoundError');
    }
    return file;
  }

  async createWritable(): Promise<{
    write: (chunk: BlobPart) => Promise<void>;
    close: () => Promise<void>;
    abort: () => Promise<void>;
  }> {
    const chunks: BlobPart[] = [];
    return {
      write: async (chunk) => {
        chunks.push(chunk);
      },
      close: async () => {
        this.files.set(this.name, makeFakeFile(chunks));
      },
      abort: async () => {
        chunks.length = 0;
      },
    };
  }
}

class FakeDirectoryHandle {
  readonly kind = 'directory';
  readonly files = new Map<string, FakeFile>();
  readonly directories = new Map<string, FakeDirectoryHandle>();

  async getDirectoryHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<FakeDirectoryHandle> {
    const existing = this.directories.get(name);
    if (existing) return existing;
    if (!options?.create) {
      throw new DOMException('Directory not found', 'NotFoundError');
    }
    const directory = new FakeDirectoryHandle();
    this.directories.set(name, directory);
    return directory;
  }

  async getFileHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<FakeFileHandle> {
    if (!this.files.has(name) && !options?.create) {
      throw new DOMException('File not found', 'NotFoundError');
    }
    return new FakeFileHandle(this.files, name);
  }

  async removeEntry(name: string): Promise<void> {
    if (!this.files.delete(name)) {
      throw new DOMException('File not found', 'NotFoundError');
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterableIterator<[string, { kind: 'file' }]> {
    for (const name of this.files.keys()) {
      yield [name, { kind: 'file' }];
    }
  }
}

describe('transformers-browser-cache', () => {
  let root: FakeDirectoryHandle;
  let originalStorage: StorageManager | undefined;

  beforeEach(() => {
    vi.resetModules();
    root = new FakeDirectoryHandle();
    originalStorage = navigator.storage;
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: {
        getDirectory: vi.fn(async () => root),
      },
    });
  });

  afterEach(() => {
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: originalStorage,
    });
    vi.restoreAllMocks();
  });

  it('stores, lists, matches, and deletes OPFS entries with actual byte-size metadata', async () => {
    const {
      createTransformersBrowserCache,
      listTransformersCachedRequests,
    } = await import('../transformers-browser-cache');
    const requestUrl = 'https://example.test/models/eco-fast/onnx/model.onnx';
    const cache = createTransformersBrowserCache();
    const progress: Array<{ loaded: number; total: number }> = [];

    expect(cache).not.toBeNull();
    await cache!.put(
      requestUrl,
      new Response(new Uint8Array([1, 2, 3]), {
        headers: { 'content-length': '3', 'content-type': 'application/octet-stream' },
        status: 201,
        statusText: 'Created',
      }),
      (event) => progress.push({ loaded: event.loaded, total: event.total }),
    );

    await expect(listTransformersCachedRequests()).resolves.toEqual([requestUrl]);
    const matched = await cache!.match(requestUrl);
    expect(matched?.status).toBe(201);
    expect(matched?.headers.get('content-type')).toBe('application/octet-stream');
    expect(matched?.headers.get('x-eco-cache-size-bytes')).toBe('3');
    expect(new Uint8Array(await matched!.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(progress.at(-1)).toEqual({ loaded: 3, total: 3 });

    await expect(cache!.delete?.(requestUrl)).resolves.toBe(true);
    await expect(cache!.match(requestUrl)).resolves.toBeUndefined();
    await expect(listTransformersCachedRequests()).resolves.toEqual([]);
  });

  it('does not match an OPFS data file when its metadata is missing or corrupt', async () => {
    const { createTransformersBrowserCache } = await import('../transformers-browser-cache');
    const requestUrl = 'https://example.test/models/eco-fast/config.json';
    const cache = createTransformersBrowserCache();

    await cache!.put(
      requestUrl,
      new Response(JSON.stringify({ ok: true }), {
        headers: { 'content-type': 'application/json' },
        status: 200,
      }),
    );

    const cacheDirectory = root.directories.get('eco-transformers-cache')!;
    const metadataName = [...cacheDirectory.files.keys()]
      .find((name) => name.endsWith('.json'))!;
    cacheDirectory.files.set(metadataName, makeFakeFile(['not-json']));

    await expect(cache!.match(requestUrl)).resolves.toBeUndefined();
  });
});
