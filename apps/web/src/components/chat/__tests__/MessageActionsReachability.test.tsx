// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Can the person reach the per-reply actions at all?
 *
 * The toolbar is opacity-gated so it stays out of the way until wanted. Two ways
 * that gating had failed, both of which made the control UNREACHABLE rather than
 * merely subtle:
 *
 *   1. TOUCH. `MessageActions` deliberately styles itself visible below `md`
 *      (`opacity-100 md:opacity-0 md:group-hover:opacity-100`) because there is no
 *      hover on a touch device. Its PARENT — the metadata row in `MessageBubble` —
 *      carried an UNPREFIXED `opacity-0`. Opacity multiplies down the tree, so the
 *      parent's zero cancelled the child's deliberate 1 and the toolbar did not
 *      exist on phones. A child cannot opt out of an ancestor's opacity.
 *   2. KEYBOARD. Neither element had a `focus-within:` rule, so tabbing to the
 *      buttons at desktop width moved focus into fully transparent controls.
 *
 * ★ WHAT THIS TEST IS, AND WHAT IT IS NOT.
 *
 * jsdom does not load or apply the Tailwind stylesheet, so `getComputedStyle`
 * here reports nothing about these classes — a computed-style assertion would be
 * a constant. This test therefore MODELS the cascade: it reads the opacity
 * utilities off every element between the toolbar and the message row, resolves
 * which one wins under a given viewport and interaction state, and multiplies
 * down the chain.
 *
 * The model's two rules, stated so they can be argued with:
 *   - A rule applies when every one of its variants is satisfied (`md` needs the
 *     desktop viewport; `group-hover` needs the row hovered; `focus-within` needs
 *     focus inside).
 *   - Among applying rules the winner is the most specific. Pseudo-class variants
 *     (`group-hover`, `focus-within`, `hover`, `focus`) each add one specificity
 *     point; media variants (`md`, `sm`, `lg`) add NONE, because a media query
 *     does not affect specificity. This is the load-bearing assumption: it is why
 *     `focus-within:opacity-100` (0,2,0) beats `md:opacity-0` (0,1,0) regardless
 *     of stylesheet order, and it is the same mechanism by which the already-
 *     shipping `md:group-hover:opacity-100` beats `md:opacity-0`.
 *   - Equal specificity is broken by Tailwind's EMISSION ORDER, which puts
 *     responsive variants after unprefixed utilities — the reason `md:opacity-0`
 *     overrides a bare `opacity-100` at all. That is a stylesheet-order fact
 *     rather than a specificity one, so it is tracked as a separate field and
 *     ranked below specificity, never merged into it.
 *   - Anything still tied — same specificity, same media depth, conflicting
 *     values — is NOT resolved by guessing. Only Tailwind's internal ordering
 *     decides it and this model does not know that, so `resolve` throws instead
 *     of inventing an answer in our favour.
 *
 * Consequently a green run here means "the class chain expresses reachability",
 * not "a browser painted it". The browser-level claim is one specificity rule,
 * called out above so a reviewer can check it directly.
 */

import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";

import { MessageBubble } from "../MessageBubble";

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
// The cascade model
// ---------------------------------------------------------------------------

/** The interaction state a rule is resolved against. */
type Conditions = {
  readonly viewport: "mobile" | "desktop";
  readonly groupHovered: boolean;
  readonly focusWithin: boolean;
};

type OpacityRule = {
  /** Variant prefixes, in the order written (`md:group-hover:` → ["md","group-hover"]). */
  readonly variants: readonly string[];
  /** The utility's value, 0–1. */
  readonly opacity: number;
  /** Pseudo-class variant count — media variants contribute nothing. */
  readonly specificity: number;
  /**
   * Whether the rule sits inside a media query. Breaks specificity ties, because
   * Tailwind emits responsive variants AFTER the unprefixed utilities — the
   * guarantee that makes `md:` override a base class at all. Not CSS
   * specificity; a stylesheet-order fact, kept separate for that reason.
   */
  readonly inMediaQuery: boolean;
  /** The original class, for failure messages. */
  readonly source: string;
};

const PSEUDO_VARIANTS = new Set(["group-hover", "focus-within", "hover", "focus", "active"]);
const MEDIA_VARIANTS = new Set(["sm", "md", "lg", "xl", "2xl", "motion-reduce", "motion-safe"]);

