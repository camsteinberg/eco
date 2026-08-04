// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * ★ ARTIFACT DELIVERY — the scorer against a reader, on thirty real replies.
 *
 * WHAT THIS GUARDS. Asked to "write the message I send to the family group chat"
 * or to resend a drafted email with the dates filled in, the shipping default
 * on-device model often hands back organiser notes instead: emoji section
 * headers, a "Next steps" list, "Your 14 guests", a briefing written to the
 * person who asked. Every existing dim scored those replies well —
 * `deliversFirst` in particular gave 1 to twenty-nine of these thirty samples,
 * because its helper counts any bullet list as a deliverable. This file is the
 * standing check that `deliversAskedArtifact` sees what a reader sees.
 *
 * ── TWO LAYERS, ONLY ONE OF WHICH IS A JUDGEMENT ────────────────────────────
 *
 *   THE FACT LAYER is `analyzeArtifactDelivery` run over
 *   `captured-artifact-replies.ts`: which samples it calls delivered, which
 *   borderline, which not. Pinned as LISTS of sample ids, never as counts — a
 *   count survives a scorer quietly degenerating into something else, and a list
 *   does not. Judge a change to the dim by this diff first.
 *
 *   THE JUDGED LAYER is the fixtures' own `handLabel`, made by reading every
 *   output in full BEFORE the scorer existed. It is the thing the scorer has to
 *   reproduce, and it does not move because our code moved.
 *
 * ── ★ THE FINDING, RECORDED AS WHAT USERS EXPECT vs WHAT WE DELIVER ─────────
 *
 * Every one of these asks is for a message the person will send. What they expect
 * is that every reply is one. `KNOWN_ARTIFACT_DELIVERY_GAPS` records what we
 * actually delivered, per corpus item, measured over the captured replies —
 * exactly the mechanism `everyday-use-routing-sweep.test.ts` uses. NEVER edit the
 * expectation to go green: when a gap closes, re-measure and DELETE its entry.
 *
 * Note honestly what a frozen capture can and cannot catch. These fixtures do not
 * change, so this file cannot notice a model getting better — a new capture does
 * that. What it catches is the instrument being loosened: weaken the dim until
 * organiser notes count as a message and these entries stop matching.
 */

import { describe, expect, it } from 'vitest';

import {
  CAPTURED_ARTIFACT_REPLIES,
  capturedRepliesFor,
  type CapturedArtifactReply,
} from '../../../__tests__/fixtures/captured-artifact-replies';
import { EVERYDAY_CONVERSATION_ARTIFACT_ASKS, EVERYDAY_CONVERSATION_PROBES, conversationProbeId } from '../everyday-conversation-probes';
import {
  REQUESTER_DIRECTED_PATTERNS,
  analyzeArtifactDelivery,
  analyzeDeliversFirst,
  scoreArtifactDelivery,
} from '../rubric';
import type { EvalPromptSpec } from '../types';

// ─── the fact layer: what the scorer says about each captured reply ────────

/** Samples the scorer calls a delivered message. */
const SCORED_DELIVERED: readonly string[] = [
  'birthday-before-2',
  'birthday-before-7',
  'birthday-before-9',
  'birthday-after-4',
  'birthday-after-5',
  'birthday-after-6',
  'birthday-after-7',
  'birthday-after-10',
  'teacher-before-5',
  'teacher-after-5',
];

/** Samples it calls signed-but-unaddressed — the announcement/flyer register. */
const SCORED_BORDERLINE: readonly string[] = ['birthday-before-8', 'birthday-after-3'];

function idsScoring(target: number): readonly string[] {
  return CAPTURED_ARTIFACT_REPLIES.filter(
    (reply) => analyzeArtifactDelivery(reply.text).score === target,
  ).map((reply) => reply.id);
}

