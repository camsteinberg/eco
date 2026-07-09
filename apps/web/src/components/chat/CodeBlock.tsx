// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

import { useState, useCallback, useRef, useEffect } from "react";

type CodeBlockProps = {
  code: string;
  language: string;
};

export function CodeBlock({ code, language }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const [wrap, setWrap] = useState(false);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const preRef = useRef<HTMLPreElement>(null);

  const updateScrollState = useCallback(() => {
    const el = preRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 0);
    setCanScrollRight(el.scrollLeft < el.scrollWidth - el.clientWidth - 1);
  }, []);

  useEffect(() => {
    const el = preRef.current;
    if (!el) return;

    updateScrollState();

    const observer = new ResizeObserver(() => updateScrollState());
    observer.observe(el);
    return () => observer.disconnect();
  }, [updateScrollState]);

  const handleCopy = useCallback(() => {
    try {
      // Use ClipboardItem for Safari consistency (synchronous call from gesture)
      void navigator.clipboard.write([
        new ClipboardItem({
          "text/plain": new Blob([code], { type: "text/plain" }),
        }),
      ]);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback for browsers without ClipboardItem
      void navigator.clipboard
        .writeText(code)
        .then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        })
        .catch(() => {});
    }
  }, [code]);

  return (
    <div className="group relative my-4 overflow-hidden rounded-xl border border-[var(--eco-code-border)] shadow-sm">
      <div className="flex items-center justify-between gap-3 bg-[var(--eco-code-header-bg)] px-4 py-2 text-xs text-[var(--eco-code-header-text)]">
        <span className="font-medium uppercase tracking-[0.16em]">{language}</span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setWrap((value) => !value)}
            className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded px-2 py-0.5 text-xs transition-colors hover:bg-[var(--eco-border)] md:min-h-0 md:min-w-0"
            aria-label={wrap ? "Disable code wrap" : "Wrap code"}
          >
            {wrap ? "Unwrap" : "Wrap"}
          </button>
          <button
            type="button"
            onClick={handleCopy}
            className="flex min-h-[44px] min-w-[44px] items-center justify-center gap-1 rounded px-2 py-0.5 text-xs transition-colors hover:bg-[var(--eco-border)] md:min-h-0 md:min-w-0"
            aria-label={copied ? "Copied" : "Copy code"}
          >
            {copied ? (
              <>
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="var(--eco-success)" className="h-3.5 w-3.5">
                  <path fillRule="evenodd" d="M12.416 3.376a.75.75 0 0 1 .208 1.04l-5 7.5a.75.75 0 0 1-1.154.114l-3-3a.75.75 0 0 1 1.06-1.06l2.353 2.353 4.493-6.74a.75.75 0 0 1 1.04-.207Z" clipRule="evenodd" />
                </svg>
                Copied!
              </>
            ) : (
              "Copy"
            )}
          </button>
        </div>
      </div>
      <div className="relative">
        {canScrollLeft && (
          <div
            data-testid="scroll-indicator-left"
            className="pointer-events-none absolute left-0 top-0 bottom-0 z-10 w-6 bg-gradient-to-r from-[var(--eco-code-header-bg)] to-transparent"
          />
        )}
        {canScrollRight && (
          <div
            data-testid="scroll-indicator-right"
            className="pointer-events-none absolute right-0 top-0 bottom-0 z-10 w-6 bg-gradient-to-l from-[var(--eco-code-header-bg)] to-transparent"
          />
        )}
        <pre
          ref={preRef}
          onScroll={updateScrollState}
          className={[
            "bg-[var(--eco-code-header-bg)] px-4 py-3 text-sm leading-relaxed text-[var(--eco-neutral-text)]",
            wrap ? "whitespace-pre-wrap break-words" : "overflow-x-auto",
          ].join(" ")}
        >
          <code>{code}</code>
        </pre>
      </div>
    </div>
  );
}
