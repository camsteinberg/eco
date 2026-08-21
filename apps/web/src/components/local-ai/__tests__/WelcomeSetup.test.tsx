// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { WelcomeSetup } from '../WelcomeSetup';

describe('WelcomeSetup', () => {
  it('renders Eco wordmark + subtitle', () => {
    render(<WelcomeSetup phase="downloading" percent={20} etaSeconds={90} reassuranceIndex={0} />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/Eco/);
    expect(screen.getByText(/Your private AI, on your device/i)).toBeInTheDocument();
  });

  it('shows a calm status + a determinate progress bar while downloading (no ticking countdown)', () => {
    render(<WelcomeSetup phase="downloading" percent={30} etaSeconds={60} reassuranceIndex={0} />);
    expect(screen.getByText(/getting your private ai ready/i)).toBeInTheDocument();
    // The bar is bound to real download progress, not a per-second estimate.
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '30');
    // The inaccurate second-countdown is gone.
    expect(screen.queryByText(/\bseconds\b/i)).toBeNull();
  });

  it('shows "Almost ready" copy at high percent', () => {
    render(<WelcomeSetup phase="downloading" percent={90} etaSeconds={5} reassuranceIndex={0} />);
    expect(screen.getByText(/almost ready/i)).toBeInTheDocument();
  });

  it('shows honest first-wake copy in the smoke phase (cold load can take a minute)', () => {
    render(<WelcomeSetup phase="smoke" percent={95} etaSeconds={5} reassuranceIndex={0} />);
    expect(screen.getByText(/waking up your ai/i)).toBeInTheDocument();
    expect(screen.getByText(/one-time step can take a minute/i)).toBeInTheDocument();
  });

  it('shows a mid-download beat once past the opening stretch (no percent readout)', () => {
    render(<WelcomeSetup phase="downloading" percent={60} etaSeconds={40} reassuranceIndex={0} />);
    expect(screen.getByText(/onto your device/i)).toBeInTheDocument();
    // Still a phase label, never a raw percentage.
    expect(screen.queryByText(/60%/)).toBeNull();
  });

  it('shows the finding-fit copy when demoting during download', () => {
    render(<WelcomeSetup phase="downloading" percent={20} etaSeconds={30} reassuranceIndex={0} findingFit />);
    expect(screen.getByText(/finding the best fit for your device/i)).toBeInTheDocument();
  });

  it('frames a resumed download as finishing, not first-run setup', () => {
    render(<WelcomeSetup phase="downloading" percent={40} etaSeconds={30} reassuranceIndex={0} resuming />);
    expect(screen.getByText(/finishing your model download/i)).toBeInTheDocument();
    // Not the first-run copy — this is an interrupted download picking back up.
    expect(screen.queryByText(/getting your private ai ready/i)).toBeNull();
  });

  it('rotates reassurance copy across the process/warmth mix', () => {
    const { rerender } = render(
      <WelcomeSetup phase="downloading" percent={30} etaSeconds={60} reassuranceIndex={0} />,
    );
    // Index 0 is the load-bearing first impression: it names what the wait is
    // for, in concrete terms — not a slogan.
    expect(screen.getByText(/downloading your ai so it never has to leave/i)).toBeInTheDocument();
    rerender(<WelcomeSetup phase="downloading" percent={30} etaSeconds={60} reassuranceIndex={1} />);
    expect(screen.getByText(/saves into this browser/i)).toBeInTheDocument();
    rerender(<WelcomeSetup phase="downloading" percent={30} etaSeconds={60} reassuranceIndex={4} />);
    expect(screen.getByText(/supporters chip in/i)).toBeInTheDocument();
  });

  // "Your AI, your trust"-shaped slogans read as filler, not reassurance — the
  // rotation carries concrete lines only. This keeps the cut line from
  // drifting back in.
  it('does not carry the open-source slogan line in the rotation', () => {
    for (let index = 0; index < 5; index += 1) {
      const { unmount } = render(
        <WelcomeSetup phase="downloading" percent={30} etaSeconds={60} reassuranceIndex={index} />,
      );
      expect(screen.queryByText(/open source/i)).toBeNull();
      unmount();
    }
  });

  // The three-pillar row directly above already states that chats stay on this
  // device. Rotation lines that only restate it spend a slot saying nothing new,
  // so they were dropped — this keeps them from drifting back in.
  it('does not restate the Private pillar verbatim in the rotation', () => {
    for (let index = 0; index < 5; index += 1) {
      const { unmount } = render(
        <WelcomeSetup phase="downloading" percent={30} etaSeconds={60} reassuranceIndex={index} />,
      );
      const card = screen.getByLabelText('Reassurance message');
      expect(card).not.toHaveTextContent(/^Your conversations run on your device\.$/);
      expect(card).not.toHaveTextContent(/^Your chats stay on this device, not our servers\.$/);
      unmount();
    }
  });

  it('shows a progress bar but no raw bytes/percent/speed text', () => {
    render(<WelcomeSetup phase="downloading" percent={30} etaSeconds={60} reassuranceIndex={0} />);
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
    expect(screen.queryByText(/KB\/s|MB\/s|\/s/i)).toBeNull();
    expect(screen.queryByText(/30%/)).toBeNull();
  });

  // Finding E / Every-Device Phase 0: on a WASM/CPU-only device the one loadable
  // model is our smallest and its first load runs on the slower CPU path. The
  // copy names the lighter model up front instead of the standard first-load
  // line — honest expectation-setting, not a mid-setup downgrade surprise.
  it('sets an honest "lighter model" expectation in the smoke phase on a WASM device', () => {
    render(
      <WelcomeSetup phase="smoke" percent={95} etaSeconds={5} reassuranceIndex={0} lightweightDevice />,
    );
    expect(screen.getByText(/lighter model/i)).toBeInTheDocument();
    expect(screen.getByText(/minute or two/i)).toBeInTheDocument();
    // The standard first-wake line should NOT show on the lightweight device.
    expect(screen.queryByText(/the first time can take a minute$/i)).toBeNull();
  });

  it('names the lighter model in the download fallback copy on a WASM device', () => {
    render(
      <WelcomeSetup phase="downloading" percent={10} etaSeconds={0} reassuranceIndex={0} lightweightDevice />,
    );
    expect(screen.getByText(/lighter ai that runs smoothly on this device/i)).toBeInTheDocument();
  });

  it('keeps the standard copy on a WebGPU device (lightweightDevice defaults off)', () => {
    render(<WelcomeSetup phase="smoke" percent={95} etaSeconds={5} reassuranceIndex={0} />);
    expect(screen.getByText(/one-time step can take a minute/i)).toBeInTheDocument();
    expect(screen.queryByText(/lighter model/i)).toBeNull();
  });

  // Locks the CSS contract for the cookie-banner clearance (F3): globals.css
  // reserves bottom space on [data-eco-setup-surface] while the notice is up, so
  // the mobile banner can't float over the reassurance card. A refactor that
  // drops the hook would silently reopen the occlusion — this catches it.
  it('marks the root surface so the cookie notice can reserve clearance', () => {
    render(<WelcomeSetup phase="downloading" percent={20} etaSeconds={90} reassuranceIndex={0} />);
    expect(screen.getByRole('main')).toHaveAttribute('data-eco-setup-surface');
  });

  // The setup surface is a single calm column: no composer ghost while the
  // model isn't usable yet. A disabled input read as broken, not as promise —
  // the real composer arrives with the real chat surface.
  it('renders no composer while setting up', () => {
    render(<WelcomeSetup phase="downloading" percent={20} etaSeconds={90} reassuranceIndex={0} />);
    expect(screen.queryByPlaceholderText(/getting ready on this device/i)).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
  });
});
