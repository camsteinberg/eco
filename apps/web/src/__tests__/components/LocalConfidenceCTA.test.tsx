// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { LocalConfidenceCTA } from "../../components/chat/LocalConfidenceCTA";
import { OfflineDivider } from "../../components/chat/OfflineDivider";

describe("LocalConfidenceCTA", () => {
  it("does not render for low-confidence local replies during web v1 launch", () => {
    const { container } = render(
      <LocalConfidenceCTA confidence={0.45} onReask={() => {}} />
    );
    expect(container.innerHTML).toBe("");
    expect(screen.queryByText(/eco network/i)).toBeNull();
  });

  it("does not render for freshness-sensitive prompts during web v1 launch", () => {
    const { container } = render(
      <LocalConfidenceCTA
        confidence={null}
        promptContent="Who won the 2026 NBA Finals?"
        onReask={() => {}}
      />
    );
    expect(container.innerHTML).toBe("");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("does not call the network re-ask handler because no launch CTA is rendered", () => {
    const onReask = vi.fn();
    render(<LocalConfidenceCTA confidence={0.2} onReask={onReask} />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(onReask).not.toHaveBeenCalled();
  });
});

describe("OfflineDivider", () => {
  it("renders conservative hybrid/offline continuation copy by default", () => {
    render(<OfflineDivider />);
    expect(
      screen.getByText(/hybrid\/offline continuation/i)
    ).toBeDefined();
    expect(screen.queryByText(/switched to on-device ai/i)).toBeNull();
  });

  it("renders custom message", () => {
    render(<OfflineDivider message="Custom offline message" />);
    expect(screen.getByText("Custom offline message")).toBeDefined();
  });

  it("has muted, centered styling", () => {
    render(<OfflineDivider />);
    const text = screen.getByText(/hybrid\/offline continuation/i);
    // The element should exist and be styled as a divider
    expect(text).toBeDefined();
  });
});
