// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// ---------------------------------------------------------------------------
// Battery API mock infrastructure
// ---------------------------------------------------------------------------

type BatteryListener = () => void;

class MockBatteryManager {
  level: number;
  charging: boolean;
  private listeners: { levelchange: BatteryListener[]; chargingchange: BatteryListener[] } = {
    levelchange: [],
    chargingchange: [],
  };

  constructor(level = 1, charging = true) {
    this.level = level;
    this.charging = charging;
  }

  addEventListener(event: string, handler: BatteryListener) {
    if (event === 'levelchange') this.listeners.levelchange.push(handler);
    if (event === 'chargingchange') this.listeners.chargingchange.push(handler);
  }

  removeEventListener(event: string, handler: BatteryListener) {
    if (event === 'levelchange') {
      this.listeners.levelchange = this.listeners.levelchange.filter((h) => h !== handler);
    }
    if (event === 'chargingchange') {
      this.listeners.chargingchange = this.listeners.chargingchange.filter((h) => h !== handler);
    }
  }

  setLevel(level: number) {
    this.level = level;
    for (const handler of this.listeners.levelchange) {
      handler();
    }
  }

  setCharging(charging: boolean) {
    this.charging = charging;
    for (const handler of this.listeners.chargingchange) {
      handler();
    }
  }

  getListenerCounts() {
    return {
      levelchange: this.listeners.levelchange.length,
      chargingchange: this.listeners.chargingchange.length,
    };
  }
}

function mockBatteryAPI(battery: MockBatteryManager) {
  Object.defineProperty(navigator, 'getBattery', {
    value: () => Promise.resolve(battery),
    configurable: true,
    writable: true,
  });
}

function removeBatteryAPI() {
  delete (navigator as { getBattery?: unknown }).getBattery;
}

// Mock the inference coordinator to skip Web Locks (unavailable in jsdom)
vi.mock('../../lib/inference-coordinator', () => ({
  InferenceCoordinator: vi.fn().mockImplementation(() => ({
    start: vi.fn().mockResolvedValue(undefined),
    cleanup: vi.fn(),
    role: 'leader' as const,
    broadcastToken: vi.fn(),
    broadcastDone: vi.fn(),
  })),
}));

const originalValidationHarness = process.env.NEXT_PUBLIC_ECO_VALIDATION_HARNESS;

