// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Everyday conversation probes — unit tests.
 *
 * Three jobs. The first two mirror `everyday-probes.test.ts` exactly, because
 * this set is the same instrument pointed at a different corpus:
 *
 *   1. COVERAGE. One probe per conversation, asserted by name against the live
 *      corpus length, and one derived entry per conversation. A corpus addition
 *      must fail loudly here rather than sit silently unmeasured.
 *   2. PINNING. Every derived value is pinned as a LIST, never as a count. A
 *      count survives a derivation quietly degenerating into something else.
 *
 * And one this file needs and the single-turn one cannot have:
 *
 *   3. ★ COMPOSITION. That the history is really carried forward, in order and
 *      verbatim, and — the part that actually matters — that each probe's ask
 *      DEPENDS on it. A multi-turn probe whose answer is fully available in its
 *      own prompt is a single-turn probe with decoration attached, and it would
 *      pass every coverage check in this file while measuring nothing new. So
 *      each conversation pins a phrase that appears in its history and NOT in its
 *      prompt, chosen as something the good answer cannot be right without.
 */

import { describe, expect, it } from 'vitest';

import {
  EVERYDAY_CONVERSATION_CORPUS,
  CONVERSATION_ROUTING_NEEDS,
  conversationNeedsFor,
  conversationsNeeding,
  historyCarriesPastedContent,
  probedTurnAsItem,
  probedTurnOf,
  turnsBeforeProbe,
  type ConversationJob,
  type MultiTurnEverydayItem,
} from '../../../__tests__/fixtures/everyday-conversation-corpus';
import { inferChatIntent } from '../../../lib/chat-intent';
import {
  EVERYDAY_CONVERSATION_ARTIFACT_ASKS,
  EVERYDAY_CONVERSATION_ASK_OPENNESS,
  EVERYDAY_CONVERSATION_PROBE_IDS,
  EVERYDAY_CONVERSATION_PROBE_SOURCE_ITEM,
  EVERYDAY_CONVERSATION_PROBES,
  EVERYDAY_CONVERSATION_REUSE_CANDIDATE_ITEM_IDS,
  EVERYDAY_CONVERSATION_UNMEASURED_CEILING_ITEM_IDS,
  ceilingWordsFor,
  classifyAskOpenness,
  conversationIdsWithOpenness,
  conversationProbeId,
  conversationProbeIdsWithJob,
  richnessFloorFor,
} from '../everyday-conversation-probes';
import {
  analyzeHistoryFactPreservation,
  analyzeRuledOut,
  mentionsRuledOutTerm,
} from '../rubric';

// ─── the pinned derivation ─────────────────────────────────────────────────

/**
 * Which user turn each conversation is probed at, and how many turns sit above
 * it. Pinned because everything downstream moves if this moves, and because
 * "the last turn" is the wrong default — see the corpus header. Two of the eight
 * are probed mid-conversation, both for the same reason: the turns after them
 * contain a scripted assistant reply that already states the answer, so probing
 * later would test copying rather than recall.
 */
const PROBED_TURNS: Readonly<Record<string, { index: number; totalTurns: number }>> = {
  'convo-air-fryer-doneness': { index: 6, totalTurns: 7 },
  'convo-milestone-gift-mailable': { index: 6, totalTurns: 7 },
  'convo-teacher-email-resend': { index: 8, totalTurns: 9 },
  'convo-grape-climbdown': { index: 8, totalTurns: 9 },
  'convo-monstera-contradiction': { index: 8, totalTurns: 9 },
  // Probed at "write the message", not at the Denise message four turns later:
  // by then two scripted assistant turns have already written the whole thing.
  'convo-birthday-lunch-message': { index: 6, totalTurns: 12 },
  // Probed at "write the whole thing out as a proper list", not at the boiler
  // addendum: the list itself is sitting in the scripted turn in between.
  'convo-four-day-budget-list': { index: 8, totalTurns: 12 },
  'convo-insurance-recall': { index: 10, totalTurns: 18 },
};

/** Ceiling (over-shoot) and floor (under-shoot) per conversation, both optional. */
const EXPECTED_BANDS: Readonly<Record<string, { maxWords?: number; minWords?: number }>> = {
  'convo-air-fryer-doneness': { minWords: 60 },
  'convo-milestone-gift-mailable': { minWords: 60 },
  'convo-teacher-email-resend': { minWords: 60 },
  'convo-grape-climbdown': { minWords: 60 },
  'convo-monstera-contradiction': { minWords: 60 },
  'convo-birthday-lunch-message': { minWords: 60 },
  'convo-four-day-budget-list': { minWords: 60 },
  // The only one with neither. Its good answer says "Two short answers", which
  // takes the floor off; nothing in it puts a number on the ceiling. So both
  // automated depth dims are null here and the judge is the only thing watching.
  // Pinned in EVERYDAY_CONVERSATION_UNMEASURED_CEILING_ITEM_IDS as well.
  'convo-insurance-recall': {},
};

