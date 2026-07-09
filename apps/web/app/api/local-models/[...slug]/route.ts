// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { createHash } from "node:crypto";
import type { NextRequest } from "next/server";
import {
  buildHuggingFaceModelUrl,
  isSafeLocalModelProxyFilePath,
  parseLocalModelProxySlug,
} from "../../../../src/lib/local-model-proxy";
import {
  getProxyAllowedLocalModelRegistryArtifacts,
  getValidationAllowedLocalModelRegistryArtifacts,
  type LocalModelRegistryArtifact,
} from "../../../../src/lib/local-model-registry";
import { isValidationHarnessRequestAllowed } from "../../../../src/lib/validation-harness-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Large weights download in bounded Range chunks (see download.ts), but give
// each proxied request generous headroom so a single chunk — or a whole
// mid-size single-GET file (e.g. Bonsai ~1.1 GB) on a slow link — never trips
// the default function timeout mid-stream. 300 s is the platform max default.
export const maxDuration = 300;

type RouteContext = {
  params: Promise<{
    slug: string[];
  }>;
};

const FORWARDED_REQUEST_HEADERS = [
  "accept",
  "accept-encoding",
  "if-modified-since",
  "if-none-match",
  "range",
] as const;

const FORWARDED_RESPONSE_HEADERS = [
  "accept-ranges",
  "cache-control",
  "content-length",
  "content-range",
  "content-type",
  "etag",
  "last-modified",
  "x-linked-etag",
  "x-linked-size",
] as const;

type AllowedArtifact = {
  revision: string;
  files: Set<string>;
  fileMetadata: NonNullable<LocalModelRegistryArtifact["fileMetadata"]>;
};

function buildAllowedArtifactMap(
  artifacts: LocalModelRegistryArtifact[],
): Map<string, AllowedArtifact[]> {
  const allowed = new Map<string, AllowedArtifact[]>();

  for (const artifact of artifacts) {
    const entries = allowed.get(artifact.hfId) ?? [];
    const existing = entries.find((entry) => entry.revision === artifact.revision);
    if (existing) {
      for (const file of artifact.files) existing.files.add(file);
      Object.assign(existing.fileMetadata, artifact.fileMetadata);
    } else {
      entries.push({
        revision: artifact.revision,
        files: new Set(artifact.files),
        fileMetadata: { ...artifact.fileMetadata },
      });
    }
    allowed.set(artifact.hfId, entries);
  }

  return allowed;
}

const PROXY_ALLOWED_MODEL_ARTIFACTS = buildAllowedArtifactMap(
  getProxyAllowedLocalModelRegistryArtifacts(),
);
const VALIDATION_ALLOWED_MODEL_ARTIFACTS = buildAllowedArtifactMap(
  getValidationAllowedLocalModelRegistryArtifacts(),
);

function findAllowedArtifact(
  artifacts: Map<string, AllowedArtifact[]>,
  parsed: NonNullable<ReturnType<typeof parseLocalModelProxySlug>>,
): AllowedArtifact | null {
  const candidates = artifacts.get(parsed.modelId) ?? [];
  return candidates.find((artifact) =>
    artifact.files.has(parsed.filePath)
    && (artifact.revision === parsed.revision || parsed.revision === "main"),
  ) ?? null;
}

function resolveAllowedArtifact(
  request: NextRequest,
  parsed: NonNullable<ReturnType<typeof parseLocalModelProxySlug>>,
): AllowedArtifact | null {
  return findAllowedArtifact(PROXY_ALLOWED_MODEL_ARTIFACTS, parsed)
    ?? (
      isValidationHarnessRequestAllowed(request.headers)
        ? findAllowedArtifact(VALIDATION_ALLOWED_MODEL_ARTIFACTS, parsed)
        : null
    );
}

function buildProxyHeaders(request: NextRequest): Record<string, string> {
  const headers: Record<string, string> = {};

  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) {
      headers[name] = value;
    }
  }

  return headers;
}

function getArtifactOidKind(oid: string): "git-blob-sha1" | "lfs-sha256" {
  return oid.length === 64 ? "lfs-sha256" : "git-blob-sha1";
}