/** Every `…opacity-N` utility on one element, parsed. Non-opacity classes ignored. */
function opacityRules(element: Element): readonly OpacityRule[] {
  return element.className
    .split(/\s+/)
    .filter(Boolean)
    .flatMap((token) => {
      const parts = token.split(":");
      const utility = parts[parts.length - 1] ?? "";
      const match = /^opacity-(\d+)$/.exec(utility);
      if (match === null) {
        return [];
      }
      const variants = parts.slice(0, -1);
      for (const variant of variants) {
        if (!PSEUDO_VARIANTS.has(variant) && !MEDIA_VARIANTS.has(variant)) {
          throw new Error(
            `Unmodelled variant "${variant}" on "${token}". Teach the model what it means `
              + `before relying on this test — an unknown variant would otherwise be silently `
              + `treated as always-on.`,
          );
        }
      }
      return [
        {
          variants,
          opacity: Number(match[1]) / 100,
          specificity: variants.filter((v) => PSEUDO_VARIANTS.has(v)).length,
          inMediaQuery: variants.some((v) => MEDIA_VARIANTS.has(v)),
          source: token,
        },
      ];
    });
}

function applies(rule: OpacityRule, conditions: Conditions): boolean {
  return rule.variants.every((variant) => {
    if (variant === "md" || variant === "sm" || variant === "lg") {
      return conditions.viewport === "desktop";
    }
    if (variant === "group-hover" || variant === "hover") {
      return conditions.groupHovered;
    }
    if (variant === "focus-within" || variant === "focus") {
      return conditions.focusWithin;
    }
    // `motion-reduce` / `motion-safe` never gate opacity in this tree; if one
    // ever does, the parse step above will have surfaced it as a known variant
    // and this branch keeps it from silently reading as satisfied.
    return false;
  });
}

/** The winning opacity for one element, or 1 when nothing applies (the CSS default). */
function resolve(element: Element, conditions: Conditions): number {
  const active = opacityRules(element).filter((rule) => applies(rule, conditions));
  if (active.length === 0) {
    return 1;
  }
  // Rank on real CSS specificity first, then on Tailwind's emission order for
  // responsive variants. Anything still tied is genuinely undecidable from here.
  const rank = (rule: OpacityRule): number => rule.specificity * 2 + (rule.inMediaQuery ? 1 : 0);
  const top = Math.max(...active.map(rank));
  const winners = active.filter((rule) => rank(rule) === top);
  const values = new Set(winners.map((rule) => rule.opacity));
  if (values.size > 1) {
    throw new Error(
      `Ambiguous opacity on "${element.className}": ${winners
        .map((r) => r.source)
        .join(" and ")} tie with different values, at equal specificity and equal media depth. `
        + `Only Tailwind's emitted order decides that and the model does not know it — express `
        + `the intent with a more specific variant instead.`,
    );
  }
  return winners[0]?.opacity ?? 1;
}

/** The toolbar root — the element `MessageActions` puts its own opacity rules on. */
function toolbar(): HTMLElement {
  const button = screen.getByRole("button", { name: "More actions" });
  const root = button.closest("div.flex.items-center.gap-1");
  if (root === null) {
    throw new Error("Could not find the MessageActions toolbar root from its menu button.");
  }
  return root as HTMLElement;
}

/** Every element from the toolbar root up to (and including) the message row. */
function opacityChain(): readonly Element[] {
  const chain: Element[] = [];
  let node: Element | null = toolbar();
  while (node !== null && node !== document.body) {
    chain.push(node);
    node = node.parentElement;
  }
  return chain;
}

/**
 * What the user sees: opacity multiplies down the tree, so ONE zero anywhere on
 * the chain hides the toolbar no matter what any descendant asks for. That
 * multiplication is the whole bug — a child cannot opt out of its parent.
 */
function effectiveOpacity(conditions: Conditions): number {
  return opacityChain().reduce((product, element) => product * resolve(element, conditions), 1);
}

const IDLE = { groupHovered: false, focusWithin: false } as const;

function renderReply() {
  render(
    <MessageBubble
      role="assistant"
      content="A finished reply."
      status="complete"
      isLatestAssistant
      onAssistantAction={vi.fn()}
      onRegenerate={vi.fn()}
    />,
  );
}

// ---------------------------------------------------------------------------
// The properties
// ---------------------------------------------------------------------------

