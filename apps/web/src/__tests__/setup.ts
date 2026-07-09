// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import "fake-indexeddb/auto";
import "@testing-library/jest-dom";
import { beforeEach } from "vitest";

// jsdom's localStorage is incomplete (missing .clear in some versions).
// Provide a spec-compliant in-memory Storage so tests can call clear().
function createStorage(): Storage {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => (key in store ? store[key]! : null),
    setItem: (key: string, value: string) => {
      store[key] = String(value);
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      store = {};
    },
    get length() {
      return Object.keys(store).length;
    },
    key: (index: number) => Object.keys(store)[index] ?? null,
  };
}

Object.defineProperty(globalThis, "localStorage", {
  value: createStorage(),
  writable: true,
  configurable: true,
});

// jsdom does not implement ResizeObserver. Provide a no-op stub so that
// components using ResizeObserver (e.g. CodeBlock scroll indicators) can render.
if (typeof globalThis.ResizeObserver === "undefined") {
  class MockResizeObserver implements ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.defineProperty(globalThis, "ResizeObserver", {
    value: MockResizeObserver,
    writable: true,
    configurable: true,
  });
}

// jsdom does not implement IntersectionObserver. Provide a no-op stub so that
// components using useScrollReveal (or any IntersectionObserver) can render in tests.
if (typeof globalThis.IntersectionObserver === "undefined") {
  class MockIntersectionObserver implements IntersectionObserver {
    readonly root: Element | Document | null = null;
    readonly rootMargin: string = "";
    readonly thresholds: ReadonlyArray<number> = [];
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  }
  Object.defineProperty(globalThis, "IntersectionObserver", {
    value: MockIntersectionObserver,
    writable: true,
    configurable: true,
  });
}

// jsdom does not implement matchMedia. Provide a stub so that useMediaQuery works.
// Guarded for the `node` test environment (no `window`), like the stubs above.
if (typeof window !== "undefined" && typeof window.matchMedia === "undefined") {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

beforeEach(() => {
  localStorage.clear();
});
