// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";

import { StreamInterrupted } from "../StreamInterrupted";

describe("StreamInterrupted", () => {
  it("acknowledges the user's own Stop when the reason is user-stop", () => {
    render(<StreamInterrupted onRetry={() => {}} reason="user-stop" />);
    expect(screen.getByRole("status")).toHaveTextContent("You stopped this reply.");
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
  });

  it("uses neutral, on-device phrasing for a fault (no network metaphor)", () => {
    render(<StreamInterrupted onRetry={() => {}} reason="fault" />);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("This reply didn’t finish.");
    expect(status.textContent ?? "").not.toMatch(/connection/i);
  });

  it("uses the same neutral phrasing for a crash/reload-restored reply", () => {
    render(<StreamInterrupted onRetry={() => {}} reason="restore-detected" />);
    expect(screen.getByRole("status")).toHaveTextContent("This reply didn’t finish.");
  });

  it("falls back to neutral phrasing (never 'you stopped') when the reason is unknown", () => {
    render(<StreamInterrupted onRetry={() => {}} />);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("This reply didn’t finish.");
    expect(status.textContent ?? "").not.toMatch(/you stopped/i);
    // The old wrong-actor / network-metaphor copy is gone.
    expect(status.textContent ?? "").not.toMatch(/lost the connection/i);
  });

  it("calls onRetry when Try again is clicked", async () => {
    const onRetry = vi.fn();
    const user = userEvent.setup();
    render(<StreamInterrupted onRetry={onRetry} reason="user-stop" />);
    await user.click(screen.getByRole("button", { name: /try again/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
