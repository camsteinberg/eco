// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Typed error class for local inference stream failures.
 *
 * Extracted from the legacy `lib/local-inference-runtime.ts` so that the
 * active path (`useChat`, `useChatLegacyShim`) has a stable, v1-surface
 * import location. The class is intentionally kept identical to the
 * original so that existing `instanceof` checks continue to work.
 */

export type DiagnosticFailureDomain = 'eco-lifecycle' | 'runtime';

export class LocalInferenceStreamError extends Error {
  code: string;
  recoverable: boolean;
  diagnosticCode?: string;
  diagnosticFailureDomain?: DiagnosticFailureDomain;

  constructor(
    code: string,
    message: string,
    recoverable = false,
    diagnosticCode?: string,
    diagnosticFailureDomain?: DiagnosticFailureDomain,
  ) {
    super(message);
    this.name = 'LocalInferenceStreamError';
    this.code = code;
    this.recoverable = recoverable;
    this.diagnosticCode = diagnosticCode;
    this.diagnosticFailureDomain = diagnosticFailureDomain;
  }
}
