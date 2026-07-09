// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

import { useThemeStore } from "../../stores/themeStore";

export function ThemeToggle() {
  const resolved = useThemeStore((s) => s.resolved);
  const toggle = useThemeStore((s) => s.toggle);

  const isDark = resolved === "dark";
  const label = isDark ? "Switch to light mode" : "Switch to dark mode";

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={label}
      className="cursor-pointer rounded-lg p-2 min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0 flex items-center justify-center text-[var(--eco-text-secondary)] transition-colors hover:bg-[var(--eco-primary-soft)]"
    >
      {isDark ? (
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5" aria-hidden="true">
          <path d="M10 2a.75.75 0 01.75.75v1.5a.75.75 0 01-1.5 0v-1.5A.75.75 0 0110 2zm0 13a.75.75 0 01.75.75v1.5a.75.75 0 01-1.5 0v-1.5A.75.75 0 0110 15zm8-5a.75.75 0 01-.75.75h-1.5a.75.75 0 010-1.5h1.5A.75.75 0 0118 10zM5 10a.75.75 0 01-.75.75h-1.5a.75.75 0 010-1.5h1.5A.75.75 0 015 10zm11.95-4.95a.75.75 0 010 1.06l-1.06 1.06a.75.75 0 01-1.06-1.06l1.06-1.06a.75.75 0 011.06 0zm-12.73 8.73a.75.75 0 010 1.06l-1.06 1.06a.75.75 0 01-1.06-1.06l1.06-1.06a.75.75 0 011.06 0zm12.73 0a.75.75 0 01-1.06 1.06l-1.06-1.06a.75.75 0 011.06-1.06l1.06 1.06zM5.11 6.17a.75.75 0 01-1.06 0L2.99 5.11a.75.75 0 011.06-1.06l1.06 1.06a.75.75 0 010 1.06zM10 6a4 4 0 100 8 4 4 0 000-8z" />
        </svg>
      ) : (
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5" aria-hidden="true">
          <path fillRule="evenodd" d="M7.455 2.004a.75.75 0 01.26.77 7 7 0 009.958 7.967.75.75 0 011.067.853A8.5 8.5 0 1110.5 2a8.354 8.354 0 01-2.391.173.75.75 0 01-.654-.169z" clipRule="evenodd" />
        </svg>
      )}
    </button>
  );
}
