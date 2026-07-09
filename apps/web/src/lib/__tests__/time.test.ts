// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { timeAgo } from "../time";

const NOW = 1700000000000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("timeAgo", () => {
  it('returns "just now" for timestamps less than 60 seconds ago', () => {
    expect(timeAgo(NOW - 30_000)).toBe("just now");
  });

  it('returns "Nm ago" for timestamps less than 60 minutes ago', () => {
    expect(timeAgo(NOW - 5 * 60_000)).toBe("5m ago");
  });

  it('returns "Nh ago" for timestamps less than 24 hours ago', () => {
    expect(timeAgo(NOW - 3 * 3600_000)).toBe("3h ago");
  });

  it('returns "Nd ago" for timestamps 24+ hours ago', () => {
    expect(timeAgo(NOW - 2 * 86400_000)).toBe("2d ago");
  });

  it('returns "just now" for timestamps exactly 0 seconds ago', () => {
    expect(timeAgo(NOW)).toBe("just now");
  });

  it('returns "1m ago" for timestamps exactly 60 seconds ago', () => {
    expect(timeAgo(NOW - 60_000)).toBe("1m ago");
  });

  it('returns "1h ago" for timestamps exactly 60 minutes ago', () => {
    expect(timeAgo(NOW - 3600_000)).toBe("1h ago");
  });

  it('returns "1d ago" for timestamps exactly 24 hours ago', () => {
    expect(timeAgo(NOW - 86400_000)).toBe("1d ago");
  });
});
