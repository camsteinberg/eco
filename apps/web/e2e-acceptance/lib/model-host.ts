// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Where the lane's production build fetches model files from, and how a walk
 * checks that a model's files are actually there before it waits on them.
 *
 * The build is told one model host at compile time
 * (`NEXT_PUBLIC_ECO_MODEL_CDN_BASE`, inlined into the client bundle). By
 * default that is the production model CDN, so the lane downloads exactly as a
 * person's browser does. A file the host is missing (a 403/404) is not the end
 * of it: the app retries that file once through its own same-origin proxy,
 * which fetches it from Hugging Face (`fetchFileToBlobWithFallback` in
 * `local-ai/download`). The lane mirrors that rule — a file only the proxy
 * serves is a note in the report, and only a file neither serves stops the
 * walk, before it waits out a download that cannot finish.
 * `ECO_ACCEPTANCE_MODEL_CDN_BASE` overrides the host:
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

/** What to do when neither the model host nor the app's proxy serves a file — carried by every such failure. */
export const MODEL_HOST_REMEDY =
  "The app's own model proxy fetches from Hugging Face, so check this machine can reach it; "
  + `or set ${MODEL_HOST_ENV_VAR} to a host that serves the files, then stop the lane's server `
  + "on port 3120 so the next run rebuilds with the new host (the host is compiled into the build).";

/** One file's answer from each source the app would try, as an HTTP status or why it never answered. */
export type FileProbe = {
  file: string;
  /** The model host's answer; null when there is no separate host (the proxy is the only source). */
  host: { url: string; status: string; ok: boolean } | null;
  /** The app's own proxy's answer; null when it was not asked because the host served the file. */
  proxy: { url: string; status: string; ok: boolean } | null;
};

export type ServedVerdict = {
  /** Files that will download, and from where — in the app's own words where it falls back. */
  notes: string[];
  /** Files no source serves, with every status seen. Empty when the model can be set up. */
  missing: string[];
};

/**
 * Whether the app retries a file through its proxy after the host answered
 * `status` — the rule in `shouldFallbackToProxy` (`local-ai/download`): any
 * failure falls back (a network error, a 5xx, 408/429, the 403/404 of a host
 * missing the file) except any other 4xx, which is final.
 */
export function appFallsBackOn(status: string): boolean {
  const code = Number(status);
  if (!Number.isInteger(code)) return true;
  if (code >= 400 && code < 500) return [403, 404, 408, 429].includes(code);
  return true;
}

/**
 * Judge each file the way the app's download does: served by the host is fine;
 * missing on the host (403/404) but served by the proxy is fine too, because
 * the app falls back to the proxy for exactly those statuses — but it is worth
 * saying, since the host is out of step with the catalog; a proxy that could
 * not answer (429/5xx) is noted and left to setup's real download to settle;
 * a definitive refusal from both is the one case that cannot be set up.
 */
export function judgeFileSources(probes: readonly FileProbe[]): ServedVerdict {
  const notes: string[] = [];
  const missing: string[] = [];
  for (const probe of probes) {
    if (probe.host?.ok) continue;
    if (probe.proxy?.ok && (probe.host === null || appFallsBackOn(probe.host.status))) {
      if (probe.host) {
        const { status } = probe.host;
        notes.push(
          status === "403" || status === "404"
            ? `the model host is missing ${probe.file} (${status}); the app fell back to its own proxy`
            : `the model host answered ${status} for ${probe.file}; the app fell back to its own proxy`,
        );
      }
      continue;
    }
    // A proxy that is rate-limited upstream (429) or failing (5xx) has not said
    // the file is missing — it could not say either way. That is noted, not
    // fatal: setup's real download still fails the run on a real refusal.
    if (
      probe.proxy
      && proxyCouldNotConfirm(probe.proxy.status)
      && (probe.host === null || appFallsBackOn(probe.host.status))
    ) {
      const { status } = probe.proxy;
      notes.push(
        `could not confirm ${probe.file} is served: the app's proxy answered ${status}`
          + `${status === "429" ? " (upstream rate limit)" : ""}; `
          + "continuing — a real refusal during setup still fails the run",
      );
      continue;
    }
    missing.push(
      [probe.host, probe.proxy]
        .filter((answer): answer is NonNullable<typeof answer> => answer !== null)
        .map((answer) => `${answer.status} ${answer.url}`)
        .join(" and "),
    );
  }
  return { notes, missing };
}

/** A proxy answer that confirms nothing: rate-limited upstream, or the proxy itself failing. */
function proxyCouldNotConfirm(status: string): boolean {
  const code = Number(status);
  return code === 429 || (code >= 500 && code < 600);
}

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
