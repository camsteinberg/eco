// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client"

import { useState, useEffect } from "react"

/**
 * SSR-safe hook that tracks whether a CSS media query matches.
 * Returns `false` on the server and during first render (hydration-safe).
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false)

  useEffect(() => {
    const mql = window.matchMedia(query)
    setMatches(mql.matches)

    function onChange(e: MediaQueryListEvent | { matches: boolean }) {
      setMatches(e.matches)
    }

    mql.addEventListener("change", onChange)
    return () => mql.removeEventListener("change", onChange)
  }, [query])

  return matches
}
