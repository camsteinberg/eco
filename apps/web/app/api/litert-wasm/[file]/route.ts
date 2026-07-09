// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Same-origin server for the LiteRT-LM Web WASM runtime assets.
 *
 * `@litert-lm/core` ships its WASM glue (`litertlm_wasm_internal.js` and the
 * compat variant) + the `.wasm` binaries, but defaults to loading them from a
 * jsDelivr CDN (`LiteRtLm.DEFAULT_WASM_PATH`). Eco's `script-src 'self'` CSP
 * blocks that CDN script load, so we serve the assets from this same-origin
 * route instead and point `loadLiteRtLm()` here at boot (see local-ai/bootstrap).
 *
 * Mirrors `app/api/ort/[file]/route.ts`: a fixed allowlist streamed from
 * node_modules. PRODUCTION-CRITICAL since Gemma 4 (LiteRT) became the
 * f16-less device default (#192): every Gemma load fetches these assets.
 * Deployment needs two companions or the route breaks in prod only:
 * `outputFileTracingIncludes` in next.config.ts (else the files are absent
 * from the Vercel function bundle → 404) and the site-gate bypass in
 * middleware.ts (else cookie-less engine fetches 307 to /gate). Both were
 * missing until 2026-07-03 — the founder-device instant Gemma failure.
 */

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_LITERT_WASM_FILES = new Set([
  "litertlm_wasm_internal.js",
  "litertlm_wasm_internal.wasm",
  "litertlm_wasm_compat_internal.js",
  "litertlm_wasm_compat_internal.wasm",
]);

type RouteContext = {
  params: Promise<{
    file: string;
  }>;
};

function getLiteRtWasmPath(file: string): string | null {
  if (!ALLOWED_LITERT_WASM_FILES.has(file)) {
    return null;
  }

  return path.join(
    process.cwd(),
    "node_modules",
    "@litert-lm",
    "core",
    "wasm",
    file,
  );
}

function contentTypeFor(file: string): string {
  if (file.endsWith(".js")) {
    return "text/javascript; charset=utf-8";
  }
  if (file.endsWith(".wasm")) {
    return "application/wasm";
  }
  return "application/octet-stream";
}

async function serveLiteRtWasmFile(
  { params }: RouteContext,
  method: "GET" | "HEAD",
): Promise<Response> {
  const { file } = await params;
  const filePath = getLiteRtWasmPath(file);

  if (!filePath) {
    return Response.json({ error: "unknown_litert_wasm_asset" }, { status: 404 });
  }

  try {
    const fileStat = await stat(filePath);
    const headers = new Headers({
      "cache-control": "public, max-age=31536000, immutable",
      "content-length": String(fileStat.size),
      "content-type": contentTypeFor(file),
    });

    if (method === "HEAD") {
      return new Response(null, { headers });
    }

    return new Response(
      Readable.toWeb(createReadStream(filePath)) as ReadableStream,
      { headers },
    );
  } catch {
    return Response.json({ error: "missing_litert_wasm_asset" }, { status: 404 });
  }
}

export async function GET(
  _request: Request,
  context: RouteContext,
): Promise<Response> {
  return serveLiteRtWasmFile(context, "GET");
}

export async function HEAD(
  _request: Request,
  context: RouteContext,
): Promise<Response> {
  return serveLiteRtWasmFile(context, "HEAD");
}
