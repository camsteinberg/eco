// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Maps GPU/inference errors to friendly user-facing messages
 * with recovery suggestions.
 *
 * These messages follow Eco's "transparency without fear" design
 * principle: informative without being alarming.
 */

export type FriendlyError = {
  /** Human-readable error description */
  userMessage: string;
  /** Suggested recovery action */
  recovery: string;
};

/**
 * Map a GPU or inference error to a friendly message with recovery suggestion.
 *
 * Error codes come from the inference Worker or WebGPU API.
 * The default case handles unexpected errors gracefully.
 */
export function mapGpuError(error: { code: string; message: string }): FriendlyError {
  switch (error.code) {
    case 'DEVICE_LOST':
      return {
        userMessage: 'Your GPU needs a moment -- switching to CPU mode',
        recovery: 'This usually resolves itself. Your conversation will continue.',
      };
    case 'DEVICE_LOST_TABS':
      return {
        userMessage: 'Another tab is using the GPU -- using CPU mode here',
        recovery: 'Close other tabs using AI to free up the GPU.',
      };
    case 'OOM':
      return {
        userMessage: 'This model is too large for your current memory',
        recovery: 'Try closing other tabs or apps, or use a smaller model.',
      };
    case 'SHADER_TIMEOUT':
      return {
        userMessage: 'Your GPU took too long to prepare -- using CPU instead',
        recovery: 'CPU mode is slower but works reliably. No action needed.',
      };
    default:
      return {
        userMessage: 'Something went wrong -- using CPU mode',
        recovery: 'Try refreshing the page, or continue with CPU inference.',
      };
  }
}
