// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { BrandedError } from "../BrandedError";

describe("BrandedError", () => {
  it("renders title and description", () => {
    render(
      <BrandedError title="Something broke" description="Please try again later." />
    );
    expect(screen.getByText("Something broke")).toBeInTheDocument();
    expect(screen.getByText("Please try again later.")).toBeInTheDocument();
  });

  it("renders action button when provided", () => {
    const onClick = vi.fn();
    render(
      <BrandedError
        title="Error"
        description="Details"
        action={{ label: "Try again", onClick }}
      />
    );
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("does not render action button when not provided", () => {
    render(<BrandedError title="Error" description="Details" />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("calls onClick when action button is clicked", async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    render(
      <BrandedError
        title="Error"
        description="Details"
        action={{ label: "Retry", onClick }}
      />
    );
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("has role=alert for accessibility", () => {
    render(<BrandedError title="Error" description="Details" />);
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });
});
