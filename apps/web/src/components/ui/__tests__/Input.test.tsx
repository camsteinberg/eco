// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { Input } from "../Input";

describe("Input", () => {
  it("renders input element with label", () => {
    render(<Input id="email" label="Email" />);
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.getByLabelText("Email").tagName).toBe("INPUT");
  });

  it("renders error message when error prop provided", () => {
    render(<Input id="email" label="Email" error="Invalid email" />);
    expect(screen.getByText("Invalid email")).toBeInTheDocument();
  });

  it("renders help text when helpText prop provided", () => {
    render(<Input id="email" label="Email" helpText="We'll never share your email" />);
    expect(screen.getByText("We'll never share your email")).toBeInTheDocument();
  });

  it("hides help text when error is present", () => {
    render(
      <Input id="email" label="Email" error="Invalid email" helpText="We'll never share your email" />
    );
    expect(screen.getByText("Invalid email")).toBeInTheDocument();
    expect(screen.queryByText("We'll never share your email")).not.toBeInTheDocument();
  });

  it("applies error border styling when error is present", () => {
    render(<Input id="email" label="Email" error="Bad" />);
    const input = screen.getByLabelText("Email");
    expect(input.className).toContain("border-[var(--eco-coral)]");
  });

  it("forwards HTML input attributes", async () => {
    const onChange = vi.fn();
    render(
      <Input
        id="name"
        label="Name"
        placeholder="Enter name"
        type="text"
        required
        onChange={onChange}
      />
    );
    const input = screen.getByLabelText("Name");
    expect(input).toHaveAttribute("placeholder", "Enter name");
    expect(input).toHaveAttribute("type", "text");
    expect(input).toBeRequired();

    const user = userEvent.setup();
    await user.type(input, "a");
    expect(onChange).toHaveBeenCalled();
  });

  it("has transition-all duration-150 ease classes", () => {
    render(<Input id="test" label="Test" />);
    const input = screen.getByLabelText("Test");
    expect(input.className).toContain("transition-all");
    expect(input.className).toContain("duration-150");
  });
});
