// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Server-side names for the local-model proxy path contract.
 *
 * The ONE implementation is `local-ai/download/proxy.ts` (the client builds
 * URLs with it; the `/api/local-models` route parses and validates them with
 * these re-exports). Keeping a single source means the path-traversal filter
 * the route enforces is byte-for-byte the one the client was built against.
 */

import { LOCAL_MODEL_PROXY_PATH_PREFIX, LOCAL_MODEL_PROXY_PATH_TEMPLATE } from "../local-ai/download/proxy";

export {
  LOCAL_MODEL_PROXY_PATH_PREFIX,
  LOCAL_MODEL_PROXY_PATH_TEMPLATE,
  type ParsedProxySlug as ParsedLocalModelProxySlug,
  parseProxySlug as parseLocalModelProxySlug,
  buildProxyURL as buildLocalModelProxyPath,
  buildHuggingFaceURL as buildHuggingFaceModelUrl,
  isSafeProxyFilePath as isSafeLocalModelProxyFilePath,
} from "../local-ai/download/proxy";

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
