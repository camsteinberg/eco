// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Kept in sync with RUNTIME_ASSET_COPIES (scripts/copy-runtime-assets.mjs) and
// the `/ort/` variants selectable via ?eco-force-ort-artifact. This route is a
// legacy/offline-SW fallback (prod serves the static public/ort/ copies), but
// both must list the same files so a forced variant is never 404 on either path.
const ALLOWED_ORT_FILES = new Set([
  "ort-wasm-simd-threaded.asyncify.mjs",
  "ort-wasm-simd-threaded.asyncify.wasm",
  "ort-wasm-simd-threaded.mjs",
  "ort-wasm-simd-threaded.wasm",
  "ort-wasm-simd-threaded.jspi.mjs",
  "ort-wasm-simd-threaded.jspi.wasm",
]);

type RouteContext = {
  params: Promise<{
    file: string;
  }>;
};

function getOrtDistPath(file: string): string | null {
  if (!ALLOWED_ORT_FILES.has(file)) {
    return null;
  }

  return path.join(
    process.cwd(),
    "node_modules",
    "onnxruntime-web",
    "dist",
    file,
  );
}

function contentTypeFor(file: string): string {
  if (file.endsWith(".mjs")) {
    return "text/javascript; charset=utf-8";
  }
  if (file.endsWith(".wasm")) {
    return "application/wasm";
  }
  return "application/octet-stream";
}

async function serveOrtFile(
  { params }: RouteContext,
  method: "GET" | "HEAD",
): Promise<Response> {
  const { file } = await params;
  const filePath = getOrtDistPath(file);

  if (!filePath) {
    return Response.json({ error: "unknown_ort_asset" }, { status: 404 });
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
    return Response.json({ error: "missing_ort_asset" }, { status: 404 });
  }
}

export async function GET(
  _request: Request,
  context: RouteContext,
): Promise<Response> {
  return serveOrtFile(context, "GET");
}

export async function HEAD(
  _request: Request,
  context: RouteContext,
): Promise<Response> {
  return serveOrtFile(context, "HEAD");
}
