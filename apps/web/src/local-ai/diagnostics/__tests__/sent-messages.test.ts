// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const harnessEnabled = vi.hoisted(() => ({ value: true }));

vi.mock('../../../lib/validation-harness', () => ({
  isValidationHarnessEnabled: () => harnessEnabled.value,
}));

import { SENT_RING_SIZE, clearSentMessages, recordSentMessages } from '../sent-messages';
import type { ChatMessage } from '../../runtime/types';

beforeEach(() => {
  harnessEnabled.value = true;
  clearSentMessages();
});

afterEach(() => {
  clearSentMessages();
});

describe('recordSentMessages', () => {
  it('records nothing, and installs no reader, off the harness', () => {
    harnessEnabled.value = false;
    recordSentMessages('m', [{ role: 'user', content: 'hi' }]);
    expect(window.__ecoHarnessSent).toBeUndefined();

    // The count did not move while off: the first record on the harness is #1.
    harnessEnabled.value = true;
    recordSentMessages('m', [{ role: 'user', content: 'hi' }]);
    expect(window.__ecoHarnessSent?.().map((r) => r.seq)).toEqual([1]);
  });

  it(`keeps the last ${String(SENT_RING_SIZE)} generations, newest first`, () => {
    for (let i = 1; i <= 10; i++) {
      recordSentMessages('m', [{ role: 'user', content: `turn ${String(i)}` }]);
    }
    const records = window.__ecoHarnessSent?.() ?? [];
    expect(records).toHaveLength(SENT_RING_SIZE);
    expect(records.map((r) => r.seq)).toEqual([10, 9, 8, 7, 6, 5, 4, 3]);
    expect(records[0]).toEqual({ seq: 10, modelId: 'm', messages: [{ role: 'user', content: 'turn 10' }] });
  });

  it('keeps copies: changing the list it was given leaves the record as sent', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'My name is Tomas.' },
    ];
    recordSentMessages('m', messages);
    messages[1]!.content = 'My name is Priya.';
    messages.push({ role: 'assistant', content: 'late' });

    expect(window.__ecoHarnessSent?.()[0]?.messages).toEqual([
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'My name is Tomas.' },
    ]);
  });

  it('hands out copies: changing what a reader got leaves the next read unchanged', () => {
    recordSentMessages('m', [{ role: 'user', content: 'My name is Tomas.' }]);
    const first = window.__ecoHarnessSent?.() ?? [];
    first[0]!.messages[0]!.content = 'My name is Priya.';
    first.length = 0;
    const again = window.__ecoHarnessSent?.() ?? [];
    expect(again).toHaveLength(1);
    expect(again[0]?.messages).toEqual([{ role: 'user', content: 'My name is Tomas.' }]);
  });
});
