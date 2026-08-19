// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client"

import { useEffect, useState, useCallback, createContext, useContext } from 'react'

type ToastType = 'success' | 'error' | 'info'

type Toast = {
  id: string
  message: string
  type: ToastType
  /** Auto-dismiss delay in ms. Defaults to 3000; longer copy (e.g. the
   *  retired-model notice) passes a larger value so it can be read in full. */
  durationMs?: number
}

type ToastContextType = {
  toast: (message: string, type?: ToastType, durationMs?: number) => void
}

const ToastContext = createContext<ToastContextType>({ toast: () => {} })

export function useToast() {
  return useContext(ToastContext)
}

const typeStyles: Record<ToastType, string> = {
  success: 'border-[var(--eco-mint)]/20 bg-[var(--eco-mint-soft)]',
  error: 'border-[var(--eco-coral)]/20 bg-[var(--eco-coral-soft)]',
  info: 'border-[var(--eco-sky)]/20 bg-[var(--eco-sky-soft)]',
}

const typeTextStyles: Record<ToastType, string> = {
  success: 'text-[var(--eco-mint)]',
  error: 'text-[var(--eco-coral)]',
  info: 'text-[var(--eco-sky)]',
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])

  const addToast = useCallback((message: string, type: ToastType = 'info', durationMs?: number) => {
    const id = crypto.randomUUID()
    setToasts((prev) => [...prev, { id, message, type, durationMs }])
  }, [])

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  return (
    <ToastContext.Provider value={{ toast: addToast }}>
      {children}
      {/* Toast container. `w-80` matches the @eco/ui viewport this shadows —
          without a cap a long notice (the retired-model one) stretches into a
          single ~980px line. `right-[4.75rem]` keeps the stack clear of the
          chat surface's floating help button, which owns the 68px lane at the
          right edge; the width cap keeps that offset from overflowing on a
          375px screen. */}
      <div className="fixed bottom-4 right-[4.75rem] z-[100] flex w-80 max-w-[calc(100vw-6rem)] flex-col gap-2">
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} onDismiss={removeToast} />
        ))}
      </div>
    </ToastContext.Provider>
  )
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: (id: string) => void }) {
  const [isExiting, setIsExiting] = useState(false)

  useEffect(() => {
    const timer = setTimeout(() => {
      setIsExiting(true)
      setTimeout(() => onDismiss(toast.id), 200)
    }, toast.durationMs ?? 3000)
    return () => clearTimeout(timer)
  }, [toast.id, toast.durationMs, onDismiss])

  return (
    <div
      className={`flex items-center gap-2 rounded-xl border px-4 py-3 text-sm shadow-lg backdrop-blur-sm transition-all duration-200 ${typeStyles[toast.type]} ${
        isExiting ? 'translate-y-2 opacity-0' : 'translate-y-0 opacity-100'
      }`}
      style={{ animation: 'message-in 0.2s ease-out' }}
      role="alert"
    >
      {toast.type === 'error' && (
        // A small sprout — even when something fails, Eco stays calm and growing.
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.25"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className={`h-3.5 w-3.5 shrink-0 ${typeTextStyles[toast.type]}`}
        >
          <path d="M8 14V7" />
          <path d="M8 9C6 9 4.5 7.5 4.5 5.5C6.5 5.5 8 7 8 9Z" fill="currentColor" stroke="none" opacity="0.85" />
          <path d="M8 7.5C10 7.5 11.5 6 11.5 4C9.5 4 8 5.5 8 7.5Z" fill="currentColor" stroke="none" opacity="0.85" />
        </svg>
      )}
      <span className={typeTextStyles[toast.type]}>{toast.message}</span>
      <button
        type="button"
        onClick={() => {
          setIsExiting(true)
          setTimeout(() => onDismiss(toast.id), 200)
        }}
        className="ml-2 shrink-0 self-start text-[var(--eco-text-secondary)] hover:text-[var(--eco-text)]"
        aria-label="Dismiss"
      >
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="h-3.5 w-3.5">
          <path d="M5.28 4.22a.75.75 0 0 0-1.06 1.06L6.94 8l-2.72 2.72a.75.75 0 1 0 1.06 1.06L8 9.06l2.72 2.72a.75.75 0 1 0 1.06-1.06L9.06 8l2.72-2.72a.75.75 0 0 0-1.06-1.06L8 6.94 5.28 4.22Z" />
        </svg>
      </button>
    </div>
  )
}