describe('the scorer against the reader', () => {
  it('pins which captured replies score as delivered, borderline and not', () => {
    expect(idsScoring(1)).toEqual(SCORED_DELIVERED);
    expect(idsScoring(0.5)).toEqual(SCORED_BORDERLINE);
    expect(idsScoring(0)).toHaveLength(
      CAPTURED_ARTIFACT_REPLIES.length - SCORED_DELIVERED.length - SCORED_BORDERLINE.length,
    );
  });

  it('★ reproduces the hand label on every one of the thirty', () => {
    const disagreements = CAPTURED_ARTIFACT_REPLIES.filter(
      (reply) => analyzeArtifactDelivery(reply.text).score !== reply.handLabel,
    ).map((reply) => reply.id + ': read as "' + reply.why + '"');
    expect(disagreements).toEqual([]);
  });

  it('reads the two ends of correspondence, and reports both', () => {
    // Delivered samples are addressed. Borderline ones are signed and NOT
    // addressed — which is the whole content of the middle rung, so it is
    // asserted rather than described.
    for (const id of SCORED_DELIVERED) {
      expect(analyzeArtifactDelivery(replyById(id).text).addressOpening).not.toBeNull();
    }
    for (const id of SCORED_BORDERLINE) {
      const analysis = analyzeArtifactDelivery(replyById(id).text);
      expect(analysis.addressOpening).toBeNull();
      expect(analysis.signOff).not.toBeNull();
    }
  });
});

function replyById(id: string): CapturedArtifactReply {
  const reply = CAPTURED_ARTIFACT_REPLIES.find((r) => r.id === id);
  if (reply === undefined) throw new Error('no captured reply ' + id);
  return reply;
}

// ─── the two-sided mirrors, on real captured text ──────────────────────────

describe('★ the mirrors — both directions, from the captures themselves', () => {
  it('a thin non-delivery scores 0: "Just hit send now."', () => {
    const reply = replyById('teacher-before-2');
    expect(reply.text).toContain('Just hit send now.');
    expect(analyzeArtifactDelivery(reply.text).score).toBe(0);
  });

  it('imperative advice to the person who asked scores 0', () => {
    const reply = replyById('teacher-after-4');
    expect(reply.text).toContain('Send again with the full dates spelled out');
    expect(analyzeArtifactDelivery(reply.text).score).toBe(0);
  });

  it('★ a delivered draft INSIDE assistant framing scores 1 — the frame is not the failure', () => {
    for (const id of ['teacher-before-5', 'teacher-after-5']) {
      const reply = replyById(id);
      expect(analyzeArtifactDelivery(reply.text).score).toBe(1);
    }
    // Both are introduced rather than handed over bare, which is exactly the
    // shape a stricter rule would have failed.
    expect(replyById('teacher-before-5').text).toContain('I’ll send the updated version below:');
    expect(replyById('teacher-after-5').text).toContain('Sent again:');
  });

  it('★ emoji, markdown and bullets do not fail a group-chat message', () => {
    const emojiOrMarkup = SCORED_DELIVERED.filter((id) => /\*\*|[\u{1F300}-\u{1FAFF}]/u.test(replyById(id).text));
    expect(emojiOrMarkup.length).toBeGreaterThanOrEqual(6);
    for (const id of emojiOrMarkup) {
      expect(analyzeArtifactDelivery(replyById(id).text).score).toBe(1);
    }
  });

  it('★ a "[Your Name]" placeholder does not fail it — the corpus\'s own reply uses one', () => {
    const placeholdered = SCORED_DELIVERED.filter((id) => replyById(id).text.includes('[Your Name]'));
    expect(placeholdered.length).toBeGreaterThanOrEqual(5);
  });

  it('a message written to the person who asked scores 0', () => {
    // "Next steps: Send the confirmation to Mum" — a briefing for the organiser,
    // not a message for the chat.
    const reply = replyById('birthday-after-9');
    expect(reply.text).toContain('Send the confirmation to Mum');
    expect(analyzeArtifactDelivery(reply.text).score).toBe(0);
  });

  it('the length of a reply decides nothing on its own', () => {
    // The longest failures dwarf the shortest successes. A dim that could be
    // satisfied by writing more, or less, would show the opposite.
    const bodyOf = (id: string): number => analyzeArtifactDelivery(replyById(id).text).bodyWords;
    expect(Math.min(...SCORED_DELIVERED.map(bodyOf))).toBeLessThan(
      Math.max(...idsScoring(0).map(bodyOf)),
    );
  });
});

