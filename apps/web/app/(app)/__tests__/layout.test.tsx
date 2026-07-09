// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import ProtectedAppLayout from "../layout";

vi.mock("../../../src/components/layout/AppShell", () => ({
  AppShell: ({ children }: { children: ReactNode }) => (
    <div data-testid="app-shell">{children}</div>
  ),
}));

describe("ProtectedAppLayout", () => {
  it("renders app routes inside the shared app shell", () => {
    render(
      <ProtectedAppLayout>
        <div>Protected content</div>
      </ProtectedAppLayout>,
    );

    expect(screen.getByTestId("app-shell")).toBeInTheDocument();
    expect(screen.getByText("Protected content")).toBeInTheDocument();
  });
});
