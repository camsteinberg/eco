// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalInferenceErrorBoundary } from "../LocalInferenceErrorBoundary";

function ThrowOnRender(): never {
  throw new Error("local runtime crash");
}

describe("LocalInferenceErrorBoundary", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("offers an on-device retry and never references the network", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      <LocalInferenceErrorBoundary localRecoveryAvailable>
        <ThrowOnRender />
      </LocalInferenceErrorBoundary>,
    );

    expect(screen.getByRole("button", { name: /try on-device again/i })).toBeInTheDocument();
    expect(screen.queryByText(/eco network/i)).not.toBeInTheDocument();
    expect(consoleError).toHaveBeenCalled();
  });

  it("clears the error and renders children again when the user retries on-device", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    function Child({ crash }: { crash: boolean }) {
      if (crash) throw new Error("local runtime crash");
      return <div>recovered content</div>;
    }

    const { rerender } = render(
      <LocalInferenceErrorBoundary localRecoveryAvailable>
        <Child crash />
      </LocalInferenceErrorBoundary>,
    );

    const retry = screen.getByRole("button", { name: /try on-device again/i });

    // Swap in a non-throwing child, then dismiss the boundary via the retry CTA.
    rerender(
      <LocalInferenceErrorBoundary localRecoveryAvailable>
        <Child crash={false} />
      </LocalInferenceErrorBoundary>,
    );
    fireEvent.click(retry);

    expect(screen.getByText("recovered content")).toBeInTheDocument();
  });
});
