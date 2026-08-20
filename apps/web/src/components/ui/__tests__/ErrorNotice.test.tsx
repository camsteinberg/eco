// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { ErrorNotice, ErrorLine } from "../ErrorNotice";

describe("ErrorNotice", () => {
  it("renders lead and detail", () => {
    render(<ErrorNotice lead="Something broke" detail="Please try again later." />);
    expect(screen.getByText("Something broke")).toBeInTheDocument();
    expect(screen.getByText("Please try again later.")).toBeInTheDocument();
  });

  it("has role=alert for accessibility", () => {
    render(<ErrorNotice lead="Error" />);
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("renders actions when provided", () => {
    render(
      <ErrorNotice
        lead="Error"
        actions={<button type="button">Try again</button>}
      />
    );
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("does not render any button when no actions or dismiss given", () => {
    render(<ErrorNotice lead="Error" detail="Details" />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("calls onDismiss when the dismiss button is clicked", async () => {
    const onDismiss = vi.fn();
    const user = userEvent.setup();
    render(<ErrorNotice lead="Error" onDismiss={onDismiss} />);
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

describe("ErrorLine", () => {
  it("renders its message with role=alert", () => {
    render(<ErrorLine>Couldn&apos;t save your name.</ErrorLine>);
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't save your name.");
  });

  it("passes an id through for aria-describedby wiring", () => {
    render(<ErrorLine id="form-error">Bad input</ErrorLine>);
    expect(screen.getByRole("alert")).toHaveAttribute("id", "form-error");
  });
});
