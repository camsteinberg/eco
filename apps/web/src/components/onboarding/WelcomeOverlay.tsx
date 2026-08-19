// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

type WelcomeOverlayProps = {
  onStart: () => void;
  onSkip: () => void;
};

export function WelcomeOverlay({ onStart, onSkip }: WelcomeOverlayProps) {
  return (
    <div
      className="fixed inset-0 z-[10001] flex items-center justify-center"
      style={{ backgroundColor: "var(--eco-scrim)" }}
    >
      <div
        className="mx-4 flex max-w-sm flex-col items-center gap-5 px-8 py-10 text-center"
        style={{
          backgroundColor: "var(--eco-surface-elevated)",
          borderRadius: "var(--eco-radius-lg)",
          boxShadow: "var(--eco-shadow-xl)",
          animation: "welcome-fade-in 0.3s ease-out",
        }}
      >
        {/* Seedling illustration */}
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 48 48"
          fill="none"
          className="h-12 w-12"
          aria-hidden="true"
        >
          <circle
            cx="24"
            cy="24"
            r="22"
            fill="var(--eco-primary-soft)"
          />
          <path
            d="M24 34V24"
            stroke="var(--eco-primary)"
            strokeWidth="2"
            strokeLinecap="round"
          />
          <path
            d="M24 24c0-4-3-7-7-7 0 4 3 7 7 7z"
            fill="var(--eco-primary)"
            opacity="0.7"
          />
          <path
            d="M24 28c0-5 4-9 9-9-1 5-5 9-9 9z"
            fill="var(--eco-primary)"
            opacity="0.5"
          />
        </svg>

        <div className="flex flex-col gap-1.5">
          <h2
            className="font-serif text-2xl font-medium"
            style={{ color: "var(--eco-text)" }}
          >
            Welcome to Eco
          </h2>
          <p
            className="text-sm"
            style={{ color: "var(--eco-text-secondary)" }}
          >
            Private AI, powered by everyone.
          </p>
        </div>

        <div className="flex flex-col gap-2.5 pt-1">
          <button
            type="button"
            onClick={onStart}
            className="cursor-pointer rounded-full px-6 py-2.5 text-sm font-medium text-[var(--eco-on-primary)] transition-colors"
            style={{
              backgroundColor: "var(--eco-primary)",
            }}
          >
            Show me around
          </button>
          <button
            type="button"
            onClick={onSkip}
            className="cursor-pointer rounded-full px-6 py-2 text-sm transition-colors hover:underline"
            style={{ color: "var(--eco-text-secondary)" }}
          >
            Skip
          </button>
        </div>
      </div>
    </div>
  );
}
