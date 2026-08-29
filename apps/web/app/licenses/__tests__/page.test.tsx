// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { describe, expect, it, vi } from "vitest";

// PublicNav/PublicFooter are client components that read the query string.
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/licenses",
}));

import { getCatalog } from "../../../src/local-ai/catalog/catalog";
import LicensesPage from "../page";

describe("LicensesPage", () => {
  it("renders the page heading", () => {
    render(<LicensesPage />);

    expect(
      screen.getByRole("heading", { level: 1, name: /model licenses/i }),
    ).toBeInTheDocument();
  });

  // The page exists to discharge a redistribution obligation, so it is only
  // doing its job if it is driven by the catalog rather than hand-typed. A
  // model that ships without appearing here is the exact failure to catch.
  it("links the upstream repo of every catalog model", () => {
    render(<LicensesPage />);

    const upstreamRepos = new Set(getCatalog().map((m) => m.license.upstreamRepo));
    expect(upstreamRepos.size).toBeGreaterThan(0);

    for (const repo of upstreamRepos) {
      const link = screen.getByRole("link", { name: repo });
      expect(link).toHaveAttribute("href", `https://huggingface.co/${repo}`);
    }
  });

  // Not all the models are open-source licensed. The page must say so, and it
  // must never describe the shipped bundle as if they all were.
  it("shows the commercial-use limit on the models that carry one", () => {
    render(<LicensesPage />);

    const limited = getCatalog().filter((m) => m.license.commercialUseNote);
    expect(limited.length).toBeGreaterThan(0);

    for (const model of limited) {
      const item = screen
        .getByRole("link", { name: model.license.upstreamRepo })
        .closest("li");
      expect(item, model.id).not.toBeNull();
      expect(within(item!).getByText(/Commercial use/)).toBeInTheDocument();
      expect(
        within(item!).getByText(model.license.commercialUseNote!),
      ).toBeInTheDocument();
    }
  });

  // `confirmed: false` means we have NOT verified the publisher's declaration.
  // Saying nothing would imply we had.
  it("flags every unconfirmed license as declared but unconfirmed", () => {
    render(<LicensesPage />);

    const unconfirmed = getCatalog().filter((m) => !m.license.confirmed);
    expect(unconfirmed.length).toBeGreaterThan(0);

    for (const model of unconfirmed) {
      const item = screen
        .getByRole("link", { name: model.license.upstreamRepo })
        .closest("li");
      expect(
        within(item!).getByText(/Declared by the publisher, not yet confirmed\./),
      ).toBeInTheDocument();
    }
  });

  it("scopes the open-source claim to Eco's own code", () => {
    render(<LicensesPage />);

    expect(
      screen.getByText(/Eco's own software is open source under the/),
    ).toBeInTheDocument();
    expect(screen.getByText(/not ours/)).toBeInTheDocument();
  });
});
