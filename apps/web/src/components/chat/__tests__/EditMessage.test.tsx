// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { EditMessage } from "../EditMessage";

describe("EditMessage", () => {
  it("renders textarea pre-filled with content", () => {
    render(
      <EditMessage
        content="Original message"
        onSave={() => {}}
        onCancel={() => {}}
      />
    );
    const textarea = screen.getByRole("textbox");
    expect(textarea).toHaveValue("Original message");
  });

  it("Save & Submit button disabled when content unchanged", () => {
    render(
      <EditMessage
        content="Original message"
        onSave={() => {}}
        onCancel={() => {}}
      />
    );
    const saveBtn = screen.getByRole("button", { name: /save/i });
    expect(saveBtn).toBeDisabled();
  });

  it("Save & Submit button disabled when content is empty", async () => {
    const user = userEvent.setup();
    render(
      <EditMessage
        content="Original message"
        onSave={() => {}}
        onCancel={() => {}}
      />
    );
    const textarea = screen.getByRole("textbox");
    await user.clear(textarea);
    const saveBtn = screen.getByRole("button", { name: /save/i });
    expect(saveBtn).toBeDisabled();
  });

  it("Save & Submit button enabled when content is changed", async () => {
    const user = userEvent.setup();
    render(
      <EditMessage
        content="Original message"
        onSave={() => {}}
        onCancel={() => {}}
      />
    );
    const textarea = screen.getByRole("textbox");
    await user.clear(textarea);
    await user.type(textarea, "New message");
    const saveBtn = screen.getByRole("button", { name: /save/i });
    expect(saveBtn).toBeEnabled();
  });

  it("clicking Save calls onSave with trimmed content", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(
      <EditMessage
        content="Original message"
        onSave={onSave}
        onCancel={() => {}}
      />
    );
    const textarea = screen.getByRole("textbox");
    await user.clear(textarea);
    await user.type(textarea, "  New message  ");
    await user.click(screen.getByRole("button", { name: /save/i }));
    expect(onSave).toHaveBeenCalledWith("New message");
  });

  it("clicking Cancel calls onCancel", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(
      <EditMessage
        content="Original message"
        onSave={() => {}}
        onCancel={onCancel}
      />
    );
    await user.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("pressing Escape calls onCancel", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(
      <EditMessage
        content="Original message"
        onSave={() => {}}
        onCancel={onCancel}
      />
    );
    await user.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
