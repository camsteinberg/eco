// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Non-blocking service worker registration.
 * Fires on the `load` event so it never delays initial page render.
 */
import { safeStorage } from "./local-storage";

const SUPPRESS_SW_REGISTRATION_KEY = "eco-skip-sw-registration-once";
const CLIENT_RESET_MESSAGE_TYPE = "eco-client-state-reset";
const CLIENT_RESET_ACK_TIMEOUT_MS = 300;
const LOCAL_SW_OPT_IN_KEY = "eco-enable-local-sw";
const SERVICE_WORKER_OPT_IN_KEY = "eco-enable-service-worker";

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.replace(/^\[(.*)\]$/, "$1").toLowerCase();
  return (
    normalized === "localhost"
    || normalized === "127.0.0.1"
    || normalized === "::1"
    || normalized === "0:0:0:0:0:0:0:1"
    || normalized === "::ffff:127.0.0.1"
  );
}

function shouldSkipServiceWorkerRegistration(): boolean {
  if (typeof window === "undefined" || typeof window.sessionStorage === "undefined") {
    return false;
  }

  try {
    if (window.sessionStorage.getItem(SUPPRESS_SW_REGISTRATION_KEY) !== "true") {
      return false;
    }

    window.sessionStorage.removeItem(SUPPRESS_SW_REGISTRATION_KEY);
    return true;
  } catch {
    return false;
  }
}

export function suppressNextServiceWorkerRegistration(): void {
  if (typeof window === "undefined" || typeof window.sessionStorage === "undefined") {
    return;
  }

  try {
    window.sessionStorage.setItem(SUPPRESS_SW_REGISTRATION_KEY, "true");
  } catch {
    // sessionStorage can be unavailable in restricted contexts.
  }
}

export async function requestServiceWorkerClientReset(): Promise<void> {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) {
    return;
  }

  const controller = navigator.serviceWorker.controller;
  if (!controller) {
    return;
  }

  await new Promise<void>((resolve) => {
    const finish = (() => {
      let done = false;
      return () => {
        if (done) {
          return;
        }
        done = true;
        resolve();
      };
    })();

    const timeoutId = window.setTimeout(() => {
      finish();
    }, CLIENT_RESET_ACK_TIMEOUT_MS);

    try {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        window.clearTimeout(timeoutId);
        finish();
      };
      controller.postMessage({ type: CLIENT_RESET_MESSAGE_TYPE }, [channel.port2]);
    } catch {
      window.clearTimeout(timeoutId);
      finish();
    }
  });
}

function localServiceWorkerOptIn(): boolean {
  if (process.env.NEXT_PUBLIC_ENABLE_LOCAL_SW === "true") {
    return true;
  }

  return safeStorage.get(LOCAL_SW_OPT_IN_KEY) === "true";
}

function serviceWorkerOptIn(): boolean {
  if (process.env.NEXT_PUBLIC_ENABLE_SERVICE_WORKER === "true") {
    return true;
  }

  return safeStorage.get(SERVICE_WORKER_OPT_IN_KEY) === "true";
}

function shouldRegisterServiceWorker(): boolean {
  if (process.env.NODE_ENV !== "production") {
    return false;
  }

  if (!serviceWorkerOptIn()) {
    return false;
  }

  if (isLoopbackHost(window.location.hostname) && !localServiceWorkerOptIn()) {
    return false;
  }

  return true;
}

async function unregisterEcoServiceWorkers(): Promise<void> {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) {
    return;
  }

  try {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(
      registrations
        .filter((registration) => registration.scope.startsWith(window.location.origin))
        .map((registration) => registration.unregister()),
    );
  } catch {
    // Non-fatal: the app must continue even if a browser refuses SW access.
  }
}

export function registerServiceWorker() {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
  if (!shouldRegisterServiceWorker()) {
    void unregisterEcoServiceWorkers();
    return;
  }
  if (shouldSkipServiceWorkerRegistration()) return;

  const register = () => {
    navigator.serviceWorker
      .register("/sw.js", { scope: "/", updateViaCache: "none" })
      .then((registration) => registration.update().catch(() => undefined))
      .catch(() => {
        // SW registration failed — non-fatal, app works without it
      });
  };

  if (document.readyState === "complete") {
    register();
    return;
  }

  window.addEventListener("load", register, { once: true });
}