/**
 * ★ The open/closed split, by the single-turn rules applied unchanged.
 *
 * Seven of eight want substance, which is the corpus's designed asymmetry doing
 * its job: an item earns a brevity classification only by SAYING so, and a person
 * mid-conversation almost never does — they have already said the short things.
 */
const CLOSED_CONVERSATIONS = ['convo-insurance-recall'];

const OPEN_CONVERSATIONS = [
  'convo-air-fryer-doneness',
  'convo-milestone-gift-mailable',
  'convo-teacher-email-resend',
  'convo-grape-climbdown',
  'convo-monstera-contradiction',
  'convo-birthday-lunch-message',
];

/**
 * One two-sided item, and it got there through the SHARED bloat patterns with no
 * help: its bounce names "a generic 50/30/20 lecture instead of his actual
 * numbers", and `/\blecture\b/` was written for a single-turn item about
 * translating a sentence into Spanish. That the pattern transfers to a
 * conversation about a four-day wage without being touched is the evidence that
 * this set is the same instrument rather than a copy of it.
 */
const TWO_SIDED_CONVERSATIONS = ['convo-four-day-budget-list'];

/** Which conversation shape each item tests. Every value must be represented. */
const JOB_MEMBERSHIP: Readonly<Record<ConversationJob, readonly string[]>> = {
  'follow-up-correction': ['convo-air-fryer-doneness', 'convo-milestone-gift-mailable'],
  'topic-shift-return': [
    'convo-teacher-email-resend',
    'convo-grape-climbdown',
    'convo-monstera-contradiction',
  ],
  'multi-step-job': ['convo-birthday-lunch-message', 'convo-four-day-budget-list'],
  // ⚠ THE HONEST SIZE OF THIS: one item. Three long-context-recall conversations
  // were authored and two did not survive integration review, so this shape is a
  // data point rather than a comparison and cannot carry a claim by itself.
  // Widening it means authoring more of them, not reclassifying these.
  'long-context-recall': ['convo-insurance-recall'],
};

/**
 * ★ THE COMPOSITION PIN, and the load-bearing check in this file.
 *
 * For each conversation, something the good answer cannot be right without,
 * which lives ONLY above the probed turn. Both halves are asserted: present in
 * the history, absent from the prompt. Without the second half a probe can look
 * multi-turn and be answerable from its own prompt, which is the failure mode
 * that would make this whole set decorative.
 */
const HISTORY_ONLY_FACTS: Readonly<Record<string, readonly string[]>> = {
  // The constraint that has to STAY made: he ruled the thermometer out two turns
  // before asking, and never mentions it again.
  'convo-air-fryer-doneness': ['thermometer'],
  // Three exclusions, accumulated one turn at a time, none repeated in the ask.
  'convo-milestone-gift-mailable': ['candles', 'spa', 'photo book'],
  // The draft she wants back, and the dates that have to go into it. Her ask
  // contains neither — she is asking it to remember both.
  'convo-teacher-email-resend': ['Thursday and Friday', 'front office'],
  // The entire subject. "so whats i actually watch for tonight" is meaningless
  // without the grape and the vet, and says neither word.
  'convo-grape-climbdown': ['grape', 'bloodwork just to be safe'],
  // The advice she followed for nine days is not restated in the turn that
  // reports the consequence.
  'convo-monstera-contradiction': ['too much water'],
  // Every specific the message has to carry, spread over three earlier turns.
  'convo-birthday-lunch-message': ['sunday 8th march', 'bridgford road', '25 quid a head'],
  // Sixteen figures given in two earlier turns. The probed turn names only the
  // rent correction, so every other line has to come out of the history.
  'convo-four-day-budget-list': ['council tax 142', 'food shop about 320', 'dogs insurance 29'],
  // ★ Read this one honestly. He half-remembers the numbers out loud — "was it
  // 150 each or 150 the once", "i thought it said 8 weeks somewhere" — so the
  // probe measures DISCRIMINATION between two candidates he supplied, not blind
  // recall of a figure. What is genuinely history-only is the wording that
  // settles it, seven hundred words up, and what the eight weeks is a clock on.
  'convo-insurance-recall': ['per insured person, per section', 'final response'],
};

// ─── coverage ──────────────────────────────────────────────────────────────

