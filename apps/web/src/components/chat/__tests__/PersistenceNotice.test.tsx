// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * A failed chat save must be visible where the person is typing. The sidebar
 * already shows it, but on a phone the sidebar is a closed bottom sheet, so
 * without this the chat keeps looking saved while nothing is being written.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { PersistenceNotice } from "../PersistenceNotice";
import { useConversationStore } from "../../../stores/conversationStore";

beforeEach(() => {
  useConversationStore.setState({ persistenceError: null });
});

describe("PersistenceNotice", () => {
  it("says nothing while saves succeed", () => {
    render(<PersistenceNotice />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows the store's save failure by the composer", () => {
    useConversationStore.setState({
      persistenceError:
        "Eco updated this conversation in memory, but browser storage could not save conversation history. Try again or export a copy before closing this tab.",
    });
    render(<PersistenceNotice />);
    expect(screen.getByRole("alert")).toHaveTextContent("browser storage could not save conversation history");
  });

  it("dismisses through the same store action the sidebar uses", async () => {
    useConversationStore.setState({ persistenceError: "storage failed" });
    const user = userEvent.setup();
    render(<PersistenceNotice />);
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(useConversationStore.getState().persistenceError).toBeNull();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
