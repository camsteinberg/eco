// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SetupErrorState } from '../SetupErrorState';

vi.mock('../../../local-ai/diagnostics/capture', () => ({
  exportDiagnostics: vi.fn(async () => '{"entries":[]}'),
}));

describe('SetupErrorState', () => {
  it('shows honest exhausted copy and does not over-promise "try again"', () => {
    render(
      <SetupErrorState
        reason="We tried a few options..."
        exhausted
        onTryAgain={() => {}}
        onTellUsMore={() => {}}
      />,
    );
    expect(screen.getByText(/tried a few options/i)).toBeInTheDocument();
    expect(screen.queryByText(/trying again usually fixes it/i)).not.toBeInTheDocument();
  });

  it('names the host (not "some devices") when the exhausted failure is network/host-shaped', () => {
    const { container } = render(
      <SetupErrorState
        reason="HTTP 500 fetching https://models.econetwork.ai/qwen3.5-2b/model.onnx"
        exhausted
        onTryAgain={() => {}}
        onTellUsMore={() => {}}
      />,
    );
    expect(screen.getByText(/couldn't reach the model host/i)).toBeInTheDocument();
    // A server failure must not be blamed on the device.
    expect(screen.queryByText(/can happen on some devices/i)).not.toBeInTheDocument();
    // The cookie-notice reservation hook (#255 mechanism) must be present so the
    // mobile banner clears the action row.
    expect(container.querySelector('[data-eco-setup-error-surface]')).not.toBeNull();
  });

  it('keeps the device-neutral exhausted copy when the failure is not network-shaped', () => {
    render(
      <SetupErrorState
        reason="Smoke timed out before any token"
        exhausted
        onTryAgain={() => {}}
        onTellUsMore={() => {}}
      />,
    );
    expect(screen.getByText(/can happen on some devices/i)).toBeInTheDocument();
    expect(screen.queryByText(/couldn't reach the model host/i)).not.toBeInTheDocument();
  });

  it('shows storage-shortage copy (not "try again later") when there is no room', () => {
    render(
      <SetupErrorState
        reason="Eco needs about 2.0 GB of free space for this model, but only about 0.3 GB is available on this device."
        exhausted
        onTryAgain={() => {}}
        onTellUsMore={() => {}}
      />,
    );
    expect(screen.getByText(/needs a little more free space/i)).toBeInTheDocument();
    expect(screen.getByText(/free up some space and try again/i)).toBeInTheDocument();
    // The generic exhausted headline must NOT win over the storage-specific one.
    expect(screen.queryByText(/tried a few options/i)).not.toBeInTheDocument();
  });

  it('copies the diagnostic to the clipboard without any network call', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    render(<SetupErrorState reason="x" onTryAgain={() => {}} onTellUsMore={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: /copy what happened/i }));
    expect(writeText).toHaveBeenCalledWith('{"entries":[]}');
  });
});
