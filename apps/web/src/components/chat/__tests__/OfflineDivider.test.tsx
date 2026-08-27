// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { OfflineDivider } from "../OfflineDivider";

describe("OfflineDivider", () => {
  it("says the reply was picked up where it left off, on this device — never that a connection dropped", () => {
    render(<OfflineDivider />);
    const divider = screen.getByRole("separator", {
      name: "Picked up where it left off — on your device",
    });
    expect(divider).toBeInTheDocument();
    // Eco never used a connection for the reply; blaming the network is false.
    expect(screen.queryByText(/connection dropped/i)).toBeNull();
  });
});
