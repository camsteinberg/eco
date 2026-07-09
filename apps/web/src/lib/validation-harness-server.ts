// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { isValidationHarnessEnabledForEnvironment } from "./validation-harness";
import { internalDeniedJson } from "./internal-route-denial";

type HeaderReader = {
  get(name: string): string | null;
};

function hostnameFromSingleHostHeader(host: string): string | null {
  const normalizedHost = host.trim();
  if (!normalizedHost) {
    return null;
  }

  try {
    return new URL(`http://${normalizedHost}`).hostname;
  } catch {
    return normalizedHost.replace(/:\d+$/, "");
  }
}

function hostnamesFromHostHeader(host: string | null): string[] {
  if (!host) {
    return [];
  }
  return host
    .split(",")
    .map(hostnameFromSingleHostHeader)
    .filter((hostname): hostname is string => Boolean(hostname));
}

function hostnamesFromHeaders(headers: HeaderReader | null | undefined): string[] {
  if (!headers) {
    return [];
  }

  return hostnamesFromHostHeader(headers.get("host"));
}

function isExplicitServerHarnessEnabled(): boolean {
  return process.env.NEXT_PUBLIC_ECO_VALIDATION_HARNESS === "true"
    || process.env.ECO_VALIDATION_HARNESS === "true";
}

export function isValidationHarnessRequestAllowed(
  headers?: HeaderReader | null,
): boolean {
  const hostnames = hostnamesFromHeaders(headers);
  const hostname = hostnames[0] ?? null;
  const nodeEnv = process.env.NODE_ENV === "test" ? "development" : process.env.NODE_ENV;
  const explicitHarnessEnabled = isExplicitServerHarnessEnabled();
  return isValidationHarnessEnabledForEnvironment({
    hostname,
    nodeEnv,
    explicitHarnessEnabled,
  }) && hostnames.every((host) => isValidationHarnessEnabledForEnvironment({
    hostname: host,
    nodeEnv,
    explicitHarnessEnabled,
  }));
}

export function validationHarnessNotFoundResponse(): Response {
  return internalDeniedJson({ error: "Not found" }, { status: 404 });
}
