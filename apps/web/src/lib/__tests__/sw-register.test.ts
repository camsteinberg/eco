// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("registerServiceWorker", () => {
  const originalWindow = globalThis.window;
  const originalNavigator = globalThis.navigator;

  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_ENABLE_LOCAL_SW", "true");
    vi.stubEnv("NEXT_PUBLIC_ENABLE_SERVICE_WORKER", "true");
    sessionStorage.clear();
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    // Restore originals
    Object.defineProperty(globalThis, "window", {
      value: originalWindow,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(globalThis, "navigator", {
      value: originalNavigator,
      writable: true,
      configurable: true,
    });
  });

  it("does nothing when window is undefined (SSR)", async () => {
    // Temporarily hide window
    const savedWindow = globalThis.window;
    // @ts-expect-error -- simulating SSR
    delete globalThis.window;

    const { registerServiceWorker } = await import("../sw-register");
    // Should not throw
    expect(() => registerServiceWorker()).not.toThrow();

    Object.defineProperty(globalThis, "window", {
      value: savedWindow,
      writable: true,
      configurable: true,
    });
  });

  it("does nothing when serviceWorker is not in navigator", async () => {
    // Save the real descriptor so we can restore it
    const proto = Object.getPrototypeOf(navigator);
    const descriptor = Object.getOwnPropertyDescriptor(proto, "serviceWorker");

    // Remove serviceWorker entirely so `"serviceWorker" in navigator` is false
    delete (proto as Record<string, unknown>).serviceWorker;

    const addEventListenerSpy = vi.spyOn(window, "addEventListener");

    const { registerServiceWorker } = await import("../sw-register");
    registerServiceWorker();

    expect(addEventListenerSpy).not.toHaveBeenCalled();

    // Restore
    if (descriptor) {
      Object.defineProperty(proto, "serviceWorker", descriptor);
    }
    addEventListenerSpy.mockRestore();
  });

  it("registers /sw.js with scope '/' on load event", async () => {
    const updateMock = vi.fn().mockResolvedValue(undefined);
    const registerMock = vi.fn().mockResolvedValue({ update: updateMock });

    Object.defineProperty(navigator, "serviceWorker", {
      value: { register: registerMock },
      writable: true,
      configurable: true,
    });

    // Capture the load handler
    let loadHandler: (() => void) | undefined;
    vi.spyOn(document, "readyState", "get").mockReturnValue("loading");
    const addEventListenerSpy = vi
      .spyOn(window, "addEventListener")
      .mockImplementation((event: string, handler: unknown) => {
        if (event === "load") {
          loadHandler = handler as () => void;
        }
      });

    const { registerServiceWorker } = await import("../sw-register");
    registerServiceWorker();

    expect(addEventListenerSpy).toHaveBeenCalledWith(
      "load",
      expect.any(Function),
      { once: true }
    );

    // Fire the load handler
    expect(loadHandler).toBeDefined();
    loadHandler!();

    expect(registerMock).toHaveBeenCalledWith("/sw.js", {
      scope: "/",
      updateViaCache: "none",
    });
    await vi.waitFor(() => expect(updateMock).toHaveBeenCalled());

    // Restore
    addEventListenerSpy.mockRestore();
  });

  it("registers immediately when load has already fired", async () => {
    const updateMock = vi.fn().mockResolvedValue(undefined);
    const registerMock = vi.fn().mockResolvedValue({ update: updateMock });

    Object.defineProperty(navigator, "serviceWorker", {
      value: { register: registerMock },
      writable: true,
      configurable: true,
    });

    vi.spyOn(document, "readyState", "get").mockReturnValue("complete");
    const addEventListenerSpy = vi.spyOn(window, "addEventListener");

    const { registerServiceWorker } = await import("../sw-register");
    registerServiceWorker();

    expect(addEventListenerSpy).not.toHaveBeenCalled();
    expect(registerMock).toHaveBeenCalledWith("/sw.js", {
      scope: "/",
      updateViaCache: "none",
    });
    await vi.waitFor(() => expect(updateMock).toHaveBeenCalled());
  });

  it("skips one registration when a reset flow suppresses the next service worker boot", async () => {
    const registerMock = vi.fn().mockResolvedValue({ update: vi.fn() });

    Object.defineProperty(navigator, "serviceWorker", {
      value: { register: registerMock },
      writable: true,
      configurable: true,
    });

    sessionStorage.setItem("eco-skip-sw-registration-once", "true");
    vi.spyOn(document, "readyState", "get").mockReturnValue("complete");

    const { registerServiceWorker } = await import("../sw-register");
    registerServiceWorker();

    expect(registerMock).not.toHaveBeenCalled();
    expect(sessionStorage.getItem("eco-skip-sw-registration-once")).toBeNull();
  });

  it("does not register on loopback unless local service workers are explicitly enabled", async () => {
    vi.stubEnv("NEXT_PUBLIC_ENABLE_LOCAL_SW", "false");
    const unregisterMock = vi.fn().mockResolvedValue(true);
    const registerMock = vi.fn().mockResolvedValue({ update: vi.fn() });
    const getRegistrationsMock = vi.fn().mockResolvedValue([
      { scope: window.location.origin + "/", unregister: unregisterMock },
    ]);

    Object.defineProperty(navigator, "serviceWorker", {
      value: {
        getRegistrations: getRegistrationsMock,
        register: registerMock,
      },
      writable: true,
      configurable: true,
    });

    vi.spyOn(document, "readyState", "get").mockReturnValue("complete");

    const { registerServiceWorker } = await import("../sw-register");
    registerServiceWorker();

    expect(registerMock).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(unregisterMock).toHaveBeenCalled());
  });

  it("unregisters existing service workers by default unless explicitly enabled", async () => {
    vi.stubEnv("NEXT_PUBLIC_ENABLE_SERVICE_WORKER", "false");
    const unregisterMock = vi.fn().mockResolvedValue(true);
    const registerMock = vi.fn().mockResolvedValue({ update: vi.fn() });
    const getRegistrationsMock = vi.fn().mockResolvedValue([
      { scope: window.location.origin + "/", unregister: unregisterMock },
    ]);

    Object.defineProperty(navigator, "serviceWorker", {
      value: {
        getRegistrations: getRegistrationsMock,
        register: registerMock,
      },
      writable: true,
      configurable: true,
    });

    vi.spyOn(document, "readyState", "get").mockReturnValue("complete");

    const { registerServiceWorker } = await import("../sw-register");
    registerServiceWorker();

    expect(registerMock).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(unregisterMock).toHaveBeenCalled());
  });

  it("swallows registration errors silently", async () => {
    const registerMock = vi
      .fn()
      .mockRejectedValue(new Error("SW registration failed"));

    Object.defineProperty(navigator, "serviceWorker", {
      value: { register: registerMock },
      writable: true,
      configurable: true,
    });

    let loadHandler: (() => void) | undefined;
    vi.spyOn(document, "readyState", "get").mockReturnValue("loading");
    vi.spyOn(window, "addEventListener").mockImplementation(
      (event: string, handler: unknown) => {
        if (event === "load") {
          loadHandler = handler as () => void;
        }
      }
    );

    const { registerServiceWorker } = await import("../sw-register");
    registerServiceWorker();

    // Should not throw when load fires with a rejected promise
    expect(loadHandler).toBeDefined();
    await expect(async () => {
      loadHandler!();
      // Give the promise rejection a tick to propagate
      await new Promise((resolve) => setTimeout(resolve, 0));
    }).not.toThrow();
  });
});
