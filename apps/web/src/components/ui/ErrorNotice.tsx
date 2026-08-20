// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

import type { ReactNode } from "react";
import { WarningTriangle } from "@eco/ui";

/**
 * The one error anatomy. Two expressions:
 *
 * - `ErrorNotice` — contained: for failures that carry recovery actions or
 *   must persist until dismissed. Coral-soft fill, coral-mixed border, the
 *   shared WarningTriangle, lead in text colour (the frame carries severity,
 *   the words stay readable), detail in secondary.
 * - `ErrorLine` — bare: one coral sentence with the glyph, placed right next
 *   to whatever failed. The quietest expression that still carries the
 *   information.
 *
 * Hue is the severity vocabulary: amber strip = degraded but working;
 * coral = something failed. Same glyph for both.
 */

const NOTICE_BORDER = "color-mix(in srgb, var(--eco-coral) 28%, var(--eco-border))";

type ErrorNoticeProps = {
  lead: ReactNode;
  detail?: ReactNode;
  /** Rendered indented to the text column, below the copy. */
  actions?: ReactNode;
  onDismiss?: () => void;
  /** Tighter type and padding for narrow contexts (sidebar, dialogs). */
  compact?: boolean;
  className?: string;
};

export function ErrorNotice({
  lead,
  detail,
  actions,
  onDismiss,
  compact = false,
  className = "",
}: ErrorNoticeProps) {
  return (
    <div
      role="alert"
      className={[
        "flex flex-col rounded-[var(--eco-radius-md)]",
        compact ? "gap-2 px-3 py-2 text-xs leading-5" : "gap-3 px-4 py-3 text-sm",
        className,
      ].join(" ")}
      style={{
        background: "var(--eco-coral-soft)",
        border: `1px solid ${NOTICE_BORDER}`,
        color: "var(--eco-text)",
      }}
    >
      <div className="flex items-start gap-2">
        <WarningTriangle
          className={[
            "shrink-0 text-[var(--eco-coral)]",
            compact ? "mt-0.5 h-3.5 w-3.5" : "mt-0.5 h-[18px] w-[18px]",
          ].join(" ")}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className={compact ? undefined : "font-medium"}>{lead}</span>
          {detail ? (
            <span style={{ color: "var(--eco-text-secondary)" }}>{detail}</span>
          ) : null}
        </div>
        {onDismiss ? (
          <button
            type="button"
            onClick={onDismiss}
            className="shrink-0 rounded-lg px-2 py-1 font-medium text-[var(--eco-coral)] hover:bg-[var(--eco-coral-soft)]"
          >
            Dismiss
          </button>
        ) : null}
      </div>
      {actions ? (
        <div className="ml-7 flex flex-row flex-wrap gap-2">{actions}</div>
      ) : null}
    </div>
  );
}

type ErrorLineProps = {
  children: ReactNode;
  size?: "sm" | "xs";
  id?: string;
  className?: string;
};

export function ErrorLine({
  children,
  size = "sm",
  id,
  className = "",
}: ErrorLineProps) {
  return (
    <p
      id={id}
      role="alert"
      className={[
        "flex items-start gap-2 text-[var(--eco-coral)]",
        size === "xs" ? "text-xs leading-5" : "text-sm",
        className,
      ].join(" ")}
    >
      <WarningTriangle
        className={[
          "shrink-0",
          size === "xs" ? "mt-0.5 h-3.5 w-3.5" : "mt-[3px] h-[15px] w-[15px]",
        ].join(" ")}
      />
      <span className="min-w-0">{children}</span>
    </p>
  );
}
