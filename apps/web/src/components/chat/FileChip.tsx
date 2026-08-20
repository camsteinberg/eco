// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

type FileChipStatus = "validating" | "reading" | "extracting" | "done" | "error";

type FileChipProps = {
  filename: string;
  size: number;
  status: FileChipStatus;
  errorMessage?: string;
  truncated?: boolean;
  onRemove: () => void;
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)}B`;
  if (bytes < 1024 * 1024) return `${String(Math.round(bytes / 1024))}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function truncateFilename(name: string, max = 20): string {
  if (name.length <= max) return name;
  const ext = name.lastIndexOf(".");
  if (ext > 0 && name.length - ext <= 6) {
    const extStr = name.slice(ext);
    return name.slice(0, max - extStr.length - 1) + "\u2026" + extStr;
  }
  return name.slice(0, max - 1) + "\u2026";
}

const isProcessing = (s: FileChipStatus) =>
  s === "validating" || s === "reading" || s === "extracting";

export function FileChip({
  filename,
  size,
  status,
  errorMessage,
  truncated,
  onRemove,
}: FileChipProps) {
  const hasError = status === "error";
  const processing = isProcessing(status);

  return (
    <div
      className="inline-flex max-w-full items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors"
      style={{
        borderColor: hasError ? "var(--eco-danger)" : "var(--eco-border)",
        backgroundColor: hasError ? "var(--eco-danger-soft)" : "transparent",
      }}
    >
      {/* File icon */}
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 20 20"
        fill="currentColor"
        className="h-3.5 w-3.5 shrink-0"
        style={{ color: hasError ? "var(--eco-danger)" : "var(--eco-text-secondary)" }}
        aria-hidden="true"
      >
        <path d="M3 3.5A1.5 1.5 0 014.5 2h6.879a1.5 1.5 0 011.06.44l3.122 3.12a1.5 1.5 0 01.44 1.06V16.5A1.5 1.5 0 0114.5 18h-10A1.5 1.5 0 013 16.5v-13z" />
      </svg>

      {/* Filename + size. The filename is the only element allowed to shrink —
          everything after it keeps its intrinsic width, so a long name eats into
          the name rather than wrapping the trailing badge or pushing the pill's
          cap past the chip edge. */}
      <span
        className="min-w-0 max-w-[120px] truncate"
        style={{ color: hasError ? "var(--eco-danger)" : "var(--eco-text)" }}
        title={filename}
      >
        {truncateFilename(filename)}
      </span>
      <span className="shrink-0 whitespace-nowrap" style={{ color: "var(--eco-text-secondary)" }}>
        {formatSize(size)}
      </span>

      {/* Status indicator */}
      {processing && (
        <span role="status" className="flex items-center gap-1" style={{ color: "var(--eco-text-secondary)" }}>
          <svg className="h-3 w-3 animate-spin" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" strokeDasharray="28" strokeDashoffset="8" />
          </svg>
          <span className="sr-only">{status}</span>
        </span>
      )}

      {status === "done" && (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 20 20"
          fill="currentColor"
          className="h-3.5 w-3.5 shrink-0"
          style={{ color: "var(--eco-success)" }}
          aria-hidden="true"
        >
          <path fillRule="evenodd" d="M16.704 4.153a.75.75 0 01.143 1.052l-8 10.5a.75.75 0 01-1.127.075l-4.5-4.5a.75.75 0 011.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 011.05-.143z" clipRule="evenodd" />
        </svg>
      )}

      {hasError && errorMessage && (
        <span style={{ color: "var(--eco-danger)" }} role="status">
          {errorMessage}
        </span>
      )}

      {/* Truncation warning */}
      {truncated && (
        <span
          className="shrink-0 whitespace-nowrap"
          style={{ color: "var(--eco-text-secondary)" }}
          title="File content was truncated to fit size limits"
        >
          (truncated)
        </span>
      )}

      {/* On-device badge — v1.0 reads every attachment locally on this device. */}
      {status === "done" && (
        <span
          className="inline-flex shrink-0 items-center gap-0.5 whitespace-nowrap rounded-full px-1.5 py-0.5 text-[10px] font-medium"
          style={{ backgroundColor: "var(--eco-success-soft)", color: "var(--eco-success)" }}
          title="This file stays on your device and is read locally for this reply"
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-2.5 w-2.5 shrink-0" aria-hidden="true">
            <path fillRule="evenodd" d="M10 1a4.5 4.5 0 00-4.5 4.5V9H5a2 2 0 00-2 2v6a2 2 0 002 2h10a2 2 0 002-2v-6a2 2 0 00-2-2h-.5V5.5A4.5 4.5 0 0010 1zm3 8V5.5a3 3 0 10-6 0V9h6z" clipRule="evenodd" />
          </svg>
          On-device
        </span>
      )}

      {/* Remove button */}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${filename}`}
        className="ml-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-[var(--eco-border)]"
        style={{ color: "var(--eco-text-secondary)" }}
      >
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-3 w-3" aria-hidden="true">
          <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
        </svg>
      </button>
    </div>
  );
}
