// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

import { useToast } from "../components/Toast.js";

/**
 * Convenience hook that maps to semantic toast types.
 * Must be used inside a `<ToastProvider>`.
 *
 * @example
 * ```tsx
 * const feedback = useFeedbackToast();
 * feedback.success("Settings saved");
 * feedback.error("Something went wrong");
 * ```
 */
export function useFeedbackToast() {
  const { toast } = useToast();

  return {
    success: (message: string) => toast(message, "success"),
    error: (message: string) => toast(message, "error"),
    warning: (message: string) => toast(message, "warning"),
    info: (message: string) => toast(message, "info"),
    contribution: (message: string) => toast(message, "contribution"),
  };
}

type FeedbackToastProps = {
  type: "success" | "error" | "warning" | "info" | "contribution";
  message: string;
};

/**
 * Display component for documentation and stories.
 * In production, use the `useFeedbackToast()` hook instead.
 */
export function FeedbackToast({ type: _type, message: _message }: FeedbackToastProps) {
  // Toast rendering is handled by ToastProvider
  return null;
}
