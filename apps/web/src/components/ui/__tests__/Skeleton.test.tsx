// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Skeleton } from "../Skeleton";

describe("Skeleton", () => {
  it("renders with skeleton-shimmer class", () => {
    const { container } = render(<Skeleton />);
    const el = container.firstElementChild;
    expect(el?.className).toContain("skeleton-shimmer");
  });

  it("renders text variant by default (h-4 w-full rounded)", () => {
    const { container } = render(<Skeleton />);
    const el = container.firstElementChild;
    expect(el?.className).toContain("h-4");
    expect(el?.className).toContain("w-full");
    expect(el?.className).toContain("rounded");
  });

  it("renders circular variant (rounded-full)", () => {
    const { container } = render(<Skeleton variant="circular" />);
    const el = container.firstElementChild;
    expect(el?.className).toContain("rounded-full");
  });

  it("renders rectangular variant (rounded-xl)", () => {
    const { container } = render(<Skeleton variant="rectangular" />);
    const el = container.firstElementChild;
    expect(el?.className).toContain("rounded-xl");
  });

  it("applies custom className", () => {
    const { container } = render(<Skeleton className="h-8 w-32" />);
    const el = container.firstElementChild;
    expect(el?.className).toContain("h-8");
    expect(el?.className).toContain("w-32");
  });
});
