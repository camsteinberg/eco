// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

import React from "react";
import type { ErrorInfo, ReactNode } from "react";
import { shouldForceValidationRuntimeCrash } from "../../lib/validation-harness";
import { logger } from "../../lib/logger";

type Props = {
  children: ReactNode;
  localRecoveryAvailable?: boolean;
};

type State = {
  hasError: boolean;
  errorMessage: string | null;
};

/**
 * Error boundary for the chat area that catches Worker crashes,
 * WebGPU device loss, and other local inference rendering errors.
 *
 * On error, shows a brief, non-alarming message. The user can try
 * on-device AI again and continue chatting normally — the
 * conversation is not lost.
 */
export class LocalInferenceErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, errorMessage: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return {
      hasError: true,
      errorMessage: error.message || "Something went wrong with on-device AI.",
    };
  }

  override componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    logger.error("[LocalInferenceErrorBoundary]", error, errorInfo);
  }

  override componentDidMount(): void {
    if (shouldForceValidationRuntimeCrash()) {
      this.setState({
        hasError: true,
        errorMessage: "Validation harness forced a local runtime crash.",
      });
    }
  }

  private readonly dismissBoundary = () => {
    this.setState({ hasError: false, errorMessage: null });
  };

  override render() {
    if (this.state.hasError) {
      const { localRecoveryAvailable = false } = this.props;

      return (
        <div className="flex h-full flex-col">
          <div className="flex flex-1 items-center justify-center px-4">
            <div
              className="mx-auto max-w-md rounded-2xl border px-6 py-5 text-center"
              style={{
                borderColor: "var(--eco-border)",
                backgroundColor: "var(--eco-surface-elevated)",
              }}
            >
              <p
                className="text-sm font-medium"
                style={{ color: "var(--eco-text)" }}
              >
                On-device AI ran into a problem
              </p>
              <p
                className="mt-1.5 text-[13px]"
                style={{ color: "var(--eco-text-secondary)" }}
              >
                {localRecoveryAvailable
                  ? "Your conversation is safe. You can pick up right where you left off."
                  : "Your conversation is safe. Give it a moment, then try again."}
              </p>
              <div className="mt-4 flex flex-wrap items-center justify-center gap-3">
                <button
                  type="button"
                  onClick={this.dismissBoundary}
                  className="rounded-lg px-5 py-2 text-sm font-medium text-white transition-colors"
                  style={{ backgroundColor: "var(--eco-primary)" }}
                >
                  Try on-device again
                </button>
              </div>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