describe('everyday conversation probe coverage', () => {
  it('★ derives exactly one probe per conversation', () => {
    expect(EVERYDAY_CONVERSATION_PROBES).toHaveLength(EVERYDAY_CONVERSATION_CORPUS.length);
    expect(EVERYDAY_CONVERSATION_PROBES.map((p) => p.id)).toEqual(
      EVERYDAY_CONVERSATION_CORPUS.map((item) => conversationProbeId(item.id)),
    );
    expect(EVERYDAY_CONVERSATION_PROBE_IDS.size).toBe(EVERYDAY_CONVERSATION_PROBES.length);
    for (const item of EVERYDAY_CONVERSATION_CORPUS) {
      expect(EVERYDAY_CONVERSATION_PROBE_SOURCE_ITEM[conversationProbeId(item.id)]).toBe(item.id);
    }
  });

  it('carries the probed turn VERBATIM as the prompt — never re-typed, never tidied', () => {
    for (const item of EVERYDAY_CONVERSATION_CORPUS) {
      const probe = EVERYDAY_CONVERSATION_PROBES.find((p) => p.id === conversationProbeId(item.id));
      expect(probe?.prompt).toBe(probedTurnOf(item).text);
    }
  });

  it('★ carries each bounce condition into the notes — it is the acceptance criterion', () => {
    for (const item of EVERYDAY_CONVERSATION_CORPUS) {
      const probe = EVERYDAY_CONVERSATION_PROBES.find((p) => p.id === conversationProbeId(item.id));
      expect(probe?.notes).toContain(item.bounceCondition);
      expect(probe?.notes).toContain(item.goodAnswerLooksLike);
      expect(probe?.notes).toContain(item.whatTheyActuallyWant);
      // A judge reading only the prompt would not know it is mid-conversation.
      expect(probe?.notes).toContain(item.conversationJob);
    }
  });

  it('keeps intent in lockstep with the live router, always with prior turns', () => {
    for (const item of EVERYDAY_CONVERSATION_CORPUS) {
      const probe = EVERYDAY_CONVERSATION_PROBES.find((p) => p.id === conversationProbeId(item.id));
      expect(probe?.intent).toBe(
        inferChatIntent(probedTurnOf(item).text, { hasPriorTurns: true }),
      );
    }
  });

  it('gives every probe a distinct, namespaced id and asks for a judge', () => {
    for (const probe of EVERYDAY_CONVERSATION_PROBES) {
      expect(probe.id.startsWith('everyday-convo-')).toBe(true);
      // Its own category: a probe carrying eight turns of history must not be
      // averaged in with one that carries none.
      expect(probe.category).toBe('everyday-conversation');
      expect(probe.judge).toEqual(['taskFit', 'coherence']);
      expect(probe.expectDeliverable).toBe(true);
    }
  });
});

// ─── the derived layer is complete, and quotes the corpus ──────────────────

describe('every conversation is classified — none can join silently', () => {
  it('★ pins which turn each conversation is probed at', () => {
    const actual = Object.fromEntries(
      EVERYDAY_CONVERSATION_CORPUS.map((item) => [
        item.id,
        { index: conversationNeedsFor(item.id).probedTurnIndex, totalTurns: item.turns.length },
      ]),
    );
    expect(actual).toEqual(PROBED_TURNS);
  });

  it('probes a user turn that always has an exchange above it', () => {
    for (const item of EVERYDAY_CONVERSATION_CORPUS) {
      const index = conversationNeedsFor(item.id).probedTurnIndex;
      expect(index, `${item.id} is probed at its opening turn`).toBeGreaterThan(0);
      expect(item.turns[index]?.role).toBe('user');
      // The turn before it is a reply, so the ask is genuinely a follow-up.
      expect(item.turns[index - 1]?.role).toBe('assistant');
    }
  });

  it('derives a routing need, quoting the item, for every conversation', () => {
    for (const item of EVERYDAY_CONVERSATION_CORPUS) {
      const entry = conversationNeedsFor(item.id);
      expect(entry.needs.length, `${item.id} has no derived need`).toBeGreaterThan(0);
      // A justification has to QUOTE the item — a paraphrase is a guess wearing
      // quotation marks. Same rule the single-turn sweep applies.
      const quoted = [...entry.why.matchAll(/"([^"]{12,})"/g)]
        .flatMap((m) => (m[1] ?? '').split('…'))
        .map((span) => span.trim().replace(/[.,;:]$/, ''))
        .filter((span) => span.length >= 12);
      const source = [
        ...item.turns.map((t) => t.text),
        item.whatTheyActuallyWant,
        item.goodAnswerLooksLike,
        item.bounceCondition,
      ].join(' ');
      expect(
        quoted.some((span) => source.includes(span)),
        `${item.id} justification quotes nothing from the item itself`,
      ).toBe(true);
    }
    const corpusIds = new Set(EVERYDAY_CONVERSATION_CORPUS.map((i) => i.id));
    for (const id of Object.keys(CONVERSATION_ROUTING_NEEDS)) {
      expect(corpusIds.has(id), `${id} is derived but not in the corpus`).toBe(true);
    }
  });

  it('★ pins which conversation shape each item tests, and represents every shape', () => {
    for (const [job, ids] of Object.entries(JOB_MEMBERSHIP) as [ConversationJob, string[]][]) {
      expect(
        EVERYDAY_CONVERSATION_CORPUS.filter((i) => i.conversationJob === job).map((i) => i.id),
      ).toEqual(ids);
      expect(conversationProbeIdsWithJob(job)).toEqual(ids.map(conversationProbeId));
      expect(ids.length, `${job} has no conversation`).toBeGreaterThan(0);
    }
    expect(Object.values(JOB_MEMBERSHIP).flat().sort()).toEqual(
      EVERYDAY_CONVERSATION_CORPUS.map((i) => i.id).sort(),
    );
  });
});