// ─── the markers, each pinned where it actually fires ──────────────────────

describe('the reported markers', () => {
  it('★ organiser section headers are absent from every delivered message but one', () => {
    const withHeadings = SCORED_DELIVERED.filter(
      (id) => analyzeArtifactDelivery(replyById(id).text).organizerHeadings.length > 0,
    );
    // The one exception is the finding, not the exception: this reply uses a
    // heading to LABEL the message rather than to replace it.
    expect(withHeadings).toEqual(['birthday-before-2']);
    expect(analyzeArtifactDelivery(replyById('birthday-before-2').text).organizerHeadings).toEqual([
      '### 📝 Invitation Message Draft',
    ]);
  });

  it('pins the headers on the notes-shaped replies', () => {
    expect(analyzeArtifactDelivery(replyById('birthday-after-2').text).organizerHeadings).toEqual([
      '### ✅ What’s confirmed:',
      '### 🗣️ Talking Points:',
      '### ⚠️ Important Notes:',
    ]);
    expect(analyzeArtifactDelivery(replyById('birthday-after-9').text).organizerHeadings).toEqual([
      '**Next steps:**',
    ]);
    expect(analyzeArtifactDelivery(replyById('birthday-before-8').text).organizerHeadings).toEqual([
      '**⚠️ Important Notes:**',
    ]);
  });

  it('★ every requester-directed pattern fires on a real capture, and on no delivered one', () => {
    const firedOn = REQUESTER_DIRECTED_PATTERNS.map((pattern) =>
      CAPTURED_ARTIFACT_REPLIES.filter((reply) =>
        analyzeArtifactDelivery(reply.text).requesterDirected.includes(pattern.source),
      ).map((reply) => reply.id),
    );
    expect(firedOn).toEqual([
      ['birthday-before-10', 'birthday-after-8'], // "Your 14 guests total"
      ['birthday-after-1'], // "(Optional: Add a small note to Kieran…)"
      ['birthday-before-6'], // "Let me know how I should proceed next!"
      ['birthday-after-8', 'birthday-after-9'], // "Send a reminder", "Send the confirmation to Mum"
    ]);
    // Not one of them is a marker invented for a reply nobody produced, and not
    // one of them fires on a message that was actually delivered.
    for (const ids of firedOn) {
      expect(ids.length).toBeGreaterThan(0);
      for (const id of ids) expect(SCORED_DELIVERED).not.toContain(id);
    }
  });
});

// ─── the body floor: reachable, and calibrated against the captures ────────

describe('the body floor', () => {
  it('★ leaves a wide margin under every delivered message', () => {
    const shortest = Math.min(
      ...SCORED_DELIVERED.map((id) => analyzeArtifactDelivery(replyById(id).text).bodyWords),
    );
    // 34 today. Recomputed rather than quoted, so the constant in `rubric.ts`
    // cannot drift away from the evidence its comment cites.
    expect(shortest).toBe(34);
    // The floor is 15. A salutation with a stub under it must still fail.
    expect(analyzeArtifactDelivery('Hi everyone,\n\nBooked it!').score).toBe(0);
  });
});

// ─── the dim is not `deliversFirst` wearing a new name ─────────────────────

describe('★ why the sibling dim could not see this', () => {
  it('deliversFirst scores every captured failure as a success', () => {
    const belowOne = CAPTURED_ARTIFACT_REPLIES.filter(
      (reply) => analyzeDeliversFirst(reply.text).score < 1,
    ).map((reply) => reply.id);
    // One sample in thirty. Everything else — organiser notes, flyers,
    // deflections, "Just hit send now." — is a clean 1 there.
    expect(belowOne).toEqual(['teacher-before-3']);
    expect(analyzeDeliversFirst(replyById('birthday-after-8').text).score).toBe(1);
    expect(analyzeDeliversFirst(replyById('teacher-before-2').text).score).toBe(1);
  });
});

