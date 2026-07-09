// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

type AutoModelTagProps = {
  resolvedModel: string;
};

/**
 * Subtle tag displayed below assistant messages when model was "auto"
 * resolved to a concrete model by the orchestrator.
 * Renders: "Auto -> Llama 3.1 8B"
 */
export function AutoModelTag({ resolvedModel }: AutoModelTagProps) {
  const displayName = formatModelName(resolvedModel);

  return (
    <span className="inline-flex items-center gap-1 text-xs text-[var(--eco-text-secondary)] opacity-60 mt-1">
      <span>Auto</span>
      <span aria-hidden="true">&rarr;</span>
      <span>{displayName}</span>
    </span>
  );
}

/**
 * Format a model ID for human-readable display.
 * "llama-3.1-8b-q4_k_m" -> "Llama 3.1 8B"
 * "tinyllama-1.1b-q4_k_m" -> "Tinyllama 1.1B"
 * "phi-3-mini" -> "Phi 3 Mini"
 */
function formatModelName(modelId: string): string {
  // Remove quantization suffix (e.g., "-q4_k_m", "-Q4_K_M")
  const family = modelId.replace(/[-_][qQ]\d.*$/, "");
  return family
    .split("-")
    .map((part) => {
      // Keep version numbers and sizes uppercase
      if (/^\d/.test(part)) return part.toUpperCase();
      // Capitalize size indicators like "8b" -> "8B"
      if (/^\d+[bB]$/.test(part)) return part.toUpperCase();
      // Normal word capitalization
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(" ");
}