// ─── ★ composition: the history is real, and the ask depends on it ─────────

describe('★ turns compose — history carried forward, and load-bearing', () => {
  it('replays every turn above the probed one, in order and verbatim', () => {
    for (const item of EVERYDAY_CONVERSATION_CORPUS) {
      const probe = EVERYDAY_CONVERSATION_PROBES.find((p) => p.id === conversationProbeId(item.id))!;
      const expected = turnsBeforeProbe(item);
      expect(probe.history).toHaveLength(expected.length);
      expect(probe.history).toEqual(
        expected.map((turn) => ({ role: turn.role, content: turn.text })),
      );
      // Alternating from a user opening, so the replayed transcript is coherent.
      expected.forEach((turn, i) => {
        expect(turn.role).toBe(i % 2 === 0 ? 'user' : 'assistant');
      });
    }
  });

  it('never replays the probed turn, or anything after it', () => {
    for (const item of EVERYDAY_CONVERSATION_CORPUS) {
      const probe = EVERYDAY_CONVERSATION_PROBES.find((p) => p.id === conversationProbeId(item.id))!;
      const index = conversationNeedsFor(item.id).probedTurnIndex;
      const replayed = (probe.history ?? []).map((h) => h.content);
      expect(replayed).not.toContain(probe.prompt);
      for (const later of item.turns.slice(index)) {
        expect(replayed).not.toContain(later.text);
      }
    }
  });

  it('★ every probe DEPENDS on its history: the pinned facts are above the turn, not in it', () => {
    // The check that makes this set worth running. If a fact the good answer
    // needs is also in the prompt, that probe is answerable without memory and
    // measures nothing this corpus exists for.
    for (const item of EVERYDAY_CONVERSATION_CORPUS) {
      const probe = EVERYDAY_CONVERSATION_PROBES.find((p) => p.id === conversationProbeId(item.id))!;
      const facts = HISTORY_ONLY_FACTS[item.id];
      expect(facts, `${item.id} pins no history-only fact`).toBeDefined();
      expect(facts!.length).toBeGreaterThan(0);
      const replayed = (probe.history ?? []).map((h) => h.content).join('\n');
      for (const fact of facts!) {
        expect(replayed, `${item.id}: "${fact}" is not in the history`).toContain(fact);
        expect(
          probe.prompt,
          `${item.id}: "${fact}" is in the prompt too, so this probe does not need the history`,
        ).not.toContain(fact);
      }
    }
  });

  it('tells the judge when the facts being asked for were PASTED, not typed', () => {
    const pastedHistory = EVERYDAY_CONVERSATION_CORPUS.filter(historyCarriesPastedContent).map(
      (i) => i.id,
    );
    expect(pastedHistory).toEqual(['convo-teacher-email-resend', 'convo-insurance-recall']);
    for (const id of pastedHistory) {
      expect(
        EVERYDAY_CONVERSATION_PROBES.find((p) => p.id === conversationProbeId(id))?.notes,
      ).toContain('PASTED in an earlier turn');
    }
  });
});

// ─── the shared rules, applied unchanged ───────────────────────────────────

