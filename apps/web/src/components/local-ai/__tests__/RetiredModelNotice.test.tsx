// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { afterEach, describe, it, expect } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { ToastProvider } from "../../ui/Toast";
import { RetiredModelNotice } from "../RetiredModelNotice";

const HINT_KEY = "eco-local-ai-retired-notice-v1";
const NOTICE_EVENT = "eco-local-ai-retired-notice";

function renderNotice() {
  return render(
    <ToastProvider>
      <RetiredModelNotice />
    </ToastProvider>,
  );
}

afterEach(() => {
  window.localStorage.clear();
});

describe("RetiredModelNotice", () => {
  it("fires an honest toast naming the retired model and consumes the hint", async () => {
    window.localStorage.setItem(HINT_KEY, JSON.stringify({ label: "SmolLM2", at: Date.now() }));

    renderNotice();

    await waitFor(() =>
      expect(
        screen.getByText(/The on-device model you were using \(SmolLM2\) is no longer offered\./i),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByText(/switched you to its current recommendation for this device/i),
    ).toBeInTheDocument();
    // Hint consumed — a reload does not re-notify.
    expect(window.localStorage.getItem(HINT_KEY)).toBeNull();
  });

  it("fires the toast in the SAME session when the hint is written after mount and announced", async () => {
    // Common boot order: this component mounts before the async self-heal
    // migration runs. The migration writes the hint, then dispatches the
    // window event — the already-mounted listener must pick it up now, not
    // one session later.
    renderNotice();
    await waitFor(() => {
      expect(screen.queryByText(/no longer offered/i)).not.toBeInTheDocument();
    });

    window.localStorage.setItem(HINT_KEY, JSON.stringify({ label: "SmolLM2", at: Date.now() }));
    window.dispatchEvent(new Event(NOTICE_EVENT));

    await waitFor(() =>
      expect(
        screen.getByText(/The on-device model you were using \(SmolLM2\) is no longer offered\./i),
      ).toBeInTheDocument(),
    );
    expect(window.localStorage.getItem(HINT_KEY)).toBeNull();
  });

  it("renders nothing and shows no toast when there is no hint", async () => {
    renderNotice();
    await waitFor(() => {
      // No toast text present.
      expect(screen.queryByText(/no longer offered/i)).not.toBeInTheDocument();
    });
  });

  it("drops a malformed hint without notifying, and removes it", async () => {
    window.localStorage.setItem(HINT_KEY, "{not-json");
    renderNotice();
    await waitFor(() => {
      expect(screen.queryByText(/no longer offered/i)).not.toBeInTheDocument();
    });
    expect(window.localStorage.getItem(HINT_KEY)).toBeNull();
  });

  it("does not notify when the hint has no usable label", async () => {
    window.localStorage.setItem(HINT_KEY, JSON.stringify({ at: Date.now() }));
    renderNotice();
    await waitFor(() => {
      expect(screen.queryByText(/no longer offered/i)).not.toBeInTheDocument();
    });
    expect(window.localStorage.getItem(HINT_KEY)).toBeNull();
  });
});
