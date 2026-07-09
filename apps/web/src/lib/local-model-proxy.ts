// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

export const LOCAL_MODEL_PROXY_PATH_PREFIX = "/api/local-models";
export const LOCAL_MODEL_PROXY_PATH_TEMPLATE =
  `${LOCAL_MODEL_PROXY_PATH_PREFIX}/{model}/resolve/{revision}/`;

export type ParsedLocalModelProxySlug = {
  modelId: string;
  revision: string;
  filePath: string;
};

function encodePathSegments(path: string): string {
  return path
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

export function getLocalModelProxyRemoteConfig(origin: string, revision?: string): {
  remoteHost: string;
  remotePathTemplate: string;
} {
  const remotePathTemplate = revision
    ? `${LOCAL_MODEL_PROXY_PATH_PREFIX}/{model}/resolve/${encodeURIComponent(revision)}/`
    : LOCAL_MODEL_PROXY_PATH_TEMPLATE;

  return {
    remoteHost: new URL(origin).origin,
    remotePathTemplate,
  };
}

export function parseLocalModelProxySlug(
  slug: string[] | undefined,
): ParsedLocalModelProxySlug | null {
  if (!slug || slug.length < 4) {
    return null;
  }

  const resolveIndex = slug.indexOf("resolve");
  if (resolveIndex < 1) {
    return null;
  }

  const modelSegments = slug.slice(0, resolveIndex);
  const revision = slug[resolveIndex + 1];
  const fileSegments = slug.slice(resolveIndex + 2);

  if (!revision || fileSegments.length === 0) {
    return null;
  }

  return {
    modelId: modelSegments.join("/"),
    revision,
    filePath: fileSegments.join("/"),
  };
}

export function buildLocalModelProxyPath({
  modelId,
  revision,
  filePath,
}: ParsedLocalModelProxySlug): string {
  return [
    LOCAL_MODEL_PROXY_PATH_PREFIX,
    encodePathSegments(modelId),
    "resolve",
    encodeURIComponent(revision),
    encodePathSegments(filePath),
  ].join("/");
}

export function buildHuggingFaceModelUrl({
  modelId,
  revision,
  filePath,
}: ParsedLocalModelProxySlug): URL {
  return new URL(
    `${encodePathSegments(modelId)}/resolve/${encodeURIComponent(revision)}/${encodePathSegments(filePath)}`,
    "https://huggingface.co/",
  );
}

export function isSafeLocalModelProxyFilePath(filePath: string): boolean {
  return filePath
    .split("/")
    .every((segment) =>
      segment.length > 0
      && segment !== "."
      && segment !== ".."
      && !segment.startsWith(".")
      && !segment.includes("\\")
      && !segment.includes("%2f")
      && !segment.includes("%2F"),
    );
}