describe('the derivation is the single-turn one, not a copy of it', () => {
  it('★ views a conversation as THIS turn only — no history leaks into the rules', () => {
    for (const item of EVERYDAY_CONVERSATION_CORPUS) {
      const view = probedTurnAsItem(item);
      expect(view.userInput).toBe(probedTurnOf(item).text);
      // The rules read `userInput`; if history leaked in, every ceiling and every
      // openness reading would silently be about the wrong text.
      for (const earlier of turnsBeforeProbe(item)) {
        expect(view.userInput).not.toContain(earlier.text);
      }
      expect(view.id).toBe(item.id);
      expect(view.bounceCondition).toBe(item.bounceCondition);
    }
  });

  it('★ pins the ceiling and floor, computed by the shared functions', () => {
    const actual = Object.fromEntries(
      EVERYDAY_CONVERSATION_CORPUS.map((item) => {
        const probe = EVERYDAY_CONVERSATION_PROBES.find(
          (p) => p.id === conversationProbeId(item.id),
        )!;
        return [
          item.id,
          {
            ...(probe.depthBand?.maxWords !== undefined
              ? { maxWords: probe.depthBand.maxWords }
              : {}),
            ...(probe.minWords !== undefined ? { minWords: probe.minWords } : {}),
          },
        ];
      }),
    );
    expect(actual).toEqual(EXPECTED_BANDS);

    // Same numbers, straight off the single-turn functions. A second
    // implementation appearing here would show up as a disagreement.
    for (const item of EVERYDAY_CONVERSATION_CORPUS) {
      const view = probedTurnAsItem(item);
      const probe = EVERYDAY_CONVERSATION_PROBES.find(
        (p) => p.id === conversationProbeId(item.id),
      )!;
      expect(probe.depthBand?.maxWords).toBe(ceilingWordsFor(view) ?? undefined);
      expect(probe.minWords).toBe(richnessFloorFor(view, ceilingWordsFor(view)) ?? undefined);
      expect(probe.depthBand?.minWords).toBeUndefined();
    }
  });

  it('★ pins the open/closed split', () => {
    expect(conversationIdsWithOpenness('closed')).toEqual(CLOSED_CONVERSATIONS);
    expect(conversationIdsWithOpenness('open')).toEqual(OPEN_CONVERSATIONS);
    expect(conversationIdsWithOpenness('two-sided')).toEqual(TWO_SIDED_CONVERSATIONS);
    expect(
      [...CLOSED_CONVERSATIONS, ...OPEN_CONVERSATIONS, ...TWO_SIDED_CONVERSATIONS].sort(),
    ).toEqual(EVERYDAY_CONVERSATION_CORPUS.map((i) => i.id).sort());
    for (const item of EVERYDAY_CONVERSATION_CORPUS) {
      expect(EVERYDAY_CONVERSATION_ASK_OPENNESS[item.id]).toBe(
        classifyAskOpenness(probedTurnAsItem(item)),
      );
    }
  });

  it('★ pins the unmeasured-ceiling gap rather than papering over it', () => {
    expect([...EVERYDAY_CONVERSATION_UNMEASURED_CEILING_ITEM_IDS]).toEqual([
      'convo-four-day-budget-list',
      'convo-insurance-recall',
    ]);
  });
});

// ─── the reuse gap, stated rather than hidden ──────────────────────────────

describe('preservesUserText is off for the whole set, and that is a stated gap', () => {
  it('★ four conversations must give the user their own figures back, and none can be measured', () => {
    // The requirement is real: four carry `faithful-reproduction`. The dim reads
    // `spec.prompt` alone, and in every one of them the figures live in an
    // earlier turn — so pointing it at the probed turn would score noise. Not a
    // property of the corpus; a limit of a one-turn span measure.
    const needing = conversationsNeeding('faithful-reproduction').map((i) => i.id);
    expect(needing).toEqual([
      'convo-teacher-email-resend',
      'convo-birthday-lunch-message',
      'convo-four-day-budget-list',
      'convo-insurance-recall',
    ]);
    for (const probe of EVERYDAY_CONVERSATION_PROBES) {
      expect(probe.expectUserTextReuse).toBeUndefined();
    }
  });

  it('★ the drift guard: a genuine candidate cannot appear without being classified', () => {
    // A conversation whose PROBED turn itself carries a paste and needs
    // faithful-reproduction would be measurable. None exists; the derived list
    // must stay in step with that mechanical rule, so the first one to appear
    // fails here instead of silently joining or silently missing the gate.
    const mechanical = EVERYDAY_CONVERSATION_CORPUS.filter(
      (item) =>
        probedTurnAsItem(item).hasPastedContent &&
        conversationNeedsFor(item.id).needs.includes('faithful-reproduction'),
    ).map((item) => item.id);
    expect([...EVERYDAY_CONVERSATION_REUSE_CANDIDATE_ITEM_IDS]).toEqual(mechanical);
    expect(EVERYDAY_CONVERSATION_REUSE_CANDIDATE_ITEM_IDS).toEqual([]);
  });
});

