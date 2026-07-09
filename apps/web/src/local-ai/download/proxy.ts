// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Proxy — build and parse `/api/local-models/{model}/resolve/{revision}/{file}`
 * URLs that route Hugging Face downloads through Eco's API.
 *
 * Why this exists: HF CDN does not return CORS headers for direct browser
 * downloads. Eco's API re-emits the bytes with the right CORS headers and
 * may sign auth on behalf of the browser. The proxy URL shape mirrors
 * the upstream layout so consumers can reason about it as "the HF path
 * with /api/local-models prepended."
 */

export const LOCAL_MODEL_PROXY_PATH_PREFIX = '/api/local-models';

export const LOCAL_MODEL_PROXY_PATH_TEMPLATE =
  `${LOCAL_MODEL_PROXY_PATH_PREFIX}/{model}/resolve/{revision}/`;

export type ParsedProxySlug = {
  modelId: string;
  revision: string;
  filePath: string;
};

/**
 * Build the absolute proxy path for one file in one model+revision.
 *
 *   buildProxyURL({ modelId: 'Xenova/phi-3-mini', revision: 'main', filePath: 'config.json' })
 *   → '/api/local-models/Xenova/phi-3-mini/resolve/main/config.json'
 *
 * Each path segment is URL-encoded individually so slashes within `modelId`
 * survive (HF model IDs are `org/repo`). `filePath` may include nested
 * directories; segments are encoded but separators are preserved.
 */
export function buildProxyURL(parsed: ParsedProxySlug): string {
  return [
    LOCAL_MODEL_PROXY_PATH_PREFIX,
    encodePathSegments(parsed.modelId),
    'resolve',
    encodeURIComponent(parsed.revision),
    encodePathSegments(parsed.filePath),
  ].join('/');
}

/**
 * The configured R2 CDN origin for direct model-file delivery
 * (`NEXT_PUBLIC_ECO_MODEL_CDN_BASE`, inlined into the client bundle at build
 * time), or `undefined` when unset — in which case files are fetched through
 * the same-origin proxy exactly as before.
 */
export function getModelCdnBase(): string | undefined {
  const base = process.env.NEXT_PUBLIC_ECO_MODEL_CDN_BASE?.trim();
  if (!base) return undefined;
  return base;
}

/**
 * Build the URL to actually FETCH a model file from: the direct R2 CDN URL when
 * a CDN base is configured, otherwise the same-origin proxy path.
 *
 * The HF path layout (`{model}/resolve/{revision}/{file}`) is preserved on both
 * sides, so the byte contents — and therefore the client-side SHA-256 integrity
 * check against the manifest `oid` — are identical regardless of source. R2
 * only ever holds reviewed files, so no allow-list is lost by going direct.
 *
 * NOTE: this is the *transport* URL only. The stable storage identity stays the
 * proxy path (`buildProxyURL`), so switching the source — flipping the CDN flag,
 * or the kill-switch back to the proxy — never invalidates already-downloaded
 * files.
 */
export function buildModelFileURL(parsed: ParsedProxySlug, cdnBase?: string | null): string {
  const proxyPath = buildProxyURL(parsed);
  const base = cdnBase?.trim().replace(/\/+$/, '');
  if (!base) return proxyPath;
  // Swap the same-origin proxy prefix for the CDN origin; the rest of the path
  // (`/{model}/resolve/{revision}/{file}`) is byte-for-byte identical.
  return base + proxyPath.slice(LOCAL_MODEL_PROXY_PATH_PREFIX.length);
}

/**
 * Parse the slug array passed by Next.js dynamic routes
 * (`/api/local-models/[...slug]/route.ts`) back into model/revision/file.
 *
 * Returns `null` when the slug is structurally invalid — callers should
 * 404 on null.
 */
export function parseProxySlug(slug: string[] | undefined): ParsedProxySlug | null {
  if (!slug || slug.length < 4) return null;

  const resolveIndex = slug.indexOf('resolve');
  if (resolveIndex < 1) return null;

  const modelSegments = slug.slice(0, resolveIndex);
  const revision = slug[resolveIndex + 1];
  const fileSegments = slug.slice(resolveIndex + 2);

  if (!revision || fileSegments.length === 0) return null;

  return {
    modelId: modelSegments.join('/'),
    revision,
    filePath: fileSegments.join('/'),
  };
}

/**
 * Build the upstream Hugging Face URL that the API route fetches from.
 * The proxy preserves the HF path layout so the same `filePath` works on
 * either side.
 */
export function buildHuggingFaceURL(parsed: ParsedProxySlug): URL {
  return new URL(
    `${encodePathSegments(parsed.modelId)}/resolve/${encodeURIComponent(parsed.revision)}/${encodePathSegments(parsed.filePath)}`,
    'https://huggingface.co/',
  );
}

/**
 * Filter for filenames that may safely be served by the proxy.
 *
 * Rejects path-traversal, hidden files, backslashes, and the URL-encoded
 * forms of `/` (which would otherwise let a caller smuggle a path
 * separator past the segment split). Used by the API route and
 * mirrored here so client-side validation matches server-side exactly.
 */
export function isSafeProxyFilePath(filePath: string): boolean {
  return filePath
    .split('/')
    .every((segment) =>
      segment.length > 0
      && segment !== '.'
      && segment !== '..'
      && !segment.startsWith('.')
      && !segment.includes('\\')
      && !segment.includes('%2f')
      && !segment.includes('%2F'),
    );
}

function encodePathSegments(path: string): string {
  return path
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}
