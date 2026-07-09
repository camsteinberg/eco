// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

import { useEffect, useCallback, useState } from "react";
import type { SandpackFiles } from "@codesandbox/sandpack-react";
import {
  SandpackProvider,
  SandpackPreview,
} from "@codesandbox/sandpack-react";

type ArtifactFullscreenProps = {
  code: string;
  type: "react" | "html";
  onClose: () => void;
};

export function ArtifactFullscreen({
  code,
  type,
  onClose,
}: ArtifactFullscreenProps) {
  const [activePane, setActivePane] = useState<"code" | "preview">("code");
  const [hasExplicitPreview, setHasExplicitPreview] = useState(false);
  const [sandpackKey, setSandpackKey] = useState(0);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    },
    [onClose],
  );

  const handleRun = useCallback(() => {
    setHasExplicitPreview(true);
    setActivePane("preview");
    setSandpackKey((key) => key + 1);
  }, []);

  const handlePreview = useCallback(() => {
    setHasExplicitPreview(true);
    setActivePane("preview");
  }, []);

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (e.target === e.currentTarget) {
        onClose();
      }
    },
    [onClose],
  );

  const template = type === "react" ? ("react" as const) : ("vanilla" as const);
  const files: SandpackFiles =
    type === "react" ? { "/App.js": code } : { "/index.html": code };

  const typeLabel = type === "react" ? "React" : "HTML";

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-[var(--eco-scrim)]"
      onClick={handleBackdropClick}
      role="dialog"
      aria-modal="true"
      aria-label={`${typeLabel} artifact fullscreen editor`}
    >
      <div className="mx-auto my-8 h-[calc(100vh-4rem)] w-full max-w-4xl overflow-hidden rounded-xl bg-[var(--eco-surface)]">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[var(--eco-code-border)] bg-[var(--eco-code-header-bg)] px-4 py-2 text-sm text-[var(--eco-code-header-text)]">
          <div className="flex items-center gap-3">
            <span className="font-medium">{typeLabel} Artifact</span>
            <div className="flex items-center gap-1 text-xs" aria-label="Artifact view">
              <button
                type="button"
                onClick={() => setActivePane("code")}
                className={`rounded px-2 py-1 transition-colors ${
                  activePane === "code"
                    ? "bg-[var(--eco-code-inline-bg)] font-semibold text-[var(--eco-code-inline-text)]"
                    : "hover:bg-[var(--eco-border)]"
                }`}
                aria-label="Code tab"
              >
                Code
              </button>
              <button
                type="button"
                onClick={handlePreview}
                className={`rounded px-2 py-1 transition-colors ${
                  activePane === "preview"
                    ? "bg-[var(--eco-code-inline-bg)] font-semibold text-[var(--eco-code-inline-text)]"
                    : "hover:bg-[var(--eco-border)]"
                }`}
                aria-label="Preview tab"
              >
                Preview
              </button>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleRun}
              className="rounded px-2 py-1 text-xs font-medium transition-colors hover:bg-[var(--eco-border)]"
              aria-label="Run code"
            >
              Run
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded p-1 transition-colors hover:bg-[var(--eco-border)]"
              aria-label="Close fullscreen"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 16 16"
                fill="currentColor"
                className="h-4 w-4"
              >
                <path d="M5.28 4.22a.75.75 0 0 0-1.06 1.06L6.94 8l-2.72 2.72a.75.75 0 1 0 1.06 1.06L8 9.06l2.72 2.72a.75.75 0 1 0 1.06-1.06L9.06 8l2.72-2.72a.75.75 0 0 0-1.06-1.06L8 6.94 5.28 4.22Z" />
              </svg>
            </button>
          </div>
        </div>

        {/* Runtime stays unmounted until Run/Preview, then unmounts on Code. */}
        <div className="h-[calc(100%-3rem)]">
          {activePane === "preview" && hasExplicitPreview ? (
            <SandpackProvider key={sandpackKey} template={template} files={files}>
              <SandpackPreview
                style={{ height: "100%" }}
                showOpenInCodeSandbox={false}
                showRefreshButton={false}
              />
            </SandpackProvider>
          ) : activePane === "preview" ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 bg-[var(--eco-code-bg)] px-6 text-center text-sm text-[var(--eco-muted)]">
              <p className="font-medium text-[var(--eco-foreground)]">
                Preview is paused
              </p>
              <p>
                Fullscreen artifacts open in code view. Choose Run preview only
                when you want Eco to mount the sandbox runtime.
              </p>
              <button
                type="button"
                onClick={handleRun}
                className="rounded-full bg-[var(--eco-primary)] px-4 py-2 text-sm font-medium text-[var(--eco-primary-foreground)] transition-colors hover:bg-[var(--eco-primary)]/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--eco-primary)] focus-visible:ring-offset-2"
              >
                Run preview
              </button>
            </div>
          ) : (
            <pre className="h-full overflow-auto bg-[var(--eco-code-bg)] p-4 text-sm text-[var(--eco-code-text)]">
              <code>{code}</code>
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}
