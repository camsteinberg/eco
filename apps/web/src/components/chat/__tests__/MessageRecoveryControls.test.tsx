// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * The two recovery controls, in the open.
 *
 * "Just the answer" and "More depth" used to be two of four rows inside a
 * three-dot menu, which meant the reply that went wrong could only be fixed by
 * someone who first guessed that a menu existed. They are now text-labeled
 * buttons in the actions row — the copy IS the affordance, so this file pins
 * the LABELS by exact bytes rather than by a test id.
 *
 * The other half of the design is that a control that cannot deliver is HIDDEN,
 * never disabled: a greyed-out "More depth" still advertises depth the model
 * has no room for. Every hide rule below is derived from the same source the
 * handler consults, so the two cannot drift into disagreeing — a visible button
 * that the handler silently refuses is the exact failure this replaces.
 *
 * What this file does NOT re-derive: the row's reveal behaviour. That cascade
 * is modelled once, in `MessageActionsReachability.test.tsx`. Here the claim is
 * ANCESTRY — the buttons sit inside the toolbar that suite measures and carry no
 * opacity rules of their own — which is what makes them inherit it rather than
 * invent a second, hover-only reveal.
 */

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";

import { MessageBubble } from "../MessageBubble";
import { getCatalog } from "../../../local-ai/catalog/catalog";
import { getGenerationProfile } from "../../../lib/chat-intent";
import { canDeepen, SHORTER_MIN_COMPLETION_TOKENS } from "../../../lib/reply-controls";
import { useChatStore } from "../../../stores/chatStore";

vi.mock("../MarkdownRenderer", () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <span>{content}</span>,
}));

vi.mock("../../EcoLogo", () => ({
  EcoLogo: () => <span data-testid="eco-logo" />,
}));

vi.mock("motion/react", () => {
  const makeComponent = (tag: string) => {
    const Component = (props: Record<string, unknown>) => {
      const {
        children,
        initial: _i,
        animate: _a,
        exit: _e,
        transition: _t,
        whileHover: _wh,
        whileTap: _wt,
        variants: _v,
        layout: _l,
        ...rest
      } = props;
      return React.createElement(tag, rest, children as React.ReactNode);
    };
    Component.displayName = `motion.${tag}`;
    return Component;
  };
  const motion = new Proxy({} as Record<string, unknown>, {
    get: (target, prop: string) => {
      target[prop] ??= makeComponent(prop);
      return target[prop];
    },
  });
  return {
    motion,
    useReducedMotion: () => false,
    AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  };
});

vi.mock("@eco/ui", () => ({
  getTransition: () => ({ duration: 0 }),
}));

// ---------------------------------------------------------------------------
// The shipped labels, and the models discovered from the real profiles
// ---------------------------------------------------------------------------

/**
 * Transcribed, not imported. An assertion that compares the component against
 * its own constant passes through any reword; these are the words a person
 * reads, and changing them is a product decision that should fail here first.
 */
const SHORTER_LABEL = "Just the answer";
const EXPAND_LABEL = "More depth";

const CATALOG_MODEL_IDS: readonly string[] = getCatalog().map((model) => model.id);

/** Discovered from the real generation profiles, never listed by name. */
const LADDER_MODEL_ID = CATALOG_MODEL_IDS.find((id) => canDeepen(id));
const FLAT_MODEL_ID = CATALOG_MODEL_IDS.find((id) => !canDeepen(id));

function renderReply(
  props: Partial<React.ComponentProps<typeof MessageBubble>> = {},
): { onAssistantAction: ReturnType<typeof vi.fn> } {
  const onAssistantAction = vi.fn();
  render(
    <MessageBubble
      role="assistant"
      content="A finished reply."
      status="complete"
      isLatestAssistant
      onAssistantAction={onAssistantAction}
      onRegenerate={vi.fn()}
      {...props}
    />,
  );
  return { onAssistantAction };
}

/** The toolbar root — the element the reachability suite models opacity on. */
function toolbar(): HTMLElement {
  const button = screen.getByRole("button", { name: "More actions" });
  const root = button.closest("div.flex.items-center.gap-1");
  if (root === null) {
    throw new Error("Could not find the MessageActions toolbar root from its menu button.");
  }
  return root as HTMLElement;
}

