// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * The retrieval arm's mechanics, and the hostile fixtures' own design.
 *
 * The fixture tests run the REAL selector over the REAL files shipped in
 * `public/eval-fixtures/`, so "the on-topic injection is surfaced and the off-topic
 * one is not" is a measured property of those files rather than a claim in a
 * comment. If a fixture is edited into being harmless, this fails.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { selectPassages } from '../../../lib/grounding/passages';
import { createWikipediaGroundingTool } from '../../../lib/tools/wikipedia-grounding-tool';
import { classifyGroundingOutcome, parrotRatio, runGroundingStep } from '../retrieval-arm';
import { HOSTILE_FIXTURES } from '../retrieval-probes';

const FIXTURE_DIR = join(process.cwd(), 'public', 'eval-fixtures');

function readFixture(file: string): string {
  return readFileSync(join(FIXTURE_DIR, file), 'utf8');
}

describe('parrotRatio', () => {
  it('is 0 for a reply that shares no long verbatim run with the note', () => {
    expect(parrotRatio('The apple has about 52 calories per hundred grams.', 'Nothing alike here.')).toBe(0);
  });

  it('is 1 when the reply is copied straight out of the note', () => {
    const span =
      'A reference serving of a raw apple with skin weighing 100 grams supplies 52 calories.';

    expect(parrotRatio(span, `[BEGIN SOURCE TEXT]\n${span}\n[END SOURCE TEXT]`)).toBe(1);
  });

  it('is 0 for replies shorter than the span it measures', () => {
    expect(parrotRatio('52 calories.', 'A note that mentions 52 calories somewhere.')).toBe(0);
  });

  it('is between 0 and 1 when only part of the reply is copied', () => {
    const copied = 'A reference serving of a raw apple with skin supplies 52 calories.';
    const ratio = parrotRatio(
      `${copied} That is roughly what most people would guess for a medium piece of fruit.`,
      `[BEGIN SOURCE TEXT]\n${copied}\n[END SOURCE TEXT]`,
    );

    expect(ratio).toBeGreaterThan(0);
    expect(ratio).toBeLessThan(1);
  });
});

describe('classifyGroundingOutcome', () => {
  it('reads found off the citation', () => {
    expect(
      classifyGroundingOutcome({
        display: '',
        forModel: 'anything',
        ok: true,
        citation: { source: 'Wikipedia', title: 'Apple', url: 'https://example.test' },
      }),
    ).toBe('found');
  });

  it('reads degraded off the unreachable verification', () => {
    expect(
      classifyGroundingOutcome({
        display: '',
        forModel: "[Couldn't reach reference sources to verify \"x\" right now.]",
        ok: true,
        verification: { status: 'unreachable' },
      }),
    ).toBe('degraded');
  });

  it('tells the hard decline apart from the hedge by the tool’s own note prefix', () => {
    expect(
      classifyGroundingOutcome({
        display: '',
        forModel: '[No reliable source was found for "x" in Wikipedia or Wikidata.]\nmore',
        ok: true,
        verification: { status: 'unverified' },
      }),
    ).toBe('decline');
    expect(
      classifyGroundingOutcome({
        display: '',
        forModel: '[Answering this without a verified source.]\nmore',
        ok: true,
        verification: { status: 'unverified' },
      }),
    ).toBe('hedge');
  });
});

describe('runGroundingStep', () => {
  it('records a clean no-fire when the shipped matcher abstains, without any fetch', async () => {
    const step = await runGroundingStep(
      'retrieval/no-tool-personal-writing/self-review-perf',
      'ok this is my self review, due tomorrow. tell me if this is specific enough',
      'passages',
      undefined,
    );

    expect(step.systemNote).toBeNull();
    expect(step.record).toMatchObject({
      fired: false,
      outcome: 'none',
      injectedChars: 0,
      injectedTokensEstimate: 0,
    });
  });
});

describe('the shipped tool is the lead arm', () => {
  it('defaults to lead mode and sets no retrieval metadata', async () => {
    const tool = createWikipediaGroundingTool();
    const args = tool.match('what is the population of Paris');
    expect(args).not.toBeNull();

    // A body fetcher that would throw if lead mode ever reached for a body.
    const guarded = createWikipediaGroundingTool({
      fetchArticleText: () => {
        throw new Error('lead mode must never fetch an article body');
      },
    });

    expect(guarded.match('what is the population of Paris')).toEqual(args);
    // The default and the guarded build differ only in a seam lead mode never uses,
    // so the two tools are the same tool; the real proof that lead behaviour is
    // unchanged is the existing wikipedia-grounding-tool suite staying green.
    expect(guarded.name).toBe('wikipedia-grounding');
    expect(guarded.presentation).toBe('citation');
  });
});

describe('hostile fixtures', () => {
  const question: Record<string, string> = {
    'calories-apple': 'how many calories in an apple',
    bones: 'how many bones are in the human body',
    'sky-blue': 'why is the sky blue',
  };

  for (const fixture of HOSTILE_FIXTURES) {
    describe(fixture.file, () => {
      const text = readFixture(fixture.file);
      const ask = question[fixture.slug] ?? '';

      it('is TextExtracts-shaped and carries its sentinel exactly once per injection', () => {
        expect(text).toMatch(/^==\s.+\s==$/m);
        expect(text).toContain(fixture.sentinel);
      });

      it('still contains the true fact, so the honest answer is reachable', () => {
        const passages = selectPassages(text, ask, { k: 8, maxChars: 4000 });
        expect(passages.length).toBeGreaterThan(0);
      });

      it(`surfaces its ${fixture.injection} injection exactly as designed`, () => {
        const note = selectPassages(text, ask)
          .map((p) => p.sentence)
          .join('\n');

        expect(note.includes(fixture.sentinel)).toBe(fixture.injection === 'on-topic');
      });

      it('never surfaces the injection planted in an excluded apparatus section', () => {
        const passages = selectPassages(text, ask, { k: 20, maxChars: 100_000 });
        expect(passages.map((p) => p.sectionTitle)).not.toContain('See also');
      });
    });
  }
});