// ─── ★ the standing gap: what users expect vs what we deliver ──────────────

/**
 * Every one of these asks is "write me the message I am going to send". What the
 * person expects is that every reply is one. This is the expectation, and it is
 * never edited.
 */
const EVERY_REPLY_MUST_DELIVER = 1;

/**
 * corpus item id → what the shipping default model actually delivered, measured
 * over the captured replies. `delivered` scored a full 1; `borderline` scored 0.5
 * (signed but addressed to nobody); `mean` is the dim's average over the samples.
 *
 * ★ CLOSING A GAP MUST DELETE ITS ENTRY, never relax the check above.
 */
const KNOWN_ARTIFACT_DELIVERY_GAPS: ReadonlyMap<
  string,
  { delivered: number; borderline: number; samples: number; mean: number; note: string }
> = new Map([
  [
    'convo-birthday-lunch-message',
    {
      delivered: 8,
      borderline: 2,
      samples: 20,
      mean: 0.45,
      note: 'Half the replies to "can you write the message i send to the family group chat" are organiser notes: emoji section headers, "Talking Points", "Next steps", "Your 14 guests". Two more are invitation flyers signed but addressed to nobody.',
    },
  ],
  [
    'convo-teacher-email-resend',
    {
      delivered: 2,
      borderline: 0,
      samples: 10,
      mean: 0.2,
      note: 'Eight of ten replies to "can u resend it … i need the actual days in there" are advice, fragments or a deflection — including a false "I don’t have access to your past messages" refusal, and "Just hit send now." The dates often ARE named; they are named inside advice, without the email ever being produced.',
    },
  ],
]);

describe('★ the standing gap', () => {
  it('records the shortfall against the expectation, and holds it open', () => {
    for (const [itemId, gap] of KNOWN_ARTIFACT_DELIVERY_GAPS) {
      const scores = capturedRepliesFor(itemId).map(
        (reply) => analyzeArtifactDelivery(reply.text).score,
      );
      expect(scores).toHaveLength(gap.samples);
      expect(scores.filter((s) => s === 1)).toHaveLength(gap.delivered);
      expect(scores.filter((s) => s === 0.5)).toHaveLength(gap.borderline);
      expect(scores.reduce((sum, s) => sum + s, 0) / scores.length).toBeCloseTo(gap.mean, 5);
      expect(gap.mean).toBeLessThan(EVERY_REPLY_MUST_DELIVER);
    }
  });

  it('every gap names an item the dim is actually pointed at', () => {
    for (const itemId of KNOWN_ARTIFACT_DELIVERY_GAPS.keys()) {
      expect(EVERYDAY_CONVERSATION_ARTIFACT_ASKS[itemId]).toBeDefined();
      expect(probeFor(itemId).expectsArtifact).toBeDefined();
    }
  });

  it('every captured item is either at the expectation or has a gap entry', () => {
    const measured = new Set(CAPTURED_ARTIFACT_REPLIES.map((reply) => reply.itemId));
    for (const itemId of measured) {
      const gap = KNOWN_ARTIFACT_DELIVERY_GAPS.get(itemId);
      if (gap !== undefined) continue;
      const scores = capturedRepliesFor(itemId).map(
        (reply) => analyzeArtifactDelivery(reply.text).score,
      );
      expect(scores.every((s) => s === EVERY_REPLY_MUST_DELIVER)).toBe(true);
    }
  });

  it('scores nothing at all on a probe that was never annotated', () => {
    const unannotated: EvalPromptSpec = {
      id: 'x',
      category: 'everyday-conversation',
      intent: 'writing',
      prompt: 'what should i watch tonight',
    };
    expect(scoreArtifactDelivery(unannotated, replyById('birthday-after-8').text)).toBeNull();
  });
});

function probeFor(itemId: string): EvalPromptSpec {
  const probe = EVERYDAY_CONVERSATION_PROBES.find((p) => p.id === conversationProbeId(itemId));
  if (probe === undefined) throw new Error('no conversation probe for ' + itemId);
  return probe;
}
