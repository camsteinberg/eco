// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

import { forwardRef, type ReactNode } from "react";
import { Dialog } from "radix-ui";
import { motion, AnimatePresence, useReducedMotion } from "motion/react";
import { getTransition } from "../animations/presets.js";

type ModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
};

export const Modal = forwardRef<HTMLDivElement, ModalProps>(
  function Modal(
    { open, onOpenChange, title, description, children, className },
    ref,
  ) {
    const shouldReduceMotion = useReducedMotion();

    return (
      <Dialog.Root open={open} onOpenChange={onOpenChange}>
        <AnimatePresence>
          {open && (
            <Dialog.Portal forceMount>
              <Dialog.Overlay asChild>
                <motion.div
                  className="fixed inset-0 bg-[var(--eco-scrim)] backdrop-blur-sm z-50"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: shouldReduceMotion ? 0 : 0.15 }}
                />
              </Dialog.Overlay>
              <Dialog.Content ref={ref} asChild>
                {/*
                  Centering uses a fixed flex wrapper (no transforms).
                  motion.div is the inner card and animates opacity +
                  scale only. This separates positioning from animation
                  so motion's transform can't overwrite the centering.
                  pointer-events-none on the wrapper lets clicks pass
                  through to the overlay; pointer-events-auto on the
                  card re-enables interaction.
                */}
                <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center p-4">
                  <motion.div
                    className={[
                      "pointer-events-auto w-full max-w-md",
                      "max-h-[calc(100vh-2rem)] overflow-y-auto",
                      "rounded-[var(--eco-radius-md)] bg-[var(--eco-surface-elevated)] p-6",
                      "shadow-[var(--eco-shadow-lg)] eco-grain",
                      "relative",
                      className,
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    initial={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.96 }}
                    animate={shouldReduceMotion ? { opacity: 1 } : { opacity: 1, scale: 1 }}
                    exit={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.96 }}
                    transition={getTransition("modal", shouldReduceMotion)}
                  >
                    <Dialog.Title className="font-[family-name:var(--eco-font-display)] font-medium text-lg text-[var(--eco-text)] pr-8">
                      {title}
                    </Dialog.Title>
                    {description && (
                      <Dialog.Description className="mt-2 text-sm text-[var(--eco-text-secondary)]">
                        {description}
                      </Dialog.Description>
                    )}
                    <div className="mt-4">{children}</div>
                    <Dialog.Close
                      className="absolute right-4 top-4 text-[var(--eco-text-muted)] hover:text-[var(--eco-text)] transition-colors"
                      aria-label="Close"
                    >
                      <svg
                        width="16"
                        height="16"
                        viewBox="0 0 16 16"
                        fill="currentColor"
                        aria-hidden="true"
                      >
                        <path d="M5.28 4.22a.75.75 0 0 0-1.06 1.06L6.94 8l-2.72 2.72a.75.75 0 1 0 1.06 1.06L8 9.06l2.72 2.72a.75.75 0 1 0 1.06-1.06L9.06 8l2.72-2.72a.75.75 0 0 0-1.06-1.06L8 6.94 5.28 4.22Z" />
                      </svg>
                    </Dialog.Close>
                  </motion.div>
                </div>
              </Dialog.Content>
            </Dialog.Portal>
          )}
        </AnimatePresence>
      </Dialog.Root>
    );
  },
);
