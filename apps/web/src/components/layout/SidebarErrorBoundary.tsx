// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

import React from "react";
import type { ErrorInfo, ReactNode } from "react";
import { logger } from "../../lib/logger";

type Props = {
  children: ReactNode;
};

type State = {
  hasError: boolean;
};

export class SidebarErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  override componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    logger.error("Sidebar error:", error, errorInfo);
  }

  override render() {
    if (this.state.hasError) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-3 p-4">
          <p className="text-sm text-[var(--eco-text-secondary)]">
            Sidebar encountered an error
          </p>
          <button
            type="button"
            onClick={() => this.setState({ hasError: false })}
            className="rounded-lg border border-[var(--eco-border)] px-4 py-2 text-sm font-medium transition-colors hover:bg-[var(--eco-surface-elevated)]"
            style={{ color: "var(--eco-primary)" }}
          >
            Reload sidebar
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