function buildResponseHeaders(
  upstream: Response,
  filePath: string,
  reviewedMetadata?: { sizeBytes: number; oid: string },
): Headers {
  const headers = new Headers();

  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) {
      headers.set(name, value);
    }
  }

  if (reviewedMetadata) {
    headers.set("x-eco-reviewed-size-bytes", String(reviewedMetadata.sizeBytes));
    headers.set("x-eco-reviewed-oid", reviewedMetadata.oid);
    headers.set("x-eco-reviewed-oid-kind", getArtifactOidKind(reviewedMetadata.oid));
  }

  // Delivery-shaping experiment (instant-start plan, open question #8): some
  // real-world environments — AV / security middleboxes on consumer Windows
  // boxes — kill long anonymous binary streams, which blocked the 2 GB Gemma
  // download on the founder's device. Declare binary payloads explicitly:
  // a normalized octet-stream type, an attachment disposition with a real
  // filename, and nosniff so content-sniffing layers have no reason to
  // buffer-scan the body. All three are inert for the client fetch()
  // pipeline (it reads the stream and never consults these headers). JSON
  // assets keep their upstream type — Transformers.js reads configs and
  // tokenizers through this proxy.
  //
  // `ECO_PROXY_DELIVERY_SHAPING=off` is the no-redeploy kill-switch if the
  // shaping ever backfires. Read at request time so tests can toggle it;
  // default (unset) = enabled.
  if (process.env.ECO_PROXY_DELIVERY_SHAPING !== "off") {
    headers.set("x-content-type-options", "nosniff");
    if (!filePath.endsWith(".json")) {
      const filename = (filePath.split("/").pop() ?? "model.bin").replaceAll('"', "");
      headers.set("content-type", "application/octet-stream");
      headers.set("content-disposition", `attachment; filename="${filename}"`);
    }
  }

  return headers;
}

function shouldVerifyFullBody(
  request: NextRequest,
  upstream: Response,
  method: "GET" | "HEAD",
  reviewedMetadata?: { sizeBytes: number; oid: string },
): reviewedMetadata is { sizeBytes: number; oid: string } {
  return method === "GET"
    && Boolean(upstream.body)
    && upstream.ok
    && upstream.status !== 206
    && !request.headers.get("range")
    && !upstream.headers.get("content-range")
    && reviewedMetadata != null
    && getArtifactOidKind(reviewedMetadata.oid) === "lfs-sha256";
}

function buildVerifiedArtifactBody(
  body: ReadableStream<Uint8Array>,
  reviewedMetadata: { sizeBytes: number; oid: string },
  filePath: string,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const hash = createHash("sha256");
  let loadedBytes = 0;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          const digest = hash.digest("hex");
          if (loadedBytes !== reviewedMetadata.sizeBytes) {
            controller.error(new Error(
              `Eco reviewed byte-size mismatch for ${filePath}.`,
            ));
            return;
          }
          if (digest !== reviewedMetadata.oid) {
            controller.error(new Error(
              `Eco reviewed SHA-256 mismatch for ${filePath}.`,
            ));
            return;
          }
          controller.close();
          return;
        }

        loadedBytes += value.byteLength;
        hash.update(value);
        controller.enqueue(value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
}

async function proxyModelRequest(
  request: NextRequest,
  { params }: RouteContext,
  method: "GET" | "HEAD",
): Promise<Response> {
  const { slug } = await params;
  const parsed = parseLocalModelProxySlug(slug);

  if (!parsed) {
    return Response.json(
      {
        error: "invalid_model_proxy_path",
      },
      { status: 400 },
    );
  }

  const allowedArtifact = resolveAllowedArtifact(request, parsed);
  if (
    !allowedArtifact
    || !isSafeLocalModelProxyFilePath(parsed.filePath)
  ) {
    return Response.json(
      {
        error: "model_asset_not_allowed",
      },
      { status: 403 },
    );
  }

  const isReviewedRevision = allowedArtifact.revision === parsed.revision;
  const isSafeMainAlias = parsed.revision === "main";
  if (!isReviewedRevision && !isSafeMainAlias) {
    return Response.json(
      {
        error: "model_asset_not_allowed",
      },
      { status: 403 },
    );
  }

  const upstreamUrl = buildHuggingFaceModelUrl({
    ...parsed,
    revision: allowedArtifact.revision,
  });

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl.toString(), {
      method,
      headers: buildProxyHeaders(request),
      cache: "no-store",
      redirect: "follow",
    });
  } catch {
    return Response.json(
      {
        error: "model_asset_unavailable",
      },
      { status: 502 },
    );
  }

  const reviewedMetadata = allowedArtifact.fileMetadata[parsed.filePath];
  const body = shouldVerifyFullBody(request, upstream, method, reviewedMetadata)
    ? buildVerifiedArtifactBody(upstream.body!, reviewedMetadata, parsed.filePath)
    : method === "HEAD" ? null : upstream.body;

  return new Response(body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: buildResponseHeaders(
      upstream,
      parsed.filePath,
      reviewedMetadata,
    ),
  });
}

function methodNotAllowed(): Response {
  return Response.json(
    {
      error: "method_not_allowed",
    },
    {
      status: 405,
      headers: {
        Allow: "GET, HEAD",
      },
    },
  );
}

export async function GET(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  return proxyModelRequest(request, context, "GET");
}

export async function HEAD(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  return proxyModelRequest(request, context, "HEAD");
}

export const OPTIONS = methodNotAllowed;
export const POST = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