beforeEach(() => {
  // The open direction is gated on the model a regenerate would run on, so
  // every test states which model that is. A ladder model is the default so
  // both controls are present unless a test deliberately removes one.
  useChatStore.setState({ selectedModel: LADDER_MODEL_ID ?? "auto" });
});

// ---------------------------------------------------------------------------

describe("recovery controls — the instrument", () => {
  it("found a ladder model and a flat model in the real catalog", () => {
    // Without both, every conditional assertion below is vacuous: a missing
    // ladder model would make "More depth renders" untestable and a missing
    // flat model would make "it does not" pass by never being exercised.
    expect(LADDER_MODEL_ID, "no catalog model widens its budget for a deep turn").toBeDefined();
    expect(FLAT_MODEL_ID, "no catalog model has a flat budget ladder").toBeDefined();
  });

  it("the discovered models really do differ in the property the control depends on", () => {
    // Assert the PROFILE, not the helper — otherwise this only proves canDeepen
    // agrees with itself, and a bug that made it always-false would go green.
    const ladderQuick = getGenerationProfile("quick", true, LADDER_MODEL_ID).maxTokens;
    const ladderDeep = getGenerationProfile("deep", true, LADDER_MODEL_ID).maxTokens;
    expect(ladderDeep).toBeGreaterThan(ladderQuick);

    const flatQuick = getGenerationProfile("quick", true, FLAT_MODEL_ID).maxTokens;
    const flatDeep = getGenerationProfile("deep", true, FLAT_MODEL_ID).maxTokens;
    expect(flatDeep).not.toBeGreaterThan(flatQuick);
  });
});

describe("recovery controls — present in the row, with the words on them", () => {
  it("puts both controls in the actions row under their shipped labels", () => {
    renderReply({ localCompletionTokens: SHORTER_MIN_COMPLETION_TOKENS });
    expect(screen.getByRole("button", { name: SHORTER_LABEL })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: EXPAND_LABEL })).toBeInTheDocument();
  });

  it("uses the visible label as the accessible name", () => {
    renderReply();
    for (const label of [SHORTER_LABEL, EXPAND_LABEL]) {
      const button = screen.getByRole("button", { name: label });
      // A divergent aria-label would make the spoken control and the read
      // control two different promises.
      expect(button).not.toHaveAttribute("aria-label");
      expect(button).toHaveTextContent(label);
      expect(button.tagName).toBe("BUTTON");
    }
  });

  it("clears the 44px touch floor by construction, the way its neighbours do", () => {
    renderReply();
    for (const label of [SHORTER_LABEL, EXPAND_LABEL]) {
      // jsdom lays nothing out, so the E2E scan at 375px is the real measurement.
      // This pins the class that makes it pass, so the floor cannot be dropped
      // silently between E2E runs.
      expect(
        screen.getByRole("button", { name: label }).className,
        `"${label}" lost its touch-height floor — the 375px touch-target scan fails on it`,
      ).toContain("min-h-[44px]");
    }
  });

  it("lives inside the toolbar, so it inherits the row's reveal instead of its own", () => {
    renderReply();
    for (const label of [SHORTER_LABEL, EXPAND_LABEL]) {
      const button = screen.getByRole("button", { name: label });
      // ANCESTRY is the whole claim: the cascade that makes the row reachable on
      // touch and under keyboard focus is modelled once, in the reachability
      // suite, and applies to everything inside this element.
      expect(toolbar().contains(button)).toBe(true);
      // And the button must not gate itself. An `opacity-0` or a `hover:` reveal
      // here would multiply against the row's rules and re-create hover-only
      // controls on a device that has no hover.
      const selfGating = button.className
        .split(/\s+/)
        .filter((token) => /(^|:)opacity-\d+$/.test(token));
      expect(
        selfGating,
        `"${label}" carries its own opacity rules (${selfGating.join(", ")}), which multiply `
          + `against the row's and can hide it where the row is visible`,
      ).toEqual([]);
    }
  });
});