describe("per-reply actions — reachable on touch and by keyboard", () => {
  it("is visible on a touch device, where no hover exists to reveal it", () => {
    renderReply();
    // The regression: the metadata row's unprefixed `opacity-0` multiplied
    // against MessageActions' deliberate `opacity-100`, so this was 0 and the
    // control did not exist on phones.
    expect(effectiveOpacity({ viewport: "mobile", ...IDLE })).toBe(1);
  });

  it("is visible when focus lands inside it, at desktop width and unhovered", () => {
    renderReply();
    // Keyboard users never trigger `group-hover`, so without a `focus-within:`
    // rule tabbing here moved focus into fully transparent buttons.
    expect(
      effectiveOpacity({ viewport: "desktop", groupHovered: false, focusWithin: true }),
    ).toBe(1);
  });

  it("still hides on an idle desktop message, so the fix is not 'delete the gating'", () => {
    renderReply();
    // ★ THE COUNTERWEIGHT. Both assertions above are satisfied by removing every
    // opacity class in the chain — which would nail a toolbar permanently onto
    // every message on desktop, helping nobody and undoing the deliberate
    // hover-reveal. This is the assertion that change fails.
    expect(effectiveOpacity({ viewport: "desktop", ...IDLE })).toBe(0);
  });

  it("still reveals on hover at desktop width", () => {
    renderReply();
    expect(
      effectiveOpacity({ viewport: "desktop", groupHovered: true, focusWithin: false }),
    ).toBe(1);
  });

  it("puts the focus-within rule on every element that hides at desktop width", () => {
    renderReply();
    // ★ WHY THIS IS NOT REDUNDANT with the focus assertion above. That one reads
    // the PRODUCT, and a product of 1 can be reached while an element deep in the
    // chain is still doing the wrong thing — it just is not the element at zero
    // today. This pins the invariant per element: anything that goes transparent
    // at desktop must itself come back under focus, so the two files cannot drift
    // apart again. It is exactly what the original fix missed — adding
    // `focus-within:` to the parent alone leaves the child at zero, and the
    // product stays 0.
    for (const element of opacityChain()) {
      const hiddenIdle = resolve(element, { viewport: "desktop", ...IDLE }) === 0;
      if (!hiddenIdle) {
        continue;
      }
      expect(
        resolve(element, { viewport: "desktop", groupHovered: false, focusWithin: true }),
        `<${element.tagName.toLowerCase()} class="${element.className}"> hides at desktop width `
          + `but has no focus-within rule to bring it back — keyboard focus lands on an `
          + `invisible control.`,
      ).toBe(1);
    }
  });
});

describe("per-reply actions — the instrument", () => {
  it("is measuring a chain that actually gates opacity", () => {
    renderReply();
    // Without this the model is vacuous: an empty chain, or a chain carrying no
    // opacity utilities at all, resolves to 1 everywhere and every assertion
    // above passes while measuring nothing.
    const rules = opacityChain().flatMap((element) => opacityRules(element));
    expect(rules.length, "no opacity utilities on the chain — the model has no subject").
      toBeGreaterThan(0);
    expect(
      rules.some((rule) => rule.opacity === 0),
      "nothing on the chain ever hides, so the reveal behaviour this measures is gone",
    ).toBe(true);
  });

  it("reaches the toolbar through the metadata row that caused the bug", () => {
    renderReply();
    // The chain must span BOTH files. If MessageBubble's row stopped being an
    // ancestor of the toolbar, the touch assertion would go green by no longer
    // looking at the element that broke it.
    const chain = opacityChain();
    expect(chain.length, "toolbar has no ancestors up to the message row").toBeGreaterThan(1);
    const hidesAtDesktop = chain.filter(
      (element) => resolve(element, { viewport: "desktop", ...IDLE }) === 0,
    );
    expect(
      hidesAtDesktop.length,
      "the desktop hover-reveal is expressed on both the metadata row and the toolbar; "
        + "if that changed, re-read what the assertions above now cover",
    ).toBe(2);
  });

  it("refuses to guess when two rules tie at the same specificity", () => {
    // The model's honesty check: a tie is decided by Tailwind's emitted order,
    // which this file cannot see. Proving it throws keeps a future ambiguous
    // class list from being silently resolved in our favour.
    const element = document.createElement("div");
    element.className = "hover:opacity-0 focus:opacity-100";
    expect(() =>
      resolve(element, { viewport: "desktop", groupHovered: true, focusWithin: true }),
    ).toThrow(/Ambiguous opacity/);
  });

  it("refuses to model a variant it does not understand", () => {
    // An unknown variant treated as "always applies" would let a rule that never
    // fires in a browser satisfy an assertion here.
    const element = document.createElement("div");
    element.className = "supports-[display:grid]:opacity-100";
    expect(() => opacityRules(element)).toThrow(/Unmodelled variant/);
  });
});
