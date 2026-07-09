// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { CookieBannerWrapper } from "../CookieBannerWrapper";

describe("CookieBannerWrapper", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("renders the cookie banner from the root layout without requiring a dynamic client-only loader", () => {
    render(<CookieBannerWrapper />);

    expect(screen.getByText(/only essential cookies/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /learn more/i })).toHaveAttribute(
      "href",
      "/privacy",
    );
  });
});
