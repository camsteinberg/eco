// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { createElement, useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";

// useReducedMotion is read inside the component; expose a mutable flag so a single
// test can flip it without a separate module factory.
const reducedMotion = { value: false };

// Exit lifecycle control for the AnimatePresence mock. When `hold` is true, the
// simulated exit does NOT auto-complete — instead the pending onExitComplete is
// captured in `pending` so a test can fire it manually and prove the flag flips
// ONLY on exit-complete, never synchronously on the dismiss click.
const exitControl: { hold: boolean; pending: (() => void) | undefined } = {
  hold: false,
  pending: undefined,
};

// Render Motion elements as plain DOM, stripping motion-only props so jsdom
// doesn't warn about unknown attributes. Mirrors the CitationBlock test pattern.
vi.mock("motion/react", () => {
  const makeComponent = (tag: string) => {
    const Component = (props: Record<string, unknown>) => {
      const {
        children,
        initial: _i,
        animate: _a,
        exit: _e,
        transition: _t,
        whileHover: _wh,
        whileTap: _wt,
        variants: _v,
        layout: _l,
        ...rest
      } = props;
      return createElement(tag, rest, children as ReactNode);
    };
    Component.displayName = `motion.${tag}`;
    return Component;
  };
  const motion = new Proxy({} as Record<string, unknown>, {
    get: (target, prop: string) => {
      target[prop] ??= makeComponent(prop);
      return target[prop];
    },
  });
  // The real AnimatePresence plays a child's `exit` animation when it is removed,
  // then fires `onExitComplete`. The component under test relies on that callback
  // to flip the global `groundingNoticeSeen` flag (the fix for the dead exit:
  // it dismisses LOCALLY first so the spring can run, and only marks the notice
  // seen once the exit finishes). Our mock can't animate, so we approximate the
  // lifecycle: render children directly, and when they transition from present
  // (a truthy child) to absent (falsy — the component dismissed itself), invoke
  // `onExitComplete` on the next effect to simulate the exit completing.
  const AnimatePresence = ({
    children,
    onExitComplete,
  }: {
    children: ReactNode;
    onExitComplete?: () => void;
  }) => {
    const hadChildren = useRef(false);
    const present = Boolean(children);
    useEffect(() => {
      if (hadChildren.current && !present) {
        // Child went present → absent: the exit has "started". Complete it now,
        // or stash the completion when a test is holding the exit open.
        if (exitControl.hold) {
          exitControl.pending = () => onExitComplete?.();
        } else {
          onExitComplete?.();
        }
      }
      hadChildren.current = present;
    });
    return children;
  };

  return {
    motion,
    AnimatePresence,
    useReducedMotion: () => reducedMotion.value,
  };
});

const setGroundingNoticeSeen = vi.fn();

vi.mock("../../../stores/settingsStore", () => ({
  useSettingsStore: (selector: (s: { setGroundingNoticeSeen: () => void }) => unknown) =>
    selector({ setGroundingNoticeSeen }),
}));

import { GroundingNotice } from "../GroundingNotice";

describe("GroundingNotice", () => {
  beforeEach(() => {
    reducedMotion.value = false;
    exitControl.hold = false;
    exitControl.pending = undefined;
    setGroundingNoticeSeen.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders user-centered disclosure copy (reliable + private, no internal source enumeration)", () => {
    render(<GroundingNotice />);

    const notice = screen.getByTestId("grounding-notice");
    expect(notice).toBeInTheDocument();
    // The copy is written for the user: it conveys (1) the answer came from a real
    // source — not guesswork — and (2) it stayed private. Text is split across
    // elements (the Manage link interrupts it), so match the pieces. Stays accurate,
    // never overclaims (the lookup DID reach the source; only Eco's servers didn't).
    expect(notice).toHaveTextContent(/Eco looked this up from a real source/i);
    expect(notice).toHaveTextContent(/isn.t\s+guesswork/i);
    expect(notice).toHaveTextContent(/straight from your device to the source/i);
    expect(notice).toHaveTextContent(/servers never saw it/i);
    // Principle guard (Cam, 2026-06-13): reassurance microcopy must NOT enumerate
    // our internal source-routing — that's dev-context drift the user doesn't care
    // about. The citation chip above already names the specific source. If a future
    // edit reintroduces "Wikipedia"/"Open-Meteo" into this note, this fails on purpose.
    expect(notice).not.toHaveTextContent(/wikipedia|wikidata|open-meteo/i);
  });

  it("dismiss button marks the notice seen once its exit completes", async () => {
    const user = userEvent.setup();
    render(<GroundingNotice />);

    const dismiss = screen.getByRole("button", { name: "Dismiss" });
    await user.click(dismiss);

    // The notice removes itself locally so the exit can animate; the global flag
    // flips from the mocked AnimatePresence's onExitComplete.
    await waitFor(() => {
      expect(setGroundingNoticeSeen).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByTestId("grounding-notice")).not.toBeInTheDocument();
  });

  it("does NOT mark the notice seen on the dismiss click — only after the exit completes", async () => {
    // Regression guard for the dead-exit bug: previously dismiss flipped the
    // global flag immediately, the parent unmounted the component on the spot,
    // and the exit animation never played. The fix dismisses LOCALLY first so
    // the spring can run, then marks the notice seen via onExitComplete.
    //
    // We hold the exit open so the boundary is observable: after the click the
    // child is gone but the flag must still be 0; only firing the held
    // completion flips it.
    exitControl.hold = true;
    const user = userEvent.setup();
    render(<GroundingNotice />);

    await user.click(screen.getByRole("button", { name: "Dismiss" }));

    // Exit has started (child removed locally) but is held → flag NOT yet flipped.
    await waitFor(() => {
      expect(exitControl.pending).toBeTypeOf("function");
    });
    expect(setGroundingNoticeSeen).not.toHaveBeenCalled();
    expect(screen.queryByTestId("grounding-notice")).not.toBeInTheDocument();

    // Complete the exit → now (and only now) the global flag flips.
    act(() => exitControl.pending?.());
    expect(setGroundingNoticeSeen).toHaveBeenCalledTimes(1);
  });

  it("Manage link points to the Eco settings tab and marks the notice seen directly", async () => {
    const user = userEvent.setup();
    render(<GroundingNotice />);

    const manage = screen.getByRole("link", { name: /manage in settings/i });
    expect(manage).toHaveAttribute("href", "/settings?tab=models");

    // Manage navigates away, so it flips the flag directly (the exit is moot).
    await user.click(manage);
    expect(setGroundingNoticeSeen).toHaveBeenCalledTimes(1);
  });

  it("still renders (and stays dismissible) under reduced motion", async () => {
    reducedMotion.value = true;
    const user = userEvent.setup();
    render(<GroundingNotice />);

    expect(screen.getByTestId("grounding-notice")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Dismiss" }));

    // Reduced motion → instant exit; onExitComplete still fires, so the flag
    // flips and the notice disappears at once.
    await waitFor(() => {
      expect(setGroundingNoticeSeen).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByTestId("grounding-notice")).not.toBeInTheDocument();
  });
});
