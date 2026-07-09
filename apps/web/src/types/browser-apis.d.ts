// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Type declarations for non-standard browser APIs used in Eco.
 *
 * These augment the global Navigator/Window types so we can avoid
 * `as any` casts when accessing battery status and Gemini Nano APIs.
 */

// ── Battery Status API (Navigator.getBattery) ────────────────────────────────
// Supported in Chromium browsers. Returns a BatteryManager interface.
// https://developer.mozilla.org/en-US/docs/Web/API/Battery_Status_API

interface BatteryManager extends EventTarget {
  readonly charging: boolean;
  readonly chargingTime: number;
  readonly dischargingTime: number;
  readonly level: number;
}

interface Navigator {
  getBattery?(): Promise<BatteryManager>;
  deviceMemory?: number;
  gpu?: {
    requestAdapter(): Promise<GPUAdapter | null>;
  };
  ml?: {
    createContext(options?: { deviceType?: string }): Promise<{
      deviceType?: string;
      [key: string]: unknown;
    }>;
  };
}

interface WorkerNavigator {
  gpu?: {
    requestAdapter(): Promise<GPUAdapter | null>;
  };
}

// ── Chrome LanguageModel API (Gemini Nano) ───────────────────────────────────
// Chrome 138+ exposes a LanguageModel global for built-in AI.
// Older Chrome Dev/Canary used window.ai.languageModel.
// https://developer.chrome.com/docs/ai/built-in

interface LanguageModelStatic {
  availability(): Promise<'available' | 'after-download' | 'no'>;
}

interface WindowAI {
  languageModel?: {
    capabilities(): Promise<{ available?: string }>;
  };
}

// Augment globalThis for both detection paths
// eslint-disable-next-line no-var
declare var LanguageModel: LanguageModelStatic | undefined;

interface Window {
  ai?: WindowAI;
}