describe("recovery controls — hidden, never disabled, when they cannot deliver", () => {
  it("offers More depth on a model whose budget widens for a deep turn", () => {
    useChatStore.setState({ selectedModel: LADDER_MODEL_ID ?? "auto" });
    renderReply();
    expect(screen.getByRole("button", { name: EXPAND_LABEL })).toBeInTheDocument();
  });

  it("does not offer More depth on a model with a flat budget ladder", () => {
    useChatStore.setState({ selectedModel: FLAT_MODEL_ID ?? "auto" });
    renderReply();
    // Not disabled — absent. Forcing `deep` there moves sampling and nothing
    // else, so the button would be a promise the model cannot keep.
    expect(screen.queryByRole("button", { name: EXPAND_LABEL })).not.toBeInTheDocument();
    // The other control is unaffected: this is a per-control rule, not a
    // blanket "no recovery on small models".
    expect(screen.getByRole("button", { name: SHORTER_LABEL })).toBeInTheDocument();
  });

  it("does not offer Just the answer on a reply too short to shorten", () => {
    renderReply({ localCompletionTokens: SHORTER_MIN_COMPLETION_TOKENS - 1 });
    expect(screen.queryByRole("button", { name: SHORTER_LABEL })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: EXPAND_LABEL })).toBeInTheDocument();
  });

  it("offers Just the answer at the floor and above it", () => {
    renderReply({ localCompletionTokens: SHORTER_MIN_COMPLETION_TOKENS });
    expect(screen.getByRole("button", { name: SHORTER_LABEL })).toBeInTheDocument();
  });

  it("offers Just the answer when the reply's token count is unknown", () => {
    // A reply restored from IndexedDB has no `localCompletionTokens` — the field
    // is not persisted. Fail OPEN, exactly as the handler does: never withhold a
    // control because of state we simply do not have.
    renderReply({ localCompletionTokens: undefined });
    expect(screen.getByRole("button", { name: SHORTER_LABEL })).toBeInTheDocument();
  });

  it("offers neither while the reply is still streaming", () => {
    renderReply({ isStreaming: true });
    expect(screen.queryByRole("button", { name: SHORTER_LABEL })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: EXPAND_LABEL })).not.toBeInTheDocument();
  });

  it("offers neither on a reply that is no longer the latest", () => {
    renderReply({ isLatestAssistant: false });
    expect(screen.queryByRole("button", { name: SHORTER_LABEL })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: EXPAND_LABEL })).not.toBeInTheDocument();
  });

  it("still offers More depth on a reply that hit its length ceiling", () => {
    // A truncated reply has MORE to say, and the handler turns this press into a
    // continuation. The banner's own "Continue" may sit right below it; both
    // now do the same honest thing, so both are allowed to exist.
    renderReply({ possiblyTruncated: true });
    expect(screen.getByRole("button", { name: EXPAND_LABEL })).toBeInTheDocument();
  });
});

describe("recovery controls — wiring", () => {
  it("sends the shorter control down the one action path", async () => {
    const user = userEvent.setup();
    const { onAssistantAction } = renderReply();
    await user.click(screen.getByRole("button", { name: SHORTER_LABEL }));
    // The same callback the overflow menu used, with the same id — promoting
    // the control must not have introduced a second dispatch route that skips
    // the handler's guards.
    expect(onAssistantAction).toHaveBeenCalledTimes(1);
    expect(onAssistantAction).toHaveBeenCalledWith("shorter");
  });

  it("sends the expand control down the one action path", async () => {
    const user = userEvent.setup();
    const { onAssistantAction } = renderReply();
    await user.click(screen.getByRole("button", { name: EXPAND_LABEL }));
    expect(onAssistantAction).toHaveBeenCalledTimes(1);
    expect(onAssistantAction).toHaveBeenCalledWith("expand");
  });

  it("routes a truncated reply's More depth through the same handler, not a shortcut", async () => {
    const user = userEvent.setup();
    const { onAssistantAction } = renderReply({ possiblyTruncated: true });
    await user.click(screen.getByRole("button", { name: EXPAND_LABEL }));
    // Still "expand". The decision to continue rather than regenerate belongs to
    // the handler, which can see the live reply; re-deciding it here would put
    // two copies of that rule in the tree.
    expect(onAssistantAction).toHaveBeenCalledWith("expand");
  });
});
