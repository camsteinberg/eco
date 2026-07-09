// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, beforeEach } from "vitest";
import { useChatStore } from "../chatStore";

describe("tool state", () => {
  beforeEach(() => {
    // Reset store to initial state
    useChatStore.setState({
      approvedTools: [],
      activeToolCalls: [],
      localToolNoticeShown: false,
    });
  });

  describe("approveTool", () => {
    it("adds tool name to approvedTools", () => {
      useChatStore.getState().approveTool("calculator");
      expect(useChatStore.getState().approvedTools).toContain("calculator");
    });

    it("does not add duplicate tool names", () => {
      useChatStore.getState().approveTool("calculator");
      useChatStore.getState().approveTool("calculator");
      expect(useChatStore.getState().approvedTools.filter((t) => t === "calculator")).toHaveLength(1);
    });
  });

  describe("addToolCall", () => {
    it("adds a tool call to activeToolCalls", () => {
      useChatStore.getState().addToolCall({
        id: "tc-1",
        type: "tool_start",
        name: "calculator",
        status: "running",
        args: { expression: "2+2" },
      });
      expect(useChatStore.getState().activeToolCalls).toHaveLength(1);
      expect(useChatStore.getState().activeToolCalls[0]!.name).toBe("calculator");
    });
  });

  describe("updateToolCall", () => {
    it("updates status of an existing tool call", () => {
      useChatStore.getState().addToolCall({
        id: "tc-1",
        type: "tool_start",
        name: "calculator",
        status: "running",
      });

      useChatStore.getState().updateToolCall("tc-1", { status: "complete", result: "4" });

      const call = useChatStore.getState().activeToolCalls[0];
      expect(call!.status).toBe("complete");
      expect(call!.result).toBe("4");
    });

    it("does nothing for non-existent id", () => {
      useChatStore.getState().addToolCall({
        id: "tc-1",
        type: "tool_start",
        name: "calculator",
        status: "running",
      });

      useChatStore.getState().updateToolCall("tc-999", { status: "complete" });
      expect(useChatStore.getState().activeToolCalls[0]!.status).toBe("running");
    });
  });

  describe("clearToolState", () => {
    it("resets all tool state to initial values", () => {
      useChatStore.getState().approveTool("calculator");
      useChatStore.getState().addToolCall({
        id: "tc-1",
        type: "tool_start",
        name: "calculator",
        status: "running",
      });
      useChatStore.getState().setLocalToolNoticeShown();

      useChatStore.getState().clearToolState();

      expect(useChatStore.getState().approvedTools).toEqual([]);
      expect(useChatStore.getState().activeToolCalls).toEqual([]);
      expect(useChatStore.getState().localToolNoticeShown).toBe(false);
    });
  });

  describe("setLocalToolNoticeShown", () => {
    it("sets localToolNoticeShown to true", () => {
      expect(useChatStore.getState().localToolNoticeShown).toBe(false);
      useChatStore.getState().setLocalToolNoticeShown();
      expect(useChatStore.getState().localToolNoticeShown).toBe(true);
    });
  });
});