describe('useBatteryAwareness', () => {
  let battery: MockBatteryManager;

  beforeEach(async () => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_ECO_VALIDATION_HARNESS = 'true';
    window.history.replaceState({}, '', '/');
    battery = new MockBatteryManager(1.0, true);
    mockBatteryAPI(battery);
  });

  afterEach(() => {
    if (originalValidationHarness === undefined) {
      delete process.env.NEXT_PUBLIC_ECO_VALIDATION_HARNESS;
    } else {
      process.env.NEXT_PUBLIC_ECO_VALIDATION_HARNESS = originalValidationHarness;
    }
    window.history.replaceState({}, '', '/');
    removeBatteryAPI();
    vi.restoreAllMocks();
  });

  it('returns { level, charging, restriction } shape', async () => {
    const { useBatteryAwareness } = await import('../../hooks/useBatteryAwareness');
    const { result } = renderHook(() => useBatteryAwareness());

    // Wait for async battery detection
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(result.current).toHaveProperty('level');
    expect(result.current).toHaveProperty('charging');
    expect(result.current).toHaveProperty('restriction');
  });

  it('level 0.25 + not charging -> restriction "none"', async () => {
    battery = new MockBatteryManager(0.25, false);
    mockBatteryAPI(battery);

    const { useBatteryAwareness } = await import('../../hooks/useBatteryAwareness');
    const { result } = renderHook(() => useBatteryAwareness());

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(result.current.level).toBe(0.25);
    expect(result.current.charging).toBe(false);
    expect(result.current.restriction).toBe('none');
  });

  it('can force reduced battery protection through the validation harness', async () => {
    removeBatteryAPI();
    window.history.replaceState({}, '', '/chat?eco-force-protection=battery-reduced');

    const { useBatteryAwareness } = await import('../../hooks/useBatteryAwareness');
    const { result } = renderHook(() => useBatteryAwareness());

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(result.current.level).toBe(0.15);
    expect(result.current.charging).toBe(false);
    expect(result.current.restriction).toBe('reduced');
  });

  it('can force disabled battery protection through the validation harness', async () => {
    removeBatteryAPI();
    window.history.replaceState({}, '', '/chat?eco-force-protection=battery-disabled');

    const { useBatteryAwareness } = await import('../../hooks/useBatteryAwareness');
    const { result } = renderHook(() => useBatteryAwareness());

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(result.current.level).toBe(0.05);
    expect(result.current.charging).toBe(false);
    expect(result.current.restriction).toBe('disabled');
  });

  it('level 0.15 + not charging -> restriction "reduced"', async () => {
    battery = new MockBatteryManager(0.15, false);
    mockBatteryAPI(battery);

    const { useBatteryAwareness } = await import('../../hooks/useBatteryAwareness');
    const { result } = renderHook(() => useBatteryAwareness());

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(result.current.level).toBe(0.15);
    expect(result.current.restriction).toBe('reduced');
  });

  it('level 0.08 + not charging -> restriction "disabled"', async () => {
    battery = new MockBatteryManager(0.08, false);
    mockBatteryAPI(battery);

    const { useBatteryAwareness } = await import('../../hooks/useBatteryAwareness');
    const { result } = renderHook(() => useBatteryAwareness());

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(result.current.level).toBe(0.08);
    expect(result.current.restriction).toBe('disabled');
  });

  it('level 0.08 + charging -> restriction "none" (charging overrides)', async () => {
    battery = new MockBatteryManager(0.08, true);
    mockBatteryAPI(battery);

    const { useBatteryAwareness } = await import('../../hooks/useBatteryAwareness');
    const { result } = renderHook(() => useBatteryAwareness());

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(result.current.level).toBe(0.08);
    expect(result.current.charging).toBe(true);
    expect(result.current.restriction).toBe('none');
  });

  it('returns { level: null, charging: null, restriction: "none" } when Battery API unavailable', async () => {
    removeBatteryAPI();

    const { useBatteryAwareness } = await import('../../hooks/useBatteryAwareness');
    const { result } = renderHook(() => useBatteryAwareness());

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(result.current.level).toBeNull();
    expect(result.current.charging).toBeNull();
    expect(result.current.restriction).toBe('none');
  });

  it('updates returned batteryLevel and batteryCharging on change events', async () => {
    battery = new MockBatteryManager(0.5, false);
    mockBatteryAPI(battery);

    const { useBatteryAwareness } = await import('../../hooks/useBatteryAwareness');
    const { result } = renderHook(() => useBatteryAwareness());

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(result.current.level).toBe(0.5);
    expect(result.current.charging).toBe(false);

    // Simulate battery level change
    act(() => {
      battery.setLevel(0.15);
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(result.current.level).toBe(0.15);
    expect(result.current.restriction).toBe('reduced');
  });

  it('cleanup removes event listeners on unmount', async () => {
    battery = new MockBatteryManager(0.8, false);
    mockBatteryAPI(battery);

    const { useBatteryAwareness } = await import('../../hooks/useBatteryAwareness');
    const { result, unmount } = renderHook(() => useBatteryAwareness());

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(result.current.level).toBe(0.8);

    // Should have listeners registered
    const beforeCounts = battery.getListenerCounts();
    expect(beforeCounts.levelchange).toBeGreaterThan(0);

    unmount();

    // Wait for cleanup
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    const afterCounts = battery.getListenerCounts();
    expect(afterCounts.levelchange).toBe(0);
    expect(afterCounts.chargingchange).toBe(0);
  });

  it('mobile viewport defaults preferredModel to quick tier', async () => {
    // Mock matchMedia to return true for mobile
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      configurable: true,
      value: (query: string) => ({
        matches: query === '(max-width: 768px)',
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }),
    });

    const { useBatteryAwareness } = await import('../../hooks/useBatteryAwareness');
    const { result } = renderHook(() => useBatteryAwareness());

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(result.current.preferredModel).toBe('quick');

    // Restore matchMedia
    Object.defineProperty(window, 'matchMedia', {
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
  });
});

describe('computeRestriction export', () => {
  it('computeRestriction is exported from useBatteryAwareness', async () => {
    const mod = await import('../../hooks/useBatteryAwareness');
    expect(typeof mod.computeRestriction).toBe('function');
  });

  it('computeRestriction(0.05, false) returns "disabled"', async () => {
    const { computeRestriction } = await import('../../hooks/useBatteryAwareness');
    expect(computeRestriction(0.05, false)).toBe('disabled');
  });

  it('computeRestriction(0.15, false) returns "reduced"', async () => {
    const { computeRestriction } = await import('../../hooks/useBatteryAwareness');
    expect(computeRestriction(0.15, false)).toBe('reduced');
  });

  it('computeRestriction(0.8, false) returns "none"', async () => {
    const { computeRestriction } = await import('../../hooks/useBatteryAwareness');
    expect(computeRestriction(0.8, false)).toBe('none');
  });

  it('computeRestriction(0.05, true) returns "none" (charging overrides)', async () => {
    const { computeRestriction } = await import('../../hooks/useBatteryAwareness');
    expect(computeRestriction(0.05, true)).toBe('none');
  });

  it('computeRestriction(null, null) returns "none" (API unavailable)', async () => {
    const { computeRestriction } = await import('../../hooks/useBatteryAwareness');
    expect(computeRestriction(null, null)).toBe('none');
  });
});

describe('getMaxTokensForBattery', () => {
  it('returns full tokens when restriction is "none"', async () => {
    const { getMaxTokensForBattery } = await import('../../hooks/useBatteryAwareness');
    expect(getMaxTokensForBattery(512, 'none')).toBe(512);
  });

  it('returns halved tokens when restriction is "reduced"', async () => {
    const { getMaxTokensForBattery } = await import('../../hooks/useBatteryAwareness');
    expect(getMaxTokensForBattery(512, 'reduced')).toBe(256);
  });

  it('returns 0 when restriction is "disabled"', async () => {
    const { getMaxTokensForBattery } = await import('../../hooks/useBatteryAwareness');
    expect(getMaxTokensForBattery(512, 'disabled')).toBe(0);
  });
});