// ─── ★ the history-recall gates: authored scope, machine-checked ───────────

/**
 * ★ WHAT THESE GUARD, AND WHY THEY ARE STRICTER THAN THE OTHER PINS.
 *
 * `historyFactSources` and `historyRuledOut` are the only probe fields in this
 * file that are AUTHORED rather than computed — the window a conversation's
 * facts live in cannot be derived (see the corpus's `CarriedForwardSpan` block).
 * Authored means an author could quietly widen a window until a bad answer
 * passes, or ban a word the record never contained. So every authored value is
 * held to three machine checks: the quote is verbatim in that probe's own
 * history, the derived facts are pinned as a LIST, and a ruled-out term must be
 * present in the very sentence offered as its evidence.
 */
describe('★ history recall: the authored scope cannot drift from the record', () => {
  it('every carried-forward span is verbatim in that probe’s OWN history', () => {
    for (const item of EVERYDAY_CONVERSATION_CORPUS) {
      const probe = EVERYDAY_CONVERSATION_PROBES.find((p) => p.id === conversationProbeId(item.id))!;
      const spans = conversationNeedsFor(item.id).carriesForward ?? [];
      expect(probe.historyFactSources ?? []).toEqual(spans.map((s) => s.quote));
      const replayed = (probe.history ?? []).map((h) => h.content).join('\n\n');
      for (const span of spans) {
        expect(
          replayed,
          `${item.id}: carried-forward span is not verbatim in the history`,
        ).toContain(span.quote);
        expect(span.why.length, `${item.id}: a span with no reason is not reviewable`)
          .toBeGreaterThan(0);
      }
    }
  });

  it('★ a carried-forward span may NOT be answerable from the prompt alone', () => {
    // The whole point of the dim. If the words are also in the probed turn, the
    // single-turn `preservesFacts` would already see them and this measures
    // nothing new.
    for (const item of EVERYDAY_CONVERSATION_CORPUS) {
      const probe = EVERYDAY_CONVERSATION_PROBES.find((p) => p.id === conversationProbeId(item.id))!;
      for (const span of probe.historyFactSources ?? []) {
        expect(probe.prompt, `${item.id}: "${span.slice(0, 30)}…" is in the prompt`).not.toContain(
          span,
        );
      }
    }
  });

  it('★ every ruled-out term is grounded in the user’s own words, by the scorer’s own rule', () => {
    for (const item of EVERYDAY_CONVERSATION_CORPUS) {
      const probe = EVERYDAY_CONVERSATION_PROBES.find((p) => p.id === conversationProbeId(item.id))!;
      const entries = conversationNeedsFor(item.id).ruledOut ?? [];
      expect(probe.historyRuledOut ?? []).toEqual(entries.map((e) => e.term));
      const replayed = (probe.history ?? []).map((h) => h.content).join('\n\n');
      for (const entry of entries) {
        expect(replayed, `${item.id}: the evidence sentence is not in the history`).toContain(
          entry.quote,
        );
        // Checked by the SAME function that scores the output, so an author
        // cannot ban a word the record does not contain, and cannot ban one in a
        // form the scorer would not recognise.
        expect(
          mentionsRuledOutTerm(entry.quote, entry.term),
          `${item.id}: "${entry.term}" is not in its own evidence quote`,
        ).toBe(true);
        expect(entry.why.length).toBeGreaterThan(0);
      }
    }
  });

  it('★ nothing is required to survive AND to be absent', () => {
    // A term banned by `historyRuledOut` that also appears among the facts
    // `historyFactSources` requires would make the two dims contradict each
    // other, and the probe unpassable.
    for (const probe of EVERYDAY_CONVERSATION_PROBES) {
      const sources = probe.historyFactSources;
      const banned = probe.historyRuledOut;
      if (!sources || !banned) continue;
      const facts = analyzeHistoryFactPreservation(sources, '').facts;
      for (const term of banned) {
        for (const fact of facts) {
          expect(
            mentionsRuledOutTerm(fact.text, term),
            `${probe.id}: "${term}" is both required and banned`,
          ).toBe(false);
        }
      }
    }
  });

  it('★ pins WHICH conversations are gated — a list, so a new one has to be classified', () => {
    expect(
      EVERYDAY_CONVERSATION_PROBES.filter((p) => p.historyFactSources).map(
        (p) => EVERYDAY_CONVERSATION_PROBE_SOURCE_ITEM[p.id],
      ),
    ).toEqual([
      'convo-teacher-email-resend',
      'convo-birthday-lunch-message',
      'convo-four-day-budget-list',
      'convo-insurance-recall',
    ]);
    // ★ ONE. `honorsRuledOut` tests presence, not use, so it is only pointed at
    // a term whose every mention is a mistake — and the corpus contains exactly
    // one: the thermometer this man does not own, whose item defines its good
    // answer as having "No thermometer anywhere in the answer". The two
    // superseded values that used to be here (£745, saturday) are in
    // `mentionNotViolation`, with the correct replies they flagged.
    expect(
      EVERYDAY_CONVERSATION_PROBES.filter((p) => p.historyRuledOut).map(
        (p) => EVERYDAY_CONVERSATION_PROBE_SOURCE_ITEM[p.id],
      ),
    ).toEqual(['convo-air-fryer-doneness']);
  });

  it('★ pins the DERIVED facts themselves — the denominator, readable and arguable', () => {
    // A count would survive the derivation degenerating into something else.
    // These are the exact facts a reply has to bring back, in extraction order.
    const derived = Object.fromEntries(
      EVERYDAY_CONVERSATION_PROBES.filter((p) => p.historyFactSources).map((p) => [
        EVERYDAY_CONVERSATION_PROBE_SOURCE_ITEM[p.id],
        analyzeHistoryFactPreservation(p.historyFactSources!, '').facts.map((f) => f.text),
      ]),
    );
    expect(derived).toEqual({
      // ★ TWO, and that is the honest size of it. The draft's other load-bearing
      // content ("the front office", "the attendance policy") is lowercase prose
      // that `extractFacts` cannot see, and its `[Teacher]` / `[Son]` are
      // template SLOTS rather than facts — counting `Teacher` scored a parrot
      // that left the brackets in above the email with the real names filled in.
      // What is left is the two dates the turn actually asks for: "i need the
      // actual days in there".
      'convo-teacher-email-resend': ['Thursday', 'Friday'],
      'convo-birthday-lunch-message': ['60', '25', '8', 'march', 'sunday'],
      'convo-four-day-budget-list': [
        '2180', '142', '95', '31', '18', '27', '61', '120', '320',
        '34', '12.99', '11', '29', '245', '14.50', '24', '790', '150',
      ],
      // ★ ONE, so the score here is binary, and that is the whole of what a fact
      // dim can see on this item — see the span's `why`. 150 and 8 are in the
      // probed turn itself ("was it 150 each or 150 the once"), so they measure
      // nothing; £300 is the consequence of getting it right and appears nowhere
      // in his ask.
      'convo-insurance-recall': ['300'],
    });
  });

  it('★ pins the three conversations left UNGATED, and why', () => {
    // Stated rather than rounded off, the same way the unmeasured ceilings are.
    //   gift      — its ruled-out items (candles, spa) are fatal when RECOMMENDED,
    //               not when named; a token check would flag the good reply that
    //               opens "skipping the candles you said she throws away".
    //   grape     — two straight answers about a dog; reproduces nothing.
    //   monstera  — the failure is a hedge that will not USE the nine dry days.
    //               "Did the reply reason from fact X" is a different measurement
    //               from "does fact X appear", and this dim cannot make it.
    expect(
      EVERYDAY_CONVERSATION_PROBES.filter((p) => !p.historyFactSources && !p.historyRuledOut).map(
        (p) => EVERYDAY_CONVERSATION_PROBE_SOURCE_ITEM[p.id],
      ),
    ).toEqual([
      'convo-milestone-gift-mailable',
      'convo-grape-climbdown',
      'convo-monstera-contradiction',
    ]);
  });
});

