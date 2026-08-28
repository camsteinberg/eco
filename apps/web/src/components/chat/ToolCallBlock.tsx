// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

import { useEffect, useRef, useState } from "react";
import { CodeBlock } from "./CodeBlock";

type ToolCallBlockProps = {
  name: string;
  status: "running" | "complete" | "error";
  input?: Record<string, unknown>;
  output?: string;
  /**
   * Friendly one-line label of what the tool did (e.g. "5 miles → kilometers"),
   * shown as a quiet secondary label next to the tool name. Falls back to the
   * tool name alone when absent.
   */
  summary?: string;
  defaultCollapsed?: boolean;
};

const TOOL_DISPLAY_NAMES: Record<string, string> = {
  calculator: "Calculator",
  datetime: "Date & time",
  "unit-conversion": "Unit conversion",
  money: "Money math",
  web_search: "Web Search",
  code_execution: "Code Execution",
};

export function ToolCallBlock({ name, status, input, output, summary, defaultCollapsed }: ToolCallBlockProps) {
  // Collapse-by-default when the call has settled. A completed (or errored) call
  // renders as a quiet, compact summary — the authoritative answer already lives
  // in the model's prose, so the block stays calm and out of the way. Only the
  // in-progress "running" state expands by default (it has nothing to summarize
  // yet). `defaultCollapsed` can still force-collapse a running call.
  const [expanded, setExpanded] = useState(
    defaultCollapsed ? false : status === "running",
  );

  // A block that mounted expanded (running) must actually settle back into the
  // quiet summary when the call completes — otherwise raw args JSON stays open
  // in the conversation for good. The user's own toggle always wins: once they
  // expand/collapse by hand, the settle transition leaves their choice alone.
  const userToggledRef = useRef(false);
  const prevStatusRef = useRef(status);
  useEffect(() => {
    if (
      prevStatusRef.current === "running" &&
      status !== "running" &&
      !userToggledRef.current
    ) {
      setExpanded(false);
    }
    prevStatusRef.current = status;
  }, [status]);

  // For code_execution: keep model-produced code inert. Tool call UI is a
  // transcript of what the model requested, not a local runtime surface.
  if (name === "code_execution" && input?.code && typeof input.code === "string") {
    const code = input.code;
    const lang = typeof input.language === "string" ? input.language : "";
    return (
      <div
        className="my-3 rounded-xl border border-[var(--eco-border)] bg-[var(--eco-surface-elevated)]/60 p-3"
        role="group"
        aria-label="Disabled code execution tool call"
      >
        <div
          className="mb-3 rounded-lg border border-[var(--eco-border)] bg-[var(--eco-primary-soft)]/25 px-3 py-2 text-sm text-[var(--eco-text)]"
          role="status"
        >
          <p className="font-medium">Code execution is disabled in Eco web v1.0.</p>
          <p className="mt-1 text-xs leading-relaxed text-[var(--eco-text-secondary)]">
            Eco can show the generated code for review, but it will not run tool-produced code locally unless a reviewed,
            network-isolated sandbox is available.
          </p>
          {output && (
            <p className="mt-2 text-xs leading-relaxed text-[var(--eco-text-secondary)]">
              Tool result: {output}
            </p>
          )}
        </div>
        <CodeBlock code={code} language={lang || "text"} />
      </div>
    );
  }

  return (
    <div
      className="my-1 rounded-lg border text-xs"
      style={{ borderColor: "var(--eco-border)" }}
    >
      <button
        type="button"
        onClick={() => {
          userToggledRef.current = true;
          setExpanded(!expanded);
        }}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-[var(--eco-border)]/20"
        aria-expanded={expanded}
      >
        {/* Status icon */}
        {status === "running" ? (
          <span
            className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent"
            style={{ color: "var(--eco-primary)" }}
            aria-label="Running"
          />
        ) : status === "complete" ? (
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 20 20"
            fill="currentColor"
            className="h-4 w-4 shrink-0"
            style={{ color: "var(--eco-success)" }}
            aria-hidden="true"
          >
            <path
              fillRule="evenodd"
              d="M16.704 4.153a.75.75 0 01.143 1.052l-8 10.5a.75.75 0 01-1.127.075l-4.5-4.5a.75.75 0 011.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 011.05-.143z"
              clipRule="evenodd"
            />
          </svg>
        ) : (
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 20 20"
            fill="currentColor"
            className="h-4 w-4 shrink-0"
            style={{ color: "var(--eco-danger)" }}
            aria-hidden="true"
          >
            <path
              d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z"
            />
          </svg>
        )}

        <span className="flex min-w-0 flex-1 items-baseline gap-2">
          <span
            className="shrink-0 font-medium"
            style={{ color: "var(--eco-text)" }}
          >
            {TOOL_DISPLAY_NAMES[name] ?? name}
          </span>
          {summary && (
            <span
              className="truncate font-normal"
              style={{ color: "var(--eco-text-secondary)" }}
            >
              {summary}
            </span>
          )}
        </span>

        {/* Chevron */}
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 20 20"
          fill="currentColor"
          className={`h-4 w-4 shrink-0 transition-transform ${expanded ? "rotate-180" : ""}`}
          style={{ color: "var(--eco-text-secondary)" }}
          aria-hidden="true"
        >
          <path
            fillRule="evenodd"
            d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z"
            clipRule="evenodd"
          />
        </svg>
      </button>

      {expanded && (
        <div
          className="border-t px-3 py-2"
          style={{ borderColor: "var(--eco-border)" }}
        >
          {input && (
            <div style={{ color: "var(--eco-text-secondary)" }}>
              Input: {JSON.stringify(input)}
            </div>
          )}
          {output && (
            <div className="mt-1" style={{ color: "var(--eco-text)" }}>
              Result: {output}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
