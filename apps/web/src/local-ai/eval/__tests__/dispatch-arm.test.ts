// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, expect, it } from 'vitest';

import { DEFAULT_TOOLS } from '../../../lib/tools';
import {
  applyDispatchArm,
  DISPATCH_TOOL_SCHEMAS,
  parseDispatchCall,
} from '../dispatch-arm';

describe('dispatch tool schemas', () => {
  it('names exactly the shipping registry tools, so a rename fails loudly', () => {
    const registryNames = DEFAULT_TOOLS.map((t) => t.name).sort();
    const schemaNames = DISPATCH_TOOL_SCHEMAS.map((s) => s.name).sort();
    expect(schemaNames).toEqual(registryNames);
  });

  it('copies each description verbatim from the tool it describes', () => {
    for (const schema of DISPATCH_TOOL_SCHEMAS) {
      const tool = DEFAULT_TOOLS.find((t) => t.name === schema.name);
      expect(tool, `no registry tool named ${schema.name}`).toBeDefined();
      expect(schema.description).toBe(tool?.description);
    }
  });

  it('gives every tool an object parameter schema with at least one property', () => {
    for (const schema of DISPATCH_TOOL_SCHEMAS) {
      expect(schema.parameters.type).toBe('object');
      expect(Object.keys(schema.parameters.properties).length).toBeGreaterThan(0);
      for (const required of schema.parameters.required ?? []) {
        expect(Object.keys(schema.parameters.properties)).toContain(required);
      }
    }
  });
});

describe('applyDispatchArm', () => {
  it('appends the tool list and NOTHING else (byte shape)', () => {
    const base = 'BASE PROMPT';
    expect(applyDispatchArm(base)).toBe(
      `${base}\nList of tools: ${JSON.stringify(DISPATCH_TOOL_SCHEMAS)}`,
    );
  });

  it('leaves the base prompt byte-identical at the front', () => {
    const base = 'You are Eco.\nBe brief.';
    expect(applyDispatchArm(base).startsWith(base)).toBe(true);
  });

  it('adds no instructions or examples beyond the schema JSON', () => {
    const added = applyDispatchArm('X').slice('X'.length);
    expect(added).toBe(`\nList of tools: ${JSON.stringify(DISPATCH_TOOL_SCHEMAS)}`);
  });
});

describe('parseDispatchCall', () => {
  it('parses the special-token form', () => {
    const out = '<|tool_call_start|>[calculator(expression="47 * 89")]<|tool_call_end|>';
    expect(parseDispatchCall(out)).toEqual({
      tool: 'calculator',
      raw: '[calculator(expression="47 * 89")]',
    });
  });

  it('parses the special-token form when it appears mid-reply', () => {
    const out =
      'Sure, let me work that out. <|tool_call_start|>[unit-conversion(family="temperature", from="f", to="c", value=350)]<|tool_call_end|>';
    expect(parseDispatchCall(out)?.tool).toBe('unit-conversion');
  });

  it('parses a bare leading call when decoding stripped the special tokens', () => {
    const out = '[money(op="aprMeaning", aprPercent=24.99)]';
    expect(parseDispatchCall(out)).toEqual({
      tool: 'money',
      raw: '[money(op="aprMeaning", aprPercent=24.99)]',
    });
  });

  it('returns null for an ordinary prose reply', () => {
    expect(parseDispatchCall('That works out to 4,183.')).toBeNull();
  });

  it('returns null for a bracketed span buried in prose (not a leading call)', () => {
    const out =
      'Here is a long explanation about your options before anything else happens [calculator(expression="1+1")]';
    expect(parseDispatchCall(out)).toBeNull();
  });

  it('returns an UNKNOWN tool name rather than dropping the call', () => {
    const out = '<|tool_call_start|>[web_search(q="paris")]<|tool_call_end|>';
    expect(parseDispatchCall(out)?.tool).toBe('web_search');
  });

  it('returns only the FIRST call when several are emitted', () => {
    const out =
      '<|tool_call_start|>[datetime(op="current", kind="date")]<|tool_call_end|><|tool_call_start|>[calculator(expression="2+2")]<|tool_call_end|>';
    expect(parseDispatchCall(out)?.tool).toBe('datetime');
  });

  it('returns null for empty or whitespace-only output', () => {
    expect(parseDispatchCall('')).toBeNull();
    expect(parseDispatchCall('   \n ')).toBeNull();
  });
});
