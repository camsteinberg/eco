// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT } from "./route";

const QWEN_REVIEWED_REVISION = "da1453100cf3ff33ef56d17983fc7a8648706db6";
const LFM25_350M_REVIEWED_REVISION = "2c07371c2e84776cad597f3d813b7d306d292aea";

describe("GET /api/local-models/[...slug]", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("proxies a model file request to Hugging Face", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response("x", {
          status: 206,
          headers: {
            "accept-ranges": "bytes",
            "content-range": "bytes 0-0/1",
            "content-type": "application/octet-stream",
            etag: '"proxy-test"',
          },
        }),
      );

    const request = {
      headers: new Headers({
        range: "bytes=0-0",
      }),
      nextUrl: new URL(
        `http://127.0.0.1:3000/api/local-models/onnx-community/Qwen3-0.6B-ONNX/resolve/${QWEN_REVIEWED_REVISION}/onnx/model_q4f16.onnx`,
      ),
    } as NextRequest;

    const response = await GET(request, {
      params: Promise.resolve({
        slug: [
          "onnx-community",
          "Qwen3-0.6B-ONNX",
          "resolve",
          QWEN_REVIEWED_REVISION,
          "onnx",
          "model_q4f16.onnx",
        ],
      }),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      `https://huggingface.co/onnx-community/Qwen3-0.6B-ONNX/resolve/${QWEN_REVIEWED_REVISION}/onnx/model_q4f16.onnx`,
    );
    expect(init?.method).toBe("GET");
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 0-0/1");
    expect(await response.text()).toBe("x");
  });

  it("forwards only safe range/cache request headers and strips query strings", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("x", { status: 200 }));

    const request = {
      headers: {
        get: (name: string) =>
          ({
            accept: "application/octet-stream",
            authorization: "Bearer user-token",
            cookie: "session=secret",
            range: "bytes=0-10",
            "x-forwarded-for": "203.0.113.10",
          })[name.toLowerCase()] ?? null,
      },
      nextUrl: new URL(
        `http://127.0.0.1:3000/api/local-models/onnx-community/Qwen3-0.6B-ONNX/resolve/${QWEN_REVIEWED_REVISION}/onnx/model_q4f16.onnx?download=1&token=secret`,
      ),
    } as NextRequest;

    await GET(request, {
      params: Promise.resolve({
        slug: [
          "onnx-community",
          "Qwen3-0.6B-ONNX",
          "resolve",
          QWEN_REVIEWED_REVISION,
          "onnx",
          "model_q4f16.onnx",
        ],
      }),
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      `https://huggingface.co/onnx-community/Qwen3-0.6B-ONNX/resolve/${QWEN_REVIEWED_REVISION}/onnx/model_q4f16.onnx`,
    );
    const headers = init?.headers as Record<string, string>;
    expect(headers.accept).toBe("application/octet-stream");
    expect(headers.range).toBe("bytes=0-10");
    expect(headers.authorization).toBeUndefined();
    expect(headers.cookie).toBeUndefined();
    expect(headers["x-forwarded-for"]).toBeUndefined();
  });

  it("forwards only safe cache/range response headers", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("x", {
        status: 200,
        headers: {
          "cache-control": "public, max-age=60",
          "content-type": "application/octet-stream",
          "set-cookie": "hf_session=secret",
          "x-powered-by": "upstream",
        },
      }),
    );

    const request = {
      headers: new Headers(),
      nextUrl: new URL(
        `http://127.0.0.1:3000/api/local-models/onnx-community/Qwen3-0.6B-ONNX/resolve/${QWEN_REVIEWED_REVISION}/config.json`,
      ),
    } as NextRequest;

    const response = await GET(request, {
      params: Promise.resolve({
        slug: [
          "onnx-community",
          "Qwen3-0.6B-ONNX",
          "resolve",
          QWEN_REVIEWED_REVISION,
          "config.json",
        ],
      }),
    });

    expect(response.headers.get("cache-control")).toBe("public, max-age=60");
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("x-powered-by")).toBeNull();
  });

  it("returns a controlled denial when reviewed upstream hosting cannot be reached", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("network down"));

    const request = {
      headers: new Headers(),
      nextUrl: new URL(
        `http://127.0.0.1:3000/api/local-models/onnx-community/Qwen3-0.6B-ONNX/resolve/${QWEN_REVIEWED_REVISION}/config.json`,
      ),
    } as NextRequest;

    const response = await GET(request, {
      params: Promise.resolve({
        slug: [
          "onnx-community",
          "Qwen3-0.6B-ONNX",
          "resolve",
          QWEN_REVIEWED_REVISION,
          "config.json",
        ],
      }),
    });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: "model_asset_unavailable",
    });
  });

  it("supports HEAD metadata checks without downloading the full file body", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(null, {
          status: 200,
          headers: {
            "content-type": "application/octet-stream",
            "content-length": "123",
          },
        }),
      );

    const request = {
      headers: new Headers(),
      nextUrl: new URL(
        `http://127.0.0.1:3000/api/local-models/onnx-community/Qwen3-0.6B-ONNX/resolve/${QWEN_REVIEWED_REVISION}/config.json`,
      ),
    } as NextRequest;

    const response = await HEAD(request, {
      params: Promise.resolve({
        slug: [
          "onnx-community",
          "Qwen3-0.6B-ONNX",
          "resolve",
          QWEN_REVIEWED_REVISION,
          "config.json",
        ],
      }),
    });

    expect(fetchMock).toHaveBeenCalledWith(
      `https://huggingface.co/onnx-community/Qwen3-0.6B-ONNX/resolve/${QWEN_REVIEWED_REVISION}/config.json`,
      expect.objectContaining({
        method: "HEAD",
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe("123");
  });

  it("stamps reviewed artifact identity headers from the Eco manifest", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("x", {
        status: 200,
        headers: {
          "content-type": "application/octet-stream",
        },
      }),
    );

    const request = {
      headers: new Headers(),
      nextUrl: new URL(
        `http://127.0.0.1:3000/api/local-models/onnx-community/Qwen3-0.6B-ONNX/resolve/${QWEN_REVIEWED_REVISION}/onnx/model_q4f16.onnx`,
      ),
    } as NextRequest;

    const response = await GET(request, {
      params: Promise.resolve({
        slug: [
          "onnx-community",
          "Qwen3-0.6B-ONNX",
          "resolve",
          QWEN_REVIEWED_REVISION,
          "onnx",
          "model_q4f16.onnx",
        ],
      }),
    });

    expect(response.headers.get("x-eco-reviewed-size-bytes")).toBe("569789750");
    expect(response.headers.get("x-eco-reviewed-oid")).toBe(
      "9e33a5911974174761d0dfdcc0bec975d9c45af0eae5e9eb647b8ba9442a8f91",
    );
    expect(response.headers.get("x-eco-reviewed-oid-kind")).toBe("lfs-sha256");
  });

  it("shapes binary artifact delivery as an explicit file download (env-block experiment)", async () => {
    // Some real-world environments (AV / security middleboxes — the founder's
    // Windows box) kill long anonymous binary streams. Declaring the payload
    // explicitly (normalized octet-stream type + attachment disposition +
    // nosniff) is the cheap server-side experiment from the instant-start
    // plan: it costs nothing client-side (fetch() ignores disposition) and
    // may stop content-sniffing middleware from buffer-scanning 2 GB bodies.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("x", {
        status: 200,
        headers: {
          "content-type": "binary/octet-stream",
        },
      }),
    );

    const request = {
      headers: new Headers(),
      nextUrl: new URL(
        `http://127.0.0.1:3000/api/local-models/onnx-community/Qwen3-0.6B-ONNX/resolve/${QWEN_REVIEWED_REVISION}/onnx/model_q4f16.onnx`,
      ),
    } as NextRequest;

    const response = await GET(request, {
      params: Promise.resolve({
        slug: [
          "onnx-community",
          "Qwen3-0.6B-ONNX",
          "resolve",
          QWEN_REVIEWED_REVISION,
          "onnx",
          "model_q4f16.onnx",
        ],
      }),
    });

    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="model_q4f16.onnx"',
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("leaves JSON asset content-type untouched (Transformers.js reads configs through the proxy)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      }),
    );

    const request = {
      headers: new Headers(),
      nextUrl: new URL(
        `http://127.0.0.1:3000/api/local-models/onnx-community/Qwen3-0.6B-ONNX/resolve/${QWEN_REVIEWED_REVISION}/config.json`,
      ),
    } as NextRequest;

    const response = await GET(request, {
      params: Promise.resolve({
        slug: [
          "onnx-community",
          "Qwen3-0.6B-ONNX",
          "resolve",
          QWEN_REVIEWED_REVISION,
          "config.json",
        ],
      }),
    });

    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("content-disposition")).toBeNull();
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("skips delivery shaping when ECO_PROXY_DELIVERY_SHAPING=off (kill-switch)", async () => {
    vi.stubEnv("ECO_PROXY_DELIVERY_SHAPING", "off");
    try {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response("x", {
          status: 200,
          headers: {
            "content-type": "binary/octet-stream",
          },
        }),
      );

      const request = {
        headers: new Headers(),
        nextUrl: new URL(
          `http://127.0.0.1:3000/api/local-models/onnx-community/Qwen3-0.6B-ONNX/resolve/${QWEN_REVIEWED_REVISION}/onnx/model_q4f16.onnx`,
        ),
      } as NextRequest;

      const response = await GET(request, {
        params: Promise.resolve({
          slug: [
            "onnx-community",
            "Qwen3-0.6B-ONNX",
            "resolve",
            QWEN_REVIEWED_REVISION,
            "onnx",
            "model_q4f16.onnx",
          ],
        }),
      });

      // With the kill-switch off, the upstream type passes through untouched
      // and no attachment disposition or nosniff is added.
      expect(response.headers.get("content-type")).toBe("binary/octet-stream");
      expect(response.headers.get("content-disposition")).toBeNull();
      expect(response.headers.get("x-content-type-options")).toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("fails a full reviewed LFS response stream when the upstream body digest does not match the Eco manifest", async () => {
    // Body size must match the reviewed sizeBytes (183442) so the byte-size
    // check passes and the SHA-256 digest check is what actually fails.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new Uint8Array(183_442), {
        status: 200,
        headers: {
          "content-type": "application/octet-stream",
        },
      }),
    );

    const request = {
      headers: new Headers(),
      nextUrl: new URL(
        `http://127.0.0.1:3000/api/local-models/onnx-community/LFM2.5-350M-ONNX/resolve/${LFM25_350M_REVIEWED_REVISION}/onnx/model_q4.onnx`,
      ),
    } as NextRequest;

    const response = await GET(request, {
      params: Promise.resolve({
        slug: [
          "onnx-community",
          "LFM2.5-350M-ONNX",
          "resolve",
          LFM25_350M_REVIEWED_REVISION,
          "onnx",
          "model_q4.onnx",
        ],
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.text()).rejects.toThrow("reviewed SHA-256 mismatch");
  });

  it("allows reviewed tokenizer sidecar files needed by first-run browser loading", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }));

    const request = {
      headers: new Headers(),
      nextUrl: new URL(
        `http://127.0.0.1:3000/api/local-models/onnx-community/Qwen3-0.6B-ONNX/resolve/${QWEN_REVIEWED_REVISION}/tokenizer_config.json`,
      ),
    } as NextRequest;

    const response = await HEAD(request, {
      params: Promise.resolve({
        slug: [
          "onnx-community",
          "Qwen3-0.6B-ONNX",
          "resolve",
          QWEN_REVIEWED_REVISION,
          "tokenizer_config.json",
        ],
      }),
    });

    expect(fetchMock).toHaveBeenCalledWith(
      `https://huggingface.co/onnx-community/Qwen3-0.6B-ONNX/resolve/${QWEN_REVIEWED_REVISION}/tokenizer_config.json`,
      expect.objectContaining({
        method: "HEAD",
      }),
    );
    expect(response.status).toBe(200);
  });

  it("allows LFM2.5-350M sidecar files required by Transformers.js advanced local setup", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }));

    const request = {
      headers: new Headers(),
      nextUrl: new URL(
        "http://127.0.0.1:3000/api/local-models/onnx-community/LFM2.5-350M-ONNX/resolve/main/generation_config.json",
      ),
    } as NextRequest;

    const response = await HEAD(request, {
      params: Promise.resolve({
        slug: [
          "onnx-community",
          "LFM2.5-350M-ONNX",
          "resolve",
          "main",
          "generation_config.json",
        ],
      }),
    });

    expect(fetchMock).toHaveBeenCalledWith(
      `https://huggingface.co/onnx-community/LFM2.5-350M-ONNX/resolve/${LFM25_350M_REVIEWED_REVISION}/generation_config.json`,
      expect.objectContaining({
        method: "HEAD",
      }),
    );
    expect(response.status).toBe(200);
  });

  it("resolves the main alias to the reviewed revision for a v1 catalog q4 variant", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }));

    const request = {
      headers: new Headers(),
      nextUrl: new URL(
        `http://127.0.0.1:3000/api/local-models/onnx-community/LFM2.5-350M-ONNX/resolve/main/onnx/model_q4.onnx`,
      ),
    } as NextRequest;

    const response = await HEAD(request, {
      params: Promise.resolve({
        slug: [
          "onnx-community",
          "LFM2.5-350M-ONNX",
          "resolve",
          "main",
          "onnx",
          "model_q4.onnx",
        ],
      }),
    });

    expect(response.status).toBe(200);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe(
      `https://huggingface.co/onnx-community/LFM2.5-350M-ONNX/resolve/${LFM25_350M_REVIEWED_REVISION}/onnx/model_q4.onnx`,
    );
  });

  it("denies non-catalog lab models even from localhost (v1 catalog is the complete allowlist)", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }));

    // Ternary and Falcon were in the legacy candidates list but are NOT in the
    // v1 catalog. The v1 registry returns the same set for both proxy-allowed and
    // validation-allowed, so even localhost requests must be denied.
    for (const slug of [
      ["onnx-community", "Ternary-Bonsai-4B-ONNX", "resolve", "main", "onnx", "model_q2f16.onnx"],
      ["onnx-community", "Falcon-H1-Tiny-90M-Instruct-ONNX", "resolve", "main", "onnx", "model_q4f16.onnx"],
    ]) {
      const denied = await HEAD(
        {
          headers: new Headers({ host: "localhost:3101" }),
          nextUrl: new URL(`http://localhost:3101/api/local-models/${slug.join("/")}`),
        } as NextRequest,
        { params: Promise.resolve({ slug }) },
      );
      expect(denied.status).toBe(403);
    }

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows LFM2.5 on production proxy after Phase B redistribution review (Layer 5 BLOCKER-01 fix)", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }));
    const slug = [
      "onnx-community",
      "LFM2.5-350M-ONNX",
      "resolve",
      "main",
      "onnx",
      // The f16-free q4 build (2026-07-01 artifact swap — instant-start slice 1).
      "model_q4.onnx",
    ];

    // Production host: previously 403 (lab-only); now 200 (proxy-allowed).
    const productionResponse = await HEAD(
      {
        headers: new Headers({ host: "econetwork.ai" }),
        nextUrl: new URL(`https://econetwork.ai/api/local-models/${slug.join("/")}`),
      } as NextRequest,
      { params: Promise.resolve({ slug }) },
    );
    expect(productionResponse.status).toBe(200);

    // Localhost validation harness: still 200.
    const localhostResponse = await HEAD(
      {
        headers: new Headers({ host: "localhost:3101" }),
        nextUrl: new URL(`http://localhost:3101/api/local-models/${slug.join("/")}`),
      } as NextRequest,
      { params: Promise.resolve({ slug }) },
    );
    expect(localhostResponse.status).toBe(200);

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `https://huggingface.co/onnx-community/LFM2.5-350M-ONNX/resolve/${LFM25_350M_REVIEWED_REVISION}/onnx/model_q4.onnx`,
      `https://huggingface.co/onnx-community/LFM2.5-350M-ONNX/resolve/${LFM25_350M_REVIEWED_REVISION}/onnx/model_q4.onnx`,
    ]);
  });

  it("rejects malformed proxy paths instead of proxying arbitrary requests", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const request = {
      headers: new Headers(),
      nextUrl: new URL("http://127.0.0.1:3000/api/local-models/not-a-valid-path"),
    } as NextRequest;

    const response = await GET(request, {
      params: Promise.resolve({
        slug: ["not-a-valid-path"],
      }),
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.status).toBe(400);
  });

  it("rejects unknown model repositories instead of acting as an open proxy", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const request = {
      headers: new Headers(),
      nextUrl: new URL(
        "http://127.0.0.1:3000/api/local-models/big-science/bloom/resolve/main/pytorch_model.bin",
      ),
    } as NextRequest;

    const response = await GET(request, {
      params: Promise.resolve({
        slug: [
          "big-science",
          "bloom",
          "resolve",
          "main",
          "pytorch_model.bin",
        ],
      }),
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.status).toBe(403);
  });

  it("maps Transformers.js main-revision metadata probes to the reviewed artifact revision", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));
    const request = {
      headers: new Headers(),
      nextUrl: new URL(
        "http://127.0.0.1:3000/api/local-models/onnx-community/Qwen3-0.6B-ONNX/resolve/main/config.json",
      ),
    } as NextRequest;

    const response = await GET(request, {
      params: Promise.resolve({
        slug: [
          "onnx-community",
          "Qwen3-0.6B-ONNX",
          "resolve",
          "main",
          "config.json",
        ],
      }),
    });

    expect(fetchMock).toHaveBeenCalledWith(
      `https://huggingface.co/onnx-community/Qwen3-0.6B-ONNX/resolve/${QWEN_REVIEWED_REVISION}/config.json`,
      expect.objectContaining({
        method: "GET",
      }),
    );
    expect(response.status).toBe(200);
  });

  it("maps Transformers.js main-revision model probes to the reviewed artifact revision", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("x", { status: 206 }));
    const request = {
      headers: new Headers({ range: "bytes=0-0" }),
      nextUrl: new URL(
        "http://127.0.0.1:3000/api/local-models/onnx-community/Qwen3-0.6B-ONNX/resolve/main/onnx/model_q4f16.onnx",
      ),
    } as NextRequest;

    const response = await GET(request, {
      params: Promise.resolve({
        slug: [
          "onnx-community",
          "Qwen3-0.6B-ONNX",
          "resolve",
          "main",
          "onnx",
          "model_q4f16.onnx",
        ],
      }),
    });

    expect(fetchMock).toHaveBeenCalledWith(
      `https://huggingface.co/onnx-community/Qwen3-0.6B-ONNX/resolve/${QWEN_REVIEWED_REVISION}/onnx/model_q4f16.onnx`,
      expect.objectContaining({
        method: "GET",
      }),
    );
    expect(response.status).toBe(206);
  });

  it("rejects non-main non-reviewed revisions for allowlisted model repositories", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const request = {
      headers: new Headers(),
      nextUrl: new URL(
        "http://127.0.0.1:3000/api/local-models/onnx-community/Qwen3-0.6B-ONNX/resolve/some-other-ref/onnx/model_q4f16.onnx",
      ),
    } as NextRequest;

    const response = await GET(request, {
      params: Promise.resolve({
        slug: [
          "onnx-community",
          "Qwen3-0.6B-ONNX",
          "resolve",
          "some-other-ref",
          "onnx",
          "model_q4f16.onnx",
        ],
      }),
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.status).toBe(403);
  });

  it("rejects safe-looking files that are not in the reviewed artifact manifest", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const request = {
      headers: new Headers(),
      nextUrl: new URL(
        `http://127.0.0.1:3000/api/local-models/onnx-community/Qwen3-0.6B-ONNX/resolve/${QWEN_REVIEWED_REVISION}/unreviewed.bin`,
      ),
    } as NextRequest;

    const response = await GET(request, {
      params: Promise.resolve({
        slug: [
          "onnx-community",
          "Qwen3-0.6B-ONNX",
          "resolve",
          QWEN_REVIEWED_REVISION,
          "unreviewed.bin",
        ],
      }),
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.status).toBe(403);
  });

  it("rejects stale Eco Fast external data paths that are not used by the reviewed q4f16 artifact", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const request = {
      headers: new Headers(),
      nextUrl: new URL(
        `http://127.0.0.1:3000/api/local-models/onnx-community/Qwen3-0.6B-ONNX/resolve/${QWEN_REVIEWED_REVISION}/onnx/model_q4f16.onnx_data`,
      ),
    } as NextRequest;

    const response = await GET(request, {
      params: Promise.resolve({
        slug: [
          "onnx-community",
          "Qwen3-0.6B-ONNX",
          "resolve",
          QWEN_REVIEWED_REVISION,
          "onnx",
          "model_q4f16.onnx_data",
        ],
      }),
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.status).toBe(403);
  });

  it("rejects stale Eco Fast external data paths even through the main-revision compatibility alias", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const request = {
      headers: new Headers(),
      nextUrl: new URL(
        "http://127.0.0.1:3000/api/local-models/onnx-community/Qwen3-0.6B-ONNX/resolve/main/onnx/model_q4f16.onnx_data",
      ),
    } as NextRequest;

    const response = await GET(request, {
      params: Promise.resolve({
        slug: [
          "onnx-community",
          "Qwen3-0.6B-ONNX",
          "resolve",
          "main",
          "onnx",
          "model_q4f16.onnx_data",
        ],
      }),
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.status).toBe(403);
  });

  it("rejects double-suffixed Eco Fast artifact paths that Transformers.js should not request", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const request = {
      headers: new Headers(),
      nextUrl: new URL(
        "http://127.0.0.1:3000/api/local-models/onnx-community/Qwen3-0.6B-ONNX/resolve/main/onnx/model_q4f16_q4f16.onnx",
      ),
    } as NextRequest;

    const response = await GET(request, {
      params: Promise.resolve({
        slug: [
          "onnx-community",
          "Qwen3-0.6B-ONNX",
          "resolve",
          "main",
          "onnx",
          "model_q4f16_q4f16.onnx",
        ],
      }),
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.status).toBe(403);
  });

  it.each([
    ["dot segment", ["onnx-community", "Qwen3-0.6B-ONNX", "resolve", QWEN_REVIEWED_REVISION, "..", "config.json"]],
    ["encoded slash", ["onnx-community", "Qwen3-0.6B-ONNX", "resolve", QWEN_REVIEWED_REVISION, "onnx%2Fmodel.onnx"]],
    ["hidden file", ["onnx-community", "Qwen3-0.6B-ONNX", "resolve", QWEN_REVIEWED_REVISION, ".env"]],
  ])("rejects unsafe file paths: %s", async (_label, slug) => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const request = {
      headers: new Headers(),
      nextUrl: new URL(
        `http://127.0.0.1:3000/api/local-models/${slug.join("/")}`,
      ),
    } as NextRequest;

    const response = await GET(request, {
      params: Promise.resolve({ slug }),
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.status).toBe(403);
  });

  it.each([
    ["OPTIONS", OPTIONS],
    ["POST", POST],
    ["PUT", PUT],
    ["PATCH", PATCH],
    ["DELETE", DELETE],
  ])("rejects %s without proxying upstream", (_method, handler) => {
    const fetchMock = vi.spyOn(globalThis, "fetch");

    const response = handler();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
  });
});
