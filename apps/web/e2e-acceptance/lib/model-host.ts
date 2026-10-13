// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Where the lane's production build fetches model files from, and how a walk
 * checks that a model's files are actually there before it waits on them.
 *
 * The build is told one model host at compile time
 * (`NEXT_PUBLIC_ECO_MODEL_CDN_BASE`, inlined into the client bundle). By
 * default that is the production model CDN, so the lane downloads exactly as a
 * person's browser does. A model whose files are not on that host cannot be
 * walked from it: a hard 404 from the CDN is not retried through the proxy (see
 * `local-ai/download`), so the setup would fail — or, worse, the walk would
 * wait out a download timeout and report something vaguer than "the files are
 * not there". `ECO_ACCEPTANCE_MODEL_CDN_BASE` overrides the host:
 *
 *  - unset — the production model CDN;
 *  - empty — no CDN at all, so files come through the app's own same-origin
 *    model proxy, which fetches them from Hugging Face;
 *  - any other origin — a host serving the same `/{repo}/resolve/{revision}/{file}`
 *    layout. The app's content-security policy (`connect-src` in
 *    `middleware.ts`) has to allow that origin, or the browser blocks it.
 *
 * Pure and env-injected, so it is unit-tested without a browser.
 */

export const MODEL_HOST_ENV_VAR = "ECO_ACCEPTANCE_MODEL_CDN_BASE";

export const DEFAULT_MODEL_HOST = "https://models.econetwork.ai";

/** What to do when a pick's files are not served — carried by every such failure. */
export const MODEL_HOST_REMEDY =
  `Set ${MODEL_HOST_ENV_VAR}= (empty) to fetch them through the app's own model proxy, `
  + "or set it to a host that serves them, then stop the lane's server on port 3120 so "
  + "the next run rebuilds with the new host (the host is compiled into the build).";

/** The model host the lane's server is built with; empty means the same-origin proxy. */
export function acceptanceModelHost(
  env: Record<string, string | undefined> = process.env,
): string {
  const raw = env[MODEL_HOST_ENV_VAR];
  if (raw === undefined) return DEFAULT_MODEL_HOST;
  return raw.trim().replace(/\/+$/, "");
}

/** The part of a catalog entry that says where its files live. */
export type ModelArtifactRef = {
  hfId: string;
  revision: string;
  files: readonly string[];
};

/**
 * Read a model's artifact from the catalog, narrowing as it goes: the lane
 * reads the catalog file directly rather than through the app's loader, so
 * nothing here may assume the shape.
 */
export function artifactFor(catalog: unknown, modelId: string): ModelArtifactRef | null {
  if (!isRecord(catalog) || !Array.isArray(catalog.models)) return null;
  const entry: unknown = catalog.models.find(
    (model: unknown) => isRecord(model) && model.id === modelId,
  );
  if (!isRecord(entry) || !isRecord(entry.artifact)) return null;
  const { hfId, revision, files } = entry.artifact;
  if (typeof hfId !== "string" || typeof revision !== "string" || !Array.isArray(files)) {
    return null;
  }
  const names = files.filter((file: unknown): file is string => typeof file === "string");
  return names.length > 0 ? { hfId, revision, files: names } : null;
}

/**
 * The URL the app fetches one file from: on the model host when there is one,
 * otherwise through its own proxy — the same layout either way, mirroring
 * `buildModelFileURL` in `local-ai/download/proxy`.
 */
export function modelFileUrl(
  artifact: ModelArtifactRef,
  file: string,
  host: string,
  appBaseUrl: string,
): string {
  const path = [artifact.hfId, "resolve", artifact.revision, file]
    .flatMap((part) => part.split("/"))
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return host ? `${host}/${path}` : `${appBaseUrl.replace(/\/+$/, "")}/api/local-models/${path}`;
}

/** The first and last file of a model: enough to tell "served" from "never uploaded". */
export function sampleFiles(artifact: ModelArtifactRef): string[] {
  const first = artifact.files[0];
  const last = artifact.files[artifact.files.length - 1];
  return [...new Set([first, last].filter((file): file is string => file !== undefined))];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