// ─── ★ the descoped terms: measured, not argued ───────────────────────────

/**
 * ★ WHY THIS BLOCK EXISTS. `mentionNotViolation` is a claim — "gating this term
 * would flag the right answer" — and a claim in a comment decays. So every entry
 * carries a correct reply verbatim, and this block runs the scorer over it. If
 * someone re-gates one of these terms, the pin below fails; if the false fire
 * ever stops being real, the evidence assertion fails and the entry has to be
 * re-argued rather than quietly kept.
 */
describe('★ terms where mention is not violation, and the evidence for saying so', () => {
  it('pins which terms were descoped, and that none of them is gated', () => {
    const descoped = Object.fromEntries(
      EVERYDAY_CONVERSATION_CORPUS.filter(
        (item) => (conversationNeedsFor(item.id).mentionNotViolation ?? []).length > 0,
      ).map((item) => [
        item.id,
        (conversationNeedsFor(item.id).mentionNotViolation ?? []).map((e) => e.term),
      ]),
    );
    expect(descoped).toEqual({
      'convo-birthday-lunch-message': ['saturday'],
      'convo-four-day-budget-list': ['745'],
    });
    for (const item of EVERYDAY_CONVERSATION_CORPUS) {
      const probe = EVERYDAY_CONVERSATION_PROBES.find((p) => p.id === conversationProbeId(item.id))!;
      for (const entry of conversationNeedsFor(item.id).mentionNotViolation ?? []) {
        expect(
          probe.historyRuledOut ?? [],
          `${item.id}: "${entry.term}" is descoped and gated at the same time`,
        ).not.toContain(entry.term);
      }
    }
  });

  it('★ runs the check that was taken off, and shows it scoring a CORRECT reply 0', () => {
    for (const item of EVERYDAY_CONVERSATION_CORPUS) {
      const probe = EVERYDAY_CONVERSATION_PROBES.find((p) => p.id === conversationProbeId(item.id))!;
      const replayed = (probe.history ?? []).map((h) => h.content).join('\n\n');
      for (const entry of conversationNeedsFor(item.id).mentionNotViolation ?? []) {
        // Held to the same evidence rules as a gated term: the superseding
        // sentence is verbatim in the history, and the term is really in it.
        expect(replayed, `${item.id}: the evidence sentence is not in the history`).toContain(
          entry.quote,
        );
        expect(mentionsRuledOutTerm(entry.quote, entry.term)).toBe(true);
        expect(entry.why.length).toBeGreaterThan(0);
        // And the reason it is off: the correct reply scores 0, exactly as the
        // real violation would. The check cannot tell them apart.
        expect(
          analyzeRuledOut([entry.term], entry.correctReplyItFlagged).score,
          `${item.id}: "${entry.term}" no longer flags the reply recorded against it`,
        ).toBe(0);
      }
    }
  });
});

