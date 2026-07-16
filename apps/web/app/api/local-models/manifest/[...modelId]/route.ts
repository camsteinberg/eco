// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { getModel } from "../../../../../src/local-ai/catalog/catalog";
import {
  getLocalModelRegistryEntry,
  getValidationLocalModelRegistryEntry,
} from "../../../../../src/lib/local-model-registry";
import { isValidationHarnessRequestAllowed } from "../../../../../src/lib/validation-harness-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{
    modelId: string[];
  }>;
};

/**
 * Catalog model ids contain lowercase alphanumeric, `/`, `-`, and `.`.
 * Reject anything else (path traversal, whitespace, control chars).
 */
const VALID_MODEL_ID_RE = /^[a-z0-9][a-z0-9/.-]{0,127}$/;

function isValidModelId(raw: string): boolean {
  if (!raw || raw.length > 128) return false;
  if (raw.includes("..")) return false;
  return VALID_MODEL_ID_RE.test(raw);
}

type ManifestFile = {
  path: string;
  sizeBytes: number;
  oid: string;
};

type ManifestResponse = {
  modelId: string;
  hfId: string;
  revision: string;
  files: ManifestFile[];
};

export async function GET(
  request: Request,
  { params }: RouteContext,
): Promise<Response> {
  const { modelId: segments } = await params;
  const modelId = segments.join("/");

  if (!isValidModelId(modelId)) {
    return Response.json(
      { error: "invalid_model_id" },
      { status: 400 },
    );
  }

  // Two-tier lookup, mirroring the proxy route: catalog models always
  // resolve; validation-lane eval candidates resolve ONLY for harness
  // requests (loopback + explicit env — 404 in production). Without this,
  // eval candidates fall to the client's heuristic-size plan, and the
  // sustained probe's weights-cached verification (exact reviewed sizes)
  // can never pass for a fully-downloaded candidate.
  const isCatalogModel = Boolean(getModel(modelId));
  const registryEntry = isCatalogModel
    ? getLocalModelRegistryEntry(modelId)
    : isValidationHarnessRequestAllowed(request.headers)
      ? getValidationLocalModelRegistryEntry(modelId)
      : undefined;
  if (!isCatalogModel && !registryEntry) {
    return Response.json(
      { error: "model_not_in_catalog" },
      { status: 404 },
    );
  }

  const artifact = registryEntry?.artifact;
  if (!artifact || !artifact.fileMetadata) {
    return Response.json(
      { error: "model_artifact_unavailable" },
      { status: 404 },
    );
  }

  // Build the manifest from the registry's reviewed fileMetadata.
  const files: ManifestFile[] = [];
  for (const filePath of artifact.files) {
    const meta = artifact.fileMetadata[filePath];
    if (!meta) continue;
    files.push({
      path: filePath,
      sizeBytes: meta.sizeBytes,
      oid: meta.oid,
    });
  }

  if (files.length === 0) {
    return Response.json(
      { error: "model_artifact_unavailable" },
      { status: 404 },
    );
  }

  const body: ManifestResponse = {
    modelId,
    hfId: artifact.hfId,
    revision: artifact.revision,
    files,
  };

  return Response.json(body, {
    status: 200,
    headers: {
      "Cache-Control": "public, max-age=3600, immutable",
    },
  });
}

function methodNotAllowed(): Response {
  return Response.json(
    { error: "method_not_allowed" },
    {
      status: 405,
      headers: {
        Allow: "GET",
      },
    },
  );
}

export const OPTIONS = methodNotAllowed;
export const POST = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
export const HEAD = methodNotAllowed;
