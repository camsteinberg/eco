// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ImpactFooter } from "../ImpactFooter";

describe("ImpactFooter", () => {
  it("renders empty tour-target wrapper when queryCount is 0", () => {
    const { container } = render(
      <ImpactFooter queryCount={0} onShare={() => {}} />
    );
    // An empty wrapper div exists for tour targeting, but has no visible content
    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper).not.toBeNull();
    expect(wrapper.getAttribute("data-tour-target")).toBe("impact-footer");
    expect(wrapper.children.length).toBe(0);
  });

  it("renders water metric for queryCount > 0", () => {
    render(<ImpactFooter queryCount={1} onShare={() => {}} />);
    expect(screen.getByText(/0\.05 L/)).toBeInTheDocument();
  });

  it("renders energy metric for queryCount > 0", () => {
    render(<ImpactFooter queryCount={1} onShare={() => {}} />);
    expect(screen.getByText(/2\.9 Wh/)).toBeInTheDocument();
  });

  it("renders CO2 metric for queryCount > 0", () => {
    render(<ImpactFooter queryCount={1} onShare={() => {}} />);
    expect(screen.getByText(/1\.08 g/)).toBeInTheDocument();
  });

  it("scales metrics for multiple queries", () => {
    render(<ImpactFooter queryCount={10} onShare={() => {}} />);
    expect(screen.getByText(/0\.50 L/)).toBeInTheDocument();
    expect(screen.getByText(/29\.0 Wh/)).toBeInTheDocument();
    expect(screen.getByText(/10\.80 g/)).toBeInTheDocument();
  });

  it("renders a Share chat button", () => {
    render(<ImpactFooter queryCount={1} onShare={() => {}} />);
    expect(screen.getByRole("button", { name: /share conversation/i })).toBeInTheDocument();
  });

  it("calls onShare when Share chat is clicked", () => {
    const onShare = vi.fn();
    render(<ImpactFooter queryCount={1} onShare={onShare} />);
    fireEvent.click(screen.getByRole("button", { name: /share conversation/i }));
    expect(onShare).toHaveBeenCalledTimes(1);
  });

  it("renders Learn more link to /impact", () => {
    render(<ImpactFooter queryCount={1} onShare={() => {}} />);
    const link = screen.getByRole("link", { name: /learn more/i });
    expect(link).toBeInTheDocument();
    expect(link.getAttribute("href")).toBe("/impact");
  });

  it("links the metrics themselves to /impact (the only link on phones)", () => {
    render(<ImpactFooter queryCount={1} onShare={() => {}} />);
    const link = screen.getByRole("link", { name: /environmental impact of this chat/i });
    expect(link.getAttribute("href")).toBe("/impact");
    expect(link).toHaveTextContent(/0\.05 L/);
    // The strip must say these are estimates — /impact hedges, the footer must too.
    expect(link).toHaveTextContent(/est\./);
  });

  it("has accessible labels", () => {
    render(<ImpactFooter queryCount={1} onShare={() => {}} />);
    expect(screen.getByLabelText(/environmental impact summary/i)).toBeInTheDocument();
  });

  it("does not render runtime-specific footer copy", () => {
    render(<ImpactFooter queryCount={3} onShare={() => {}} />);
    expect(screen.queryByText(/on-device repl/i)).not.toBeInTheDocument();
  });
});
