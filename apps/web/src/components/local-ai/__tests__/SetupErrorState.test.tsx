// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SetupErrorState } from '../SetupErrorState';
import { SETUP_EXHAUSTED_REASON } from '../../../local-ai/lifecycle/setup-cascade';

vi.mock('../../../local-ai/diagnostics/capture', () => ({
  exportDiagnostics: vi.fn(async () => '{"entries":[]}'),
}));

describe('SetupErrorState', () => {
  it('shows honest exhausted copy and does not over-promise "try again"', () => {
    render(
      <SetupErrorState
        reason="We tried a few options..."
        exhausted
        triedModelCount={3}
        onTryAgain={() => {}}
        onTellUsMore={() => {}}
      />,
    );
    expect(screen.getByText(/tried a few options/i)).toBeInTheDocument();
    expect(screen.queryByText(/trying again usually fixes it/i)).not.toBeInTheDocument();
  });

  it('does not claim "a few options" when the ladder only had one model to try', () => {
    render(
      <SetupErrorState
        reason="Smoke timed out before any token"
        exhausted
        triedModelCount={1}
        onTryAgain={() => {}}
        onTellUsMore={() => {}}
      />,
    );
    expect(screen.getByText(/couldn't get Eco's model running/i)).toBeInTheDocument();
    expect(screen.queryByText(/tried a few options/i)).not.toBeInTheDocument();
  });

  it('keeps the plural copy when the tried-model count is unknown', () => {
    render(
      <SetupErrorState
        reason="Smoke timed out before any token"
        exhausted
        onTryAgain={() => {}}
        onTellUsMore={() => {}}
      />,
    );
    expect(screen.getByText(/tried a few options/i)).toBeInTheDocument();
  });

  it('keeps storage-shortage copy ahead of either exhausted headline', () => {
    render(
      <SetupErrorState
        reason="Eco needs about 2.0 GB of free space for this model, but only about 0.3 GB is available on this device."
        exhausted
        triedModelCount={1}
        onTryAgain={() => {}}
        onTellUsMore={() => {}}
      />,
    );
    expect(screen.getByText(/needs a little more free space/i)).toBeInTheDocument();
    expect(screen.queryByText(/couldn't get Eco's model running/i)).not.toBeInTheDocument();
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

  // The exhausted path replaces the failure text with the cascade's own copy, so
  // there is nothing network-shaped left in `reason` to sniff. Before the reason
  // code existed, the connectivity subtitle below was unreachable in the shipped
  // app: a hosting failure and a cache-write failure both rendered "This can
  // happen on some devices."
  it('names the host when the exhausted failure is coded network-or-host', () => {
    render(
      <SetupErrorState
        reason={SETUP_EXHAUSTED_REASON}
        reasonCode="network-or-host"
        exhausted
        triedModelCount={3}
        onTryAgain={() => {}}
        onTellUsMore={() => {}}
      />,
    );
    expect(screen.getByText(/couldn't reach the model host/i)).toBeInTheDocument();
    expect(screen.queryByText(/can happen on some devices/i)).not.toBeInTheDocument();
  });

  it('keeps the device-neutral copy for an exhausted failure with no code at all', () => {
    // A cache / OPFS write failure: we genuinely do not know the cause, so the
    // surface must not invent one.
    render(
      <SetupErrorState
        reason={SETUP_EXHAUSTED_REASON}
        exhausted
        triedModelCount={3}
        onTryAgain={() => {}}
        onTellUsMore={() => {}}
      />,
    );
    expect(screen.getByText(/can happen on some devices/i)).toBeInTheDocument();
    expect(screen.queryByText(/couldn't reach the model host/i)).not.toBeInTheDocument();
  });

  it('keeps the storage copy when exhaustion is coded insufficient-storage', () => {
    const storageReason =
      'Eco needs about 2.0 GB of free space for this model, but only about 0.3 GB is available on this device.';
    render(
      <SetupErrorState
        reason={storageReason}
        reasonCode="insufficient-storage"
        exhausted
        triedModelCount={1}
        onTryAgain={() => {}}
        onTellUsMore={() => {}}
      />,
    );
    expect(screen.getByText(/needs a little more free space/i)).toBeInTheDocument();
    expect(screen.getByText(/free up some space and try again/i)).toBeInTheDocument();
    expect(screen.queryByText(/couldn't reach the model host/i)).not.toBeInTheDocument();
  });

  it('lets the code overrule a reason string that merely reads network-shaped', () => {
    // "download" trips the network regex, but the ladder reported a storage
    // shortage. The fact beats the guess.
    render(
      <SetupErrorState
        reason="Eco ran out of free space while setting up this model — it needs about 2.0 GB."
        reasonCode="insufficient-storage"
        exhausted
        onTryAgain={() => {}}
        onTellUsMore={() => {}}
      />,
    );
    expect(screen.getByText(/needs a little more free space/i)).toBeInTheDocument();
  });

  it('copies the diagnostic to the clipboard without any network call', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    render(<SetupErrorState reason="x" onTryAgain={() => {}} onTellUsMore={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: /copy what happened/i }));
    expect(writeText).toHaveBeenCalledWith('{"entries":[]}');
  });
});