describe('deliversAskedArtifact — the two conversations that ask for a message', () => {
  const ARTIFACT_ASK_ITEM_IDS = ['convo-birthday-lunch-message', 'convo-teacher-email-resend'];

  function itemById(id: string): MultiTurnEverydayItem {
    const item = EVERYDAY_CONVERSATION_CORPUS.find((i) => i.id === id);
    if (item === undefined) throw new Error('no conversation ' + id);
    return item;
  }

  it('pins the annotated conversations, their kind and their audience', () => {
    expect(Object.keys(EVERYDAY_CONVERSATION_ARTIFACT_ASKS)).toEqual(ARTIFACT_ASK_ITEM_IDS);
    expect(
      Object.fromEntries(
        Object.entries(EVERYDAY_CONVERSATION_ARTIFACT_ASKS).map(([id, entry]) => [
          id,
          entry.kind + ' → ' + entry.audience,
        ]),
      ),
    ).toEqual({
      'convo-birthday-lunch-message':
        'message → the family group chat — fourteen relatives, several of them older',
      'convo-teacher-email-resend':
        "email → her son's class teacher, with the front office copied per the policy",
    });
  });

  it('sets the spec field on exactly those probes, and on no others', () => {
    const gated = EVERYDAY_CONVERSATION_PROBES.filter((p) => p.expectsArtifact !== undefined).map(
      (p) => p.id,
    );
    // Probes are derived in CORPUS order, which is not the order of the map.
    expect(gated).toEqual([
      conversationProbeId('convo-teacher-email-resend'),
      conversationProbeId('convo-birthday-lunch-message'),
    ]);
    expect([...gated].sort()).toEqual([...ARTIFACT_ASK_ITEM_IDS.map(conversationProbeId)].sort());
  });

  it('★ reads the PROBED TURN, not the conversation subject', () => {
    // The insurance conversation ends in a formal complaint letter and is
    // deliberately ungated: its probed turn is "remind me what the excess was",
    // four turns earlier. Gating on the subject would score a recall answer as a
    // failed letter.
    expect(EVERYDAY_CONVERSATION_ARTIFACT_ASKS['convo-insurance-recall']).toBeUndefined();
    expect(probedTurnOf(itemById('convo-insurance-recall')).text).toContain(
      'remind me what the excess was',
    );
    // …while the two that ARE gated name the artifact in the probed turn itself.
    expect(probedTurnOf(itemById('convo-birthday-lunch-message')).text).toContain(
      'can you write the message i send to the family group chat',
    );
    expect(probedTurnOf(itemById('convo-teacher-email-resend')).text).toContain('can u resend it');
  });

  it('hands the audience to the judge in the probe notes', () => {
    const probe = EVERYDAY_CONVERSATION_PROBES.find(
      (p) => p.id === conversationProbeId('convo-birthday-lunch-message'),
    );
    expect(probe?.notes).toContain(
      'the deliverable is a message the person will send to the family group chat',
    );
  });
});
