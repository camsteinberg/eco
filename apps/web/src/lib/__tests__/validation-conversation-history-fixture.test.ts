// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { afterEach, describe, expect, it } from "vitest";
import { getActiveBranch, openEcoDB } from "../db";
import {
  clearValidationConversationHistoryFixture,
  installValidationConversationHistoryFixture,
  VALIDATION_CONVERSATION_ASSISTANT_ID,
  VALIDATION_CONVERSATION_FIXTURE_ID,
} from "../validation-conversation-history-fixture";

async function resetFixture() {
  await clearValidationConversationHistoryFixture();
}

describe("validation conversation history fixture", () => {
  afterEach(async () => {
    await resetFixture();
  });

  it("installs a deterministic active assistant branch for /chat browser assertions", async () => {
    const conversation = await installValidationConversationHistoryFixture();

    expect(conversation.id).toBe(VALIDATION_CONVERSATION_FIXTURE_ID);
    expect(conversation.activeLeafId).toBe(VALIDATION_CONVERSATION_ASSISTANT_ID);

    const db = await openEcoDB();
    try {
      const persisted = await db.get("conversations", VALIDATION_CONVERSATION_FIXTURE_ID);
      const branch = await getActiveBranch(
        db,
        VALIDATION_CONVERSATION_FIXTURE_ID,
        VALIDATION_CONVERSATION_ASSISTANT_ID,
      );

      expect(persisted?.title).toBe("Validation conversation history");
      expect(branch.map((message) => message.role)).toEqual(["user", "assistant"]);
      expect(branch.at(-1)).toMatchObject({
        id: VALIDATION_CONVERSATION_ASSISTANT_ID,
        role: "assistant",
        inferenceMethod: "local",
      });
    } finally {
      db.close();
    }
  });

  it("installs a hybrid continuation branch without pure on-device runtime metadata", async () => {
    const conversation = await installValidationConversationHistoryFixture("hybrid-continuation");

    expect(conversation.title).toBe("Validation hybrid continuation");

    const db = await openEcoDB();
    try {
      const branch = await getActiveBranch(
        db,
        VALIDATION_CONVERSATION_FIXTURE_ID,
        VALIDATION_CONVERSATION_ASSISTANT_ID,
      );

      expect(branch.at(-1)).toMatchObject({
        id: VALIDATION_CONVERSATION_ASSISTANT_ID,
        role: "assistant",
        inferenceMethod: "local",
        offlineDivider: true,
      });
    } finally {
      db.close();
    }
  });

  it("clears only the deterministic fixture records", async () => {
    await installValidationConversationHistoryFixture();
    await clearValidationConversationHistoryFixture();

    const db = await openEcoDB();
    try {
      expect(await db.get("conversations", VALIDATION_CONVERSATION_FIXTURE_ID)).toBeUndefined();
      expect(
        await db.getAllFromIndex(
          "messages",
          "by-conversation",
          VALIDATION_CONVERSATION_FIXTURE_ID,
        ),
      ).toEqual([]);
    } finally {
      db.close();
    }
  });
});
