// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// The gate starts setup on its own when it mounts, and again when the person
// presses Try again. Only the click may retry a model that already failed on
// this device (`retryFailed`); the mount must not, so a failed model is never
// reloaded without a click.
const { useLocalAiSetupMock } = vi.hoisted(() => ({ useLocalAiSetupMock: vi.fn() }));
vi.mock('../../../hooks/local-ai/useLocalAiSetup', () => ({ useLocalAiSetup: useLocalAiSetupMock }));
vi.mock('../../../hooks/local-ai/useDeviceProfile', () => ({
  useDeviceProfile: () => ({ webgpuSupport: 'webgpu' }),
}));
vi.mock('../../../local-ai/diagnostics/capture', () => ({
  exportDiagnostics: vi.fn(async () => '{"entries":[]}'),
}));

import { LocalAiSetupGate } from '../LocalAiSetupGate';

function mockExhausted() {
  const reset = vi.fn();
  const start = vi.fn(async (_options?: unknown) => {});
  useLocalAiSetupMock.mockReturnValue({
    status: 'error',
    errorReason: "We couldn't get Eco's model running on this device just yet.",
    errorReasonCode: null,
    errorExhausted: true,
    errorTriedModelCount: 1,
    errorLoadInterrupted: null,
    start,
    choose: vi.fn(),
    actions: { reset },
  });
  return { reset, start };
}

beforeEach(() => {
  useLocalAiSetupMock.mockReset();
});

describe('LocalAiSetupGate — Try again is the click that may retry a failed model', () => {
  it('the mount starts setup without retrying failed models', () => {
    const { start } = mockExhausted();
    render(<LocalAiSetupGate><div>chat</div></LocalAiSetupGate>);
    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0]?.[0]).toBeUndefined();
  });

  it('Try again re-runs setup with retryFailed', () => {
    const { reset, start } = mockExhausted();
    render(<LocalAiSetupGate><div>chat</div></LocalAiSetupGate>);
    fireEvent.click(screen.getByRole('button', { name: /try setting up eco again/i }));
    expect(reset).toHaveBeenCalled();
    expect(start).toHaveBeenLastCalledWith({ retryFailed: true });
  });
});
