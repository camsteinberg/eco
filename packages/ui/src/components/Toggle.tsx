// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

import { forwardRef, useId } from "react";
import { Switch } from "radix-ui";
import { motion, useReducedMotion } from "motion/react";

type ToggleProps = {
  checked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
  label: string;
  className?: string;
};

export const Toggle = forwardRef<HTMLButtonElement, ToggleProps>(
  function Toggle(
    { checked, onCheckedChange, disabled, label, className },
    ref,
  ) {
    const shouldReduceMotion = useReducedMotion();
    const id = useId();
    const labelId = `${id}-label`;

    return (
      <div className="flex items-center gap-3">
        <label
          id={labelId}
          className="text-sm text-[var(--eco-text)]"
        >
          {label}
        </label>
        <Switch.Root
          ref={ref}
          {...(checked !== undefined ? { checked } : {})}
          {...(onCheckedChange !== undefined ? { onCheckedChange } : {})}
          {...(disabled !== undefined ? { disabled } : {})}
          aria-labelledby={labelId}
          className={[
            "relative h-6 w-11 rounded-full transition-colors",
            "data-[state=checked]:bg-[var(--eco-mint)]",
            "data-[state=unchecked]:bg-[var(--eco-border)]",
            "disabled:opacity-40 disabled:cursor-not-allowed",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--eco-primary)]/30 focus-visible:ring-offset-2",
            className ?? "",
          ].join(" ")}
        >
          <Switch.Thumb asChild>
            <motion.span
              className="block h-5 w-5 rounded-full bg-white shadow-sm"
              layout
              transition={
                shouldReduceMotion
                  ? { duration: 0 }
                  : { type: "spring", stiffness: 500, damping: 30 }
              }
            />
          </Switch.Thumb>
        </Switch.Root>
      </div>
    );
  },
);
