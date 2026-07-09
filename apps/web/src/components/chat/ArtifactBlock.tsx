// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

import { useState, useCallback } from "react";
import type { SandpackFiles } from "@codesandbox/sandpack-react";
import {
  SandpackProvider,
  SandpackPreview,
} from "@codesandbox/sandpack-react";
import { ArtifactFullscreen } from "./ArtifactFullscreen";

type ArtifactBlockProps = {
  code: string;
  type: "react" | "html";
};

export function ArtifactBlock({ code, type }: ArtifactBlockProps) {
  const [activeTab, setActiveTab] = useState<"code" | "preview">("code");
  const [hasExplicitPreview, setHasExplicitPreview] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [sandpackKey, setSandpackKey] = useState(0);

  const handleRun = useCallback(() => {
    setHasExplicitPreview(true);
    setActiveTab("preview");
    setSandpackKey((k) => k + 1);
  }, []);

  const handlePreview = useCallback(() => {
    setHasExplicitPreview(true);
    setActiveTab("preview");
  }, []);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API not available
    }
  }, [code]);

  const template = type === "react" ? ("react" as const) : ("vanilla" as const);
  const files: SandpackFiles =
    type === "react" ? { "/App.js": code } : { "/index.html": code };

  return (
    <>
      <div className="my-3 max-h-[400px] overflow-hidden rounded-lg border border-[var(--eco-code-border)]">
        {/* Header bar */}
        <div className="flex items-center justify-between bg-[var(--eco-code-header-bg)] px-4 py-1.5 text-xs text-[var(--eco-code-header-text)]">
          {/* Tab buttons */}
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setActiveTab("code")}
              className={`rounded px-2 py-0.5 transition-colors ${
                activeTab === "code"
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
              className={`rounded px-2 py-0.5 transition-colors ${
                activeTab === "preview"
                  ? "bg-[var(--eco-code-inline-bg)] font-semibold text-[var(--eco-code-inline-text)]"
                  : "hover:bg-[var(--eco-border)]"
              }`}
              aria-label="Preview tab"
            >
              Preview
            </button>
          </div>

          {/* Action buttons */}
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={handleRun}
              className="flex items-center gap-1 rounded px-2 py-0.5 transition-colors hover:bg-[var(--eco-border)]"
              aria-label="Run code"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 16 16"
                fill="currentColor"
                className="h-3 w-3"
              >
                <path d="M3 3.732a1.5 1.5 0 0 1 2.305-1.265l6.706 4.267a1.5 1.5 0 0 1 0 2.531l-6.706 4.268A1.5 1.5 0 0 1 3 12.267V3.732Z" />
              </svg>
              Run
            </button>
            <button
              type="button"
              onClick={handleCopy}
              className="flex items-center gap-1 rounded px-2 py-0.5 transition-colors hover:bg-[var(--eco-border)]"
              aria-label={copied ? "Copied" : "Copy code"}
            >
              {copied ? "Copied!" : "Copy"}
            </button>
            <button
              type="button"
              onClick={() => setIsFullscreen(true)}
              className="flex items-center gap-1 rounded px-2 py-0.5 transition-colors hover:bg-[var(--eco-border)]"
              aria-label="Full screen"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 16 16"
                fill="currentColor"
                className="h-3 w-3"
              >
                <path d="M5.28 4.22a.75.75 0 0 0-1.06 0L1.75 6.69V5.25a.75.75 0 0 0-1.5 0V8.5c0 .414.336.75.75.75h3.25a.75.75 0 0 0 0-1.5H2.81l2.47-2.47a.75.75 0 0 0 0-1.06ZM10.72 11.78a.75.75 0 0 0 1.06 0l2.47-2.47v1.44a.75.75 0 0 0 1.5 0V7.5a.75.75 0 0 0-.75-.75h-3.25a.75.75 0 0 0 0 1.5h1.44l-2.47 2.47a.75.75 0 0 0 0 1.06Z" />
              </svg>
              Full Screen
            </button>
          </div>
        </div>

        {/* Artifact body: code stays inert until a deliberate Preview/Run action. */}
        <div className="h-[350px]">
          {activeTab === "preview" && hasExplicitPreview ? (
            <SandpackProvider
              key={sandpackKey}
              template={template}
              files={files}
            >
              <SandpackPreview
                style={{ height: "350px" }}
                showOpenInCodeSandbox={false}
                showRefreshButton={false}
              />
            </SandpackProvider>
          ) : activeTab === "preview" ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 bg-[var(--eco-code-bg)] px-6 text-center text-sm text-[var(--eco-muted)]">
              <p className="font-medium text-[var(--eco-foreground)]">
                Preview is paused
              </p>
              <p>
                Eco does not run model-produced artifacts until you choose to
                preview them.
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

      {isFullscreen && (
        <ArtifactFullscreen
          code={code}
          type={type}
          onClose={() => setIsFullscreen(false)}
        />
      )}
    </>
  );
}
