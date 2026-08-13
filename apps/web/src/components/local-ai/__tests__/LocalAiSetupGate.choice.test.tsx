// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// Drive the gate purely from a controlled setup hook — the real setup pipeline
// (bootstrap / WebGPU probe / download) is browser-coupled, so we assert only
// the gate's own job: on 'awaiting-choice' it renders the welcome card from the
// offer and forwards the user's pick to choose().
const { useLocalAiSetupMock } = vi.hoisted(() => ({ useLocalAiSetupMock: vi.fn() }));
vi.mock('../../../hooks/local-ai/useLocalAiSetup', () => ({ useLocalAiSetup: useLocalAiSetupMock }));
vi.mock('../../../hooks/local-ai/useDeviceProfile', () => ({
  useDeviceProfile: () => ({ webgpuSupport: 'webgpu' }),
}));

import { LocalAiSetupGate } from '../LocalAiSetupGate';
import type { ModelConfig } from '../../../local-ai/types';

const modelConfig = (id: string, sizeGB: number): ModelConfig =>
  ({
    id,
    friendlyName: id,
    vendor: 'Liquid AI',
    sizeGB,
    runtime: 'transformers',
    format: 'onnx-q4f16',
    capabilities: { intent: ['balanced'], tasks: ['chat'], contextTokens: 4096 },
    bestFor: '',
    knownLimitation: '',
    evidenceTier: 'proven',
  }) as ModelConfig;

const FAST = modelConfig('candidate/lfm2.5-1.2b-instruct-onnx', 0.76);
const DEEPER = modelConfig('candidate/lfm2-2.6b-onnx', 1.65);

function mockSetup(over: Record<string, unknown> = {}) {
  useLocalAiSetupMock.mockReturnValue({
    status: 'awaiting-choice',
    choiceOffer: { models: [FAST, DEEPER], recommendedId: DEEPER.id },
    start: vi.fn(async () => {}),
    choose: vi.fn(),
    actions: { reset: vi.fn() },
    ...over,
  } as unknown as ReturnType<typeof import('../../../hooks/local-ai/useLocalAiSetup').useLocalAiSetup>);
}

beforeEach(() => {
  useLocalAiSetupMock.mockReset();
});

describe('LocalAiSetupGate — awaiting-choice', () => {
  it('renders the welcome card from the offer, not the chat children', () => {
    mockSetup();
    render(
      <LocalAiSetupGate>
        <div>chat surface</div>
      </LocalAiSetupGate>,
    );

    expect(screen.getByText('Welcome to Eco')).toBeInTheDocument();
    expect(screen.getByText('Eco Fast')).toBeInTheDocument();
    expect(screen.getByText('Eco Deeper')).toBeInTheDocument();
    expect(screen.getByText(/Recommended/)).toBeInTheDocument();
    // Chat is gated until a model is ready.
    expect(screen.queryByText('chat surface')).not.toBeInTheDocument();
  });

  it('forwards the recommended pick to choose() when the CTA is pressed', () => {
    const choose = vi.fn();
    mockSetup({ choose });
    render(
      <LocalAiSetupGate>
        <div>chat surface</div>
      </LocalAiSetupGate>,
    );

    // Recommended (Eco Deeper) is preselected — the CTA commits it.
    fireEvent.click(screen.getByRole('button', { name: /Start with Eco Deeper/i }));
    expect(choose).toHaveBeenCalledWith(DEEPER.id);
  });

  it('lets the user switch to Eco Fast before committing', () => {
    const choose = vi.fn();
    mockSetup({ choose });
    render(
      <LocalAiSetupGate>
        <div>chat surface</div>
      </LocalAiSetupGate>,
    );

    fireEvent.click(screen.getByRole('radio', { name: /Eco Fast/i }));
    fireEvent.click(screen.getByRole('button', { name: /Start with Eco Fast/i }));
    expect(choose).toHaveBeenCalledWith(FAST.id);
  });
});
