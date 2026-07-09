// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, expect, it } from 'vitest';
import { runDownloadSelfTest } from '../self-test';

const URL = '/api/local-models/vendor/model/resolve/abc/weights.bin';

/** A 206 range response carrying `size` bytes and a content-range total. */
function okChunk(size: number, start: number, end: number, total: number): Response {
  return new Response(new Uint8Array(size), {
    status: 206,
    headers: { 'content-range': `bytes ${start}-${end}/${total}` },
  });
}

/** A body that streams `nBytes` then errors mid-stream (Cam's failure mode). */
function bodyErrorsMidStream(nBytes: number, start: number, end: number, total: number): Response {
  let sent = false;
  const stream = new ReadableStream<Uint8Array>({
    // pull() delivers the bytes on the first read, then errors on the next —
    // so the reader observes progressive bytes before the failure (a real
    // mid-stream drop), not a stream that errors before delivering anything.
    pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(new Uint8Array(nBytes));
      } else {
        controller.error(new TypeError('Failed to fetch'));
      }
    },
  });
  return new Response(stream, {
    status: 206,
    headers: { 'content-range': `bytes ${start}-${end}/${total}` },
  });
}

/** Scripted clock: returns each value in order (start,end per chunk). */
function scriptedNow(values: number[]): () => number {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)] ?? 0;
}

function rangeHeader(init?: RequestInit): string {
  return (init?.headers as Record<string, string | undefined>).Range ?? '';
}

function rangeStart(init?: RequestInit): number {
  const match = /bytes=(\d+)-/.exec(rangeHeader(init));
  return match ? Number(match[1]) : 0;
}

describe('runDownloadSelfTest', () => {
  it('reports one result per chunk with status, content-range, bytes, and total', async () => {
    const CHUNK = 1024;
    const TOTAL = 4096;
    const calls: string[] = [];
    const fetcher = (async (_url: string, init?: RequestInit) => {
      calls.push(rangeHeader(init));
      const start = rangeStart(init);
      return okChunk(CHUNK, start, start + CHUNK - 1, TOTAL);
    }) as unknown as typeof fetch;

    const result = await runDownloadSelfTest({
      url: URL,
      chunkBytes: CHUNK,
      chunks: 3,
      fetcher,
      now: scriptedNow([0, 1, 1, 2, 2, 3]),
    });

    expect(result.chunks).toHaveLength(3);
    expect(calls).toEqual(['bytes=0-1023', 'bytes=1024-2047', 'bytes=2048-3071']);
    expect(result.chunks[0]).toMatchObject({ chunkIndex: 0, status: 206, bytesRead: CHUNK });
    expect(result.chunks[0]!.contentRange).toBe(`bytes 0-1023/${TOTAL}`);
    expect(result.totalBytes).toBe(TOTAL);
    expect(result.verdict.kind).toBe('ok');
  });

  it('sends the real download request shape (octet-stream + Range)', async () => {
    let seenAccept: string | undefined;
    const fetcher = (async (_url: string, init?: RequestInit) => {
      const h = init?.headers as Record<string, string>;
      seenAccept = h.Accept;
      return okChunk(1024, 0, 1023, 1024);
    }) as unknown as typeof fetch;

    await runDownloadSelfTest({ url: URL, chunkBytes: 1024, chunks: 1, fetcher });
    expect(seenAccept).toBe('application/octet-stream');
  });

  it('verdict fast-fail when a chunk network-errors almost immediately', async () => {
    const fetcher = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;

    const result = await runDownloadSelfTest({
      url: URL,
      chunkBytes: 1024,
      chunks: 3,
      fetcher,
      now: scriptedNow([0, 200]),
    });

    // Stops after the first errored chunk — no point hammering a dead link.
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]!.error).toContain('Failed to fetch');
    expect(result.chunks[0]!.errorName).toBe('TypeError');
    expect(result.verdict.kind).toBe('fast-fail');
  });

  it('captures partial bytes and errors on a mid-stream body failure', async () => {
    const fetcher = (async () => bodyErrorsMidStream(512, 0, 1023, 1024)) as unknown as typeof fetch;

    const result = await runDownloadSelfTest({
      url: URL,
      chunkBytes: 1024,
      chunks: 2,
      fetcher,
      now: scriptedNow([0, 300]),
    });

    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]!.bytesRead).toBe(512);
    expect(result.chunks[0]!.error).toBeDefined();
    expect(result.verdict.kind).toBe('fast-fail');
  });

  it('verdict http-error when the server returns a non-2xx status', async () => {
    const fetcher = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;

    const result = await runDownloadSelfTest({ url: URL, chunkBytes: 1024, chunks: 3, fetcher });

    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]!.status).toBe(500);
    expect(result.verdict.kind).toBe('http-error');
  });

  it('verdict slow when a chunk fails only after a long wait', async () => {
    const fetcher = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;

    const result = await runDownloadSelfTest({
      url: URL,
      chunkBytes: 1024,
      chunks: 3,
      fetcher,
      now: scriptedNow([0, 30_000]),
    });

    expect(result.verdict.kind).toBe('slow');
  });

  it('verdict slow when all chunks succeed but each is very slow', async () => {
    const fetcher = (async (_url: string, init?: RequestInit) => {
      const start = rangeStart(init);
      return okChunk(1024, start, start + 1023, 4096);
    }) as unknown as typeof fetch;

    // Each chunk takes 90s → far below a usable download rate.
    const result = await runDownloadSelfTest({
      url: URL,
      chunkBytes: 1024,
      chunks: 2,
      fetcher,
      now: scriptedNow([0, 90_000, 90_000, 180_000]),
    });

    expect(result.chunks).toHaveLength(2);
    expect(result.verdict.kind).toBe('slow');
  });

  it('does not fetch when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    let fetched = false;
    const fetcher = (async () => {
      fetched = true;
      return okChunk(1024, 0, 1023, 1024);
    }) as unknown as typeof fetch;

    const result = await runDownloadSelfTest({
      url: URL,
      chunkBytes: 1024,
      chunks: 3,
      fetcher,
      signal: controller.signal,
    });

    expect(fetched).toBe(false);
    expect(result.chunks).toHaveLength(0);
  });
});
