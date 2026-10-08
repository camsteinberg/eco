// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// Drive the gate from a controlled setup hook and assert only the gate's own
// job on a load-interrupted error: record the person's answer, then re-run
// setup — the runner reads the answer from the breaker's record.
const { useLocalAiSetupMock, answerLoadKillsMock } = vi.hoisted(() => ({
  useLocalAiSetupMock: vi.fn(),
  answerLoadKillsMock: vi.fn(),
}));
vi.mock('../../../hooks/local-ai/useLocalAiSetup', () => ({ useLocalAiSetup: useLocalAiSetupMock }));
vi.mock('../../../hooks/local-ai/useDeviceProfile', () => ({
  useDeviceProfile: () => ({ webgpuSupport: 'webgpu' }),
}));
vi.mock('../../../local-ai/runtime/load-breaker', () => ({ answerLoadKills: answerLoadKillsMock }));
vi.mock('../../../local-ai/diagnostics/capture', () => ({
  exportDiagnostics: vi.fn(async () => '{"entries":[]}'),
}));

import { LocalAiSetupGate } from '../LocalAiSetupGate';

function mockSetup(loadInterrupted: Record<string, unknown> | null) {
  const reset = vi.fn();
  const start = vi.fn(async () => {});
  useLocalAiSetupMock.mockReturnValue({
    status: 'error',
    errorReason: 'load interrupted',
    errorReasonCode: 'load-interrupted',
    errorExhausted: false,
    errorTriedModelCount: 0,
    errorLoadInterrupted: loadInterrupted,
    start,
    choose: vi.fn(),
    actions: { reset },
  });
  return { reset, start };
}

beforeEach(() => {
  useLocalAiSetupMock.mockReset();
  answerLoadKillsMock.mockReset();
});

describe('LocalAiSetupGate — load interrupted', () => {
  it('Try again records a retry, then re-runs setup', () => {
    const { reset, start } = mockSetup({ modelName: 'Eco Big', alternative: { kind: 'lighter', modelName: 'Eco Small' } });
    render(<LocalAiSetupGate><div>chat</div></LocalAiSetupGate>);
    fireEvent.click(screen.getByRole('button', { name: /try setting up eco again/i }));
    expect(answerLoadKillsMock).toHaveBeenCalledWith('retry');
    expect(reset).toHaveBeenCalled();
    expect(start).toHaveBeenCalled();
  });

  it('Use a lighter model records a step-down, then re-runs setup', () => {
    const { start } = mockSetup({ modelName: 'Eco Big', alternative: { kind: 'lighter', modelName: 'Eco Small' } });
    render(<LocalAiSetupGate><div>chat</div></LocalAiSetupGate>);
    fireEvent.click(screen.getByRole('button', { name: 'Use a lighter model' }));
    expect(answerLoadKillsMock).toHaveBeenCalledWith('step-down');
    expect(start).toHaveBeenCalled();
  });

  it('Go back records a roll-back', () => {
    mockSetup({ modelName: 'Eco Big', alternative: { kind: 'roll-back', modelName: 'Eco Previous' } });
    render(<LocalAiSetupGate><div>chat</div></LocalAiSetupGate>);
    fireEvent.click(screen.getByRole('button', { name: 'Go back to Eco Previous' }));
    expect(answerLoadKillsMock).toHaveBeenCalledWith('roll-back');
  });

  it('never renders the chat behind the question', () => {
    mockSetup({ modelName: 'Eco Big' });
    render(<LocalAiSetupGate><div>chat</div></LocalAiSetupGate>);
    expect(screen.queryByText('chat')).not.toBeInTheDocument();
  });
});
