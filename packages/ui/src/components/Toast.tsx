// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

import {
  createContext,
  useContext,
  useCallback,
  useState,
  type ReactNode,
} from "react";
import { Toast as RadixToast } from "radix-ui";
import { motion, AnimatePresence, useReducedMotion } from "motion/react";
import { getTransition } from "../animations/presets.js";

type ToastType = "success" | "error" | "warning" | "info" | "contribution";

type ToastItem = {
  id: string;
  message: string;
  type: ToastType;
};

type ToastContextType = {
  toast: (message: string, type?: ToastType) => void;
};

const typeColors: Record<
  ToastType,
  { bg: string; text: string; border: string }
> = {
  success: {
    bg: "var(--eco-success-soft)",
    text: "var(--eco-success)",
    border: "var(--eco-success)",
  },
  error: {
    bg: "var(--eco-error-soft)",
    text: "var(--eco-error)",
    border: "var(--eco-error)",
  },
  warning: {
    bg: "var(--eco-warning-soft)",
    text: "var(--eco-warning)",
    border: "var(--eco-warning)",
  },
  info: {
    bg: "var(--eco-info-soft)",
    text: "var(--eco-info)",
    border: "var(--eco-info)",
  },
  contribution: {
    bg: "var(--eco-primary-soft)",
    text: "var(--eco-primary)",
    border: "var(--eco-primary)",
  },
};

const ToastContext = createContext<ToastContextType>({ toast: () => {} });

export function useToast(): ToastContextType {
  return useContext(ToastContext);
}

function ToastItemView({
  item,
  onRemove,
}: {
  item: ToastItem;
  onRemove: (id: string) => void;
}) {
  const shouldReduceMotion = useReducedMotion();
  const colors = typeColors[item.type];

  return (
    <RadixToast.Root
      duration={3000}
      onOpenChange={(open) => {
        if (!open) onRemove(item.id);
      }}
      asChild
    >
      <motion.li
        layout
        initial={{ opacity: 0, y: 20, scale: 0.95 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: -10, scale: 0.95 }}
        transition={getTransition("bouncy", shouldReduceMotion)}
        className="rounded-[var(--eco-radius-md)] border px-4 py-3 text-sm shadow-[var(--eco-shadow-md)] backdrop-blur-sm"
        style={{
          backgroundColor: colors.bg,
          color: colors.text,
          borderColor: colors.border,
        }}
      >
        <div className="flex items-center justify-between gap-2">
          <RadixToast.Description className="flex-1">
            {item.message}
          </RadixToast.Description>
          <RadixToast.Close
            className="shrink-0 opacity-60 hover:opacity-100 transition-opacity"
            aria-label="Dismiss"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 16 16"
              fill="currentColor"
              aria-hidden="true"
            >
              <path d="M5.28 4.22a.75.75 0 0 0-1.06 1.06L6.94 8l-2.72 2.72a.75.75 0 1 0 1.06 1.06L8 9.06l2.72 2.72a.75.75 0 1 0 1.06-1.06L9.06 8l2.72-2.72a.75.75 0 0 0-1.06-1.06L8 6.94 5.28 4.22Z" />
            </svg>
          </RadixToast.Close>
        </div>
      </motion.li>
    </RadixToast.Root>
  );
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const addToast = useCallback(
    (message: string, type: ToastType = "info") => {
      const id = crypto.randomUUID();
      setToasts((prev) => [...prev, { id, message, type }]);
    },
    [],
  );

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ toast: addToast }}>
      <RadixToast.Provider>
        {children}
        <AnimatePresence mode="popLayout">
          {toasts.map((item) => (
            <ToastItemView
              key={item.id}
              item={item}
              onRemove={removeToast}
            />
          ))}
        </AnimatePresence>
        <RadixToast.Viewport className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 w-80 list-none m-0 p-0 outline-none" />
      </RadixToast.Provider>
    </ToastContext.Provider>
  );
}

export { ToastItemView as Toast };
export type { ToastType, ToastItem };
