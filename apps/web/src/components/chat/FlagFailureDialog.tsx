// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

/**
 * FlagFailureDialog — the capture moment of the failure-capture loop.
 *
 * Dev-gated (lib/dev-capture.ts): when dogfooding surfaces a bad reply, this
 * dialog turns it into a `CapturedFailure` in two clicks — pick what went
 * wrong, optionally say why, save. The capture persists on this device only
 * (capture-store.ts documents the privacy posture) and replays as a
 * multi-turn probe in the diagnostics eval harness.
 *
 * Tone: a field-notebook moment, not a bug form — clarity first, the warmth
 * lives in the sprout confirmation.
 */

import { useEffect, useRef, useState } from "react";
import { Button, Modal, SproutIllustration } from "@eco/ui";
import { ErrorLine } from "../ui/ErrorNotice";
import { buildCapturedFailure, FAILURE_TAGS } from "../../local-ai/eval/capture";
import type { CaptureSourceMessage, FailureTag } from "../../local-ai/eval/capture";
import { saveCapture } from "../../local-ai/eval/capture-store";
import { getReceiptByGenerationId } from "../../local-ai/lifecycle/generation-receipt";
import type { ChatMessage } from "../../stores/chatStore";

export const FLAG_DIALOG_AUTO_CLOSE_MS = 1400;

const TAG_LABELS: Record<FailureTag, string> = {
  hallucination: "Made something up",
  formatting: "Formatting broke",
  depth: "Too thin",
  instructions: "Ignored instructions",
  other: "Something else",
};

type FlagFailureDialogProps = {
  open: boolean;
  /** The assistant message being flagged. */
  failingMessageId: string;
  /** The displayed conversation (active branch) the capture slices. */
  messages: ChatMessage[];
  onClose: () => void;
};

export function FlagFailureDialog({
  open,
  failingMessageId,
  messages,
  onClose,
}: FlagFailureDialogProps) {
  const [selectedTags, setSelectedTags] = useState<FailureTag[]>([]);
  const [note, setNote] = useState("");
  const [phase, setPhase] = useState<"form" | "saved" | "error">("form");
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    },
    [],
  );

  function toggleTag(tag: FailureTag): void {
    setSelectedTags((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag],
    );
  }

  function handleSave(): void {
    const failing = messages.find((m) => m.id === failingMessageId);
    const receipt = failing?.currentGenerationId
      ? getReceiptByGenerationId(failing.currentGenerationId)
      : null;

    const sourceMessages: CaptureSourceMessage[] = messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      ...(m.citations && m.citations.length > 0
        ? {
            citations: m.citations.map((c) => ({
              title: c.title,
              url: c.url,
              ...(c.source !== undefined ? { source: c.source } : {}),
            })),
          }
        : {}),
    }));

    const capture = buildCapturedFailure({
      messages: sourceMessages,
      failingMessageId,
      tags: selectedTags,
      note: note.trim(),
      receipt,
    });

    if (!capture) {
      setPhase("error");
      return;
    }

    saveCapture(capture);
    setPhase("saved");
    closeTimerRef.current = setTimeout(onClose, FLAG_DIALOG_AUTO_CLOSE_MS);
  }

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title="Flag this reply"
      description="Mark what went wrong — the eval harness replays it to test fixes."
    >
      {phase === "saved" ? (
        <div className="flex flex-col items-center py-4 text-center">
          <SproutIllustration size={56} className="text-[var(--eco-primary)]" />
          <p className="mt-2 font-medium text-[var(--eco-text)]">Captured</p>
          <p className="mt-1 text-sm text-[var(--eco-text-secondary)]">
            It&apos;ll replay in the eval harness on this device.
          </p>
        </div>
      ) : (
        <div>
          <div className="flex flex-wrap gap-2" role="group" aria-label="What went wrong">
            {FAILURE_TAGS.map((tag) => {
              const active = selectedTags.includes(tag);
              return (
                <button
                  key={tag}
                  type="button"
                  aria-pressed={active}
                  onClick={() => {
                    toggleTag(tag);
                  }}
                  className={[
                    "rounded-full border px-3 py-1.5 text-sm transition-colors",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--eco-primary)]/40",
                    "motion-reduce:transition-none",
                    active
                      ? "border-[var(--eco-primary)] bg-[var(--eco-primary-soft)] text-[var(--eco-text)]"
                      : "border-[var(--eco-border)] text-[var(--eco-text-secondary)] hover:border-[var(--eco-primary)]/50 hover:text-[var(--eco-text)]",
                  ].join(" ")}
                >
                  {TAG_LABELS[tag]}
                </button>
              );
            })}
          </div>

          <textarea
            value={note}
            onChange={(e) => {
              setNote(e.target.value);
            }}
            rows={2}
            placeholder="Anything specific? (optional)"
            aria-label="Capture note"
            className="mt-3 w-full resize-none rounded-[var(--eco-radius-sm)] border border-[var(--eco-border)] bg-[var(--eco-surface)] px-3 py-2 text-sm text-[var(--eco-text)] placeholder:text-[var(--eco-text-secondary)] focus:outline-none focus:ring-2 focus:ring-[var(--eco-primary)]/30"
          />

          {phase === "error" && (
            <ErrorLine className="mt-2">
              Couldn&apos;t capture this reply — it needs a completed answer with a
              preceding question.
            </ErrorLine>
          )}

          <div className="mt-4 flex items-center justify-between gap-3">
            <p className="text-xs text-[var(--eco-text-secondary)]">
              Stays in this browser unless you export it.
            </p>
            <div className="flex shrink-0 gap-2">
              <Button variant="ghost" size="sm" onClick={onClose}>
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                disabled={selectedTags.length === 0}
                onClick={handleSave}
              >
                Save capture
              </Button>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
