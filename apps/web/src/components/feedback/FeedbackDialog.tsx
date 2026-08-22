// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

/**
 * FeedbackDialog — the minimal opt-in feedback channel.
 *
 * Anonymous by design: the submission carries only the typed message and, when
 * the person explicitly ticks the box, the device summary rendered VERBATIM in
 * the dialog. No account, no IP capture on our side, no hidden fields.
 *
 * Success and errors render inside the dialog (not as toasts) because the
 * footer entry point lives on public pages outside the app ToastProvider —
 * an in-dialog panel behaves identically from every entry point.
 */

import { useEffect, useRef, useState } from "react";
import { Button, Modal, SproutIllustration } from "@eco/ui";
import { ErrorLine } from "../ui/ErrorNotice";
import { buildFeedbackDeviceSummary } from "../../lib/feedback-device-summary";

export const FEEDBACK_DIALOG_AUTO_CLOSE_MS = 1600;
const MAX_MESSAGE_LENGTH = 4000;

type FeedbackDialogProps = {
  open: boolean;
  onClose: () => void;
};

export function FeedbackDialog({ open, onClose }: FeedbackDialogProps) {
  const [message, setMessage] = useState("");
  const [includeDevice, setIncludeDevice] = useState(false);
  const [deviceSummary, setDeviceSummary] = useState<string | null>(null);
  const [phase, setPhase] = useState<"form" | "sending" | "sent" | "error">("form");
  const [errorText, setErrorText] = useState<string | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    },
    [],
  );

  // Compute the summary only when the box is ticked, and keep the computed
  // string in state so the preview IS the payload — one value, shown then sent.
  function toggleIncludeDevice(next: boolean): void {
    setIncludeDevice(next);
    if (next && deviceSummary === null) {
      setDeviceSummary(buildFeedbackDeviceSummary());
    }
  }

  async function handleSend(): Promise<void> {
    const trimmed = message.trim();
    if (trimmed.length === 0) return;

    setPhase("sending");
    setErrorText(null);
    try {
      const res = await fetch("/v1/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: trimmed,
          ...(includeDevice && deviceSummary ? { deviceSummary } : {}),
        }),
      });
      if (!res.ok) {
        setPhase("error");
        setErrorText(
          res.status === 429
            ? "That's a few in a row — wait a minute, then send again."
            : "Couldn't send right now. Your text is still here — try again in a moment.",
        );
        return;
      }
      setPhase("sent");
      closeTimerRef.current = setTimeout(onClose, FEEDBACK_DIALOG_AUTO_CLOSE_MS);
    } catch {
      setPhase("error");
      setErrorText(
        "Couldn't reach the server. Your text is still here — check your connection and try again.",
      );
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title="Send feedback"
      description="Tell us what worked, what didn't, or what's missing."
    >
      {phase === "sent" ? (
        <div className="flex flex-col items-center py-4 text-center">
          <SproutIllustration size={56} className="text-[var(--eco-primary)]" />
          <p className="mt-2 font-medium text-[var(--eco-text)]">Sent — thank you</p>
          <p className="mt-1 text-sm text-[var(--eco-text-secondary)]">
            Feedback is anonymous. Nothing else left your device.
          </p>
        </div>
      ) : (
        <div>
          <textarea
            value={message}
            onChange={(e) => {
              setMessage(e.target.value);
            }}
            rows={4}
            maxLength={MAX_MESSAGE_LENGTH}
            placeholder="What's on your mind?"
            aria-label="Feedback message"
            className="w-full resize-none rounded-[var(--eco-radius-sm)] border border-[var(--eco-border)] bg-[var(--eco-surface)] px-3 py-2 text-sm text-[var(--eco-text)] placeholder:text-[var(--eco-text-secondary)] focus:outline-none focus:ring-2 focus:ring-[var(--eco-primary)]/30"
          />

          <label className="mt-3 flex cursor-pointer items-start gap-2.5">
            <input
              type="checkbox"
              checked={includeDevice}
              onChange={(e) => {
                toggleIncludeDevice(e.target.checked);
              }}
              className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--eco-primary)]"
            />
            <span className="text-sm text-[var(--eco-text-secondary)]">
              Include my device info — helps us reproduce problems
            </span>
          </label>

          {includeDevice && deviceSummary && (
            <p className="mt-2 rounded-[var(--eco-radius-sm)] border border-[var(--eco-border-muted)] bg-[var(--eco-surface-elevated)] px-3 py-2 font-mono text-xs leading-relaxed text-[var(--eco-text-secondary)]">
              {deviceSummary}
            </p>
          )}

          {phase === "error" && errorText && (
            <ErrorLine className="mt-2">{errorText}</ErrorLine>
          )}

          <div className="mt-4 flex items-center justify-between gap-3">
            <p className="text-xs text-[var(--eco-text-secondary)]">
              Anonymous — only what you see here is sent.
            </p>
            <div className="flex shrink-0 gap-2">
              <Button variant="ghost" size="sm" onClick={onClose}>
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                loading={phase === "sending"}
                disabled={message.trim().length === 0 || phase === "sending"}
                onClick={() => {
                  void handleSend();
                }}
              >
                Send
              </Button>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
