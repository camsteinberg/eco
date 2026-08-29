// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * The model-native tool-dispatch measurement arm (diagnostics only, never shipped).
 *
 * WHY THIS EXISTS. Eco decides which tool a turn needs with hand-written matchers
 * (`lib/tools/*-tool.ts`). Whether a shipped small model could make that same
 * decision from a tool schema has never been measured — `registry.ts` defers it to
 * a "model-native path" that no run has ever exercised. This module supplies the
 * one thing such a run needs and the harness has no other way to provide: tool
 * schemas inside the system prompt.
 *
 * WHAT IT IS NOT. It is not a step towards model-native dispatch shipping, and it
 * is not a prompt to be improved. Prompt tuning is a named threat to the
 * measurement's validity, so:
 *
 * - every `description` is copied VERBATIM from the tool's own `description` field
 *   (a reworded description would measure our copywriting, not the model);
 * - `applyDispatchArm` appends the schema block and NOTHING else — no instructions,
 *   no examples, no "call a tool when…" nudge;
 * - the block's shape is the LFM2 chat template's own tool-list preamble
 *   ("List of tools: " followed by a JSON array), so the model sees tools the way
 *   its training data presents them rather than a format we invented.
 *
 * If any of that changes, the measurement is redone from scratch and BOTH prompts
 * are reported — see the frozen protocol in eco-notes.
 */

/** A JSON-Schema-shaped parameter object for one tool. */
export type DispatchToolParameters = {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
};

/** One tool as the model sees it: name, verbatim description, argument schema. */
export type DispatchToolSchema = {
  name: string;
  description: string;
  parameters: DispatchToolParameters;
};

/**
 * The six shipping tools as JSON schemas.
 *
 * `name` values are EXACTLY the registry names (a test pins them against
 * `DEFAULT_TOOLS`), and `description` values are byte-copies of each tool's own
 * `description`. `parameters` are derived from each tool's `Args` type:
 * `CalculatorArgs`, the `DatetimeArgs` union (flattened to an `op` enum plus the
 * per-op fields), `UnitArgs`, the `MoneyArgs` union (same flattening), `IdentityArgs`
 * and `GroundingArgs`. Union arms cannot be expressed as required fields, so only
 * the discriminant is required — the same compromise any function-calling schema
 * makes for a tagged union.
 */
export const DISPATCH_TOOL_SCHEMAS: readonly DispatchToolSchema[] = [
  {
    name: 'identity',
    description:
      "State Eco's on-device identity and privacy truth verbatim for who/what-are-you, " +
      'where-does-my-data-go, and are-you-<product> questions (the model never answers these).',
    parameters: {
      type: 'object',
      properties: {
        intent: {
          type: 'string',
          enum: ['identity', 'data-location', 'are-you-x'],
          description: 'Which identity frame the turn is in.',
        },
        subject: {
          type: 'string',
          description:
            'The named AI product for the "are-you-x" intent, in canonical display casing.',
        },
      },
      required: ['intent'],
    },
  },
  {
    name: 'calculator',
    description: 'Evaluate an arithmetic expression (e.g. 17 * 23, 15% of 240, sqrt(144)).',
    parameters: {
      type: 'object',
      properties: {
        expression: {
          type: 'string',
          description: 'A normalized expression ready for evaluation (e.g. "17 * 23").',
        },
      },
      required: ['expression'],
    },
  },
  {
    name: 'datetime',
    description:
      'Answer date/time questions: current date/time/day, date offsets, days until a date, start time plus or minus a duration.',
    parameters: {
      type: 'object',
      properties: {
        op: {
          type: 'string',
          enum: ['current', 'offset', 'until', 'clock'],
          description: 'Which date/time operation the turn asks for.',
        },
        kind: {
          type: 'string',
          enum: ['date', 'time', 'dayOfWeek'],
          description: 'For op "current": which part of now is asked for.',
        },
        days: {
          type: 'number',
          description: 'For op "offset": signed number of days from today.',
        },
        target: {
          type: 'string',
          description: 'For op "until": the target date or named day.',
        },
        startMinutes: {
          type: 'number',
          description: 'For op "clock": start time of day in minutes since midnight (0-1439).',
        },
        deltaMinutes: {
          type: 'number',
          description: 'For op "clock": signed duration in minutes to add to the start time.',
        },
        meridiem: {
          type: 'boolean',
          description: 'For op "clock": whether the user wrote am/pm.',
        },
      },
      required: ['op'],
    },
  },
  {
    name: 'unit-conversion',
    description:
      'Convert between units of temperature, length, mass, volume, or time (e.g. 5 miles in km, how many cups in a gallon).',
    parameters: {
      type: 'object',
      properties: {
        family: {
          type: 'string',
          enum: ['temperature', 'length', 'mass', 'volume', 'time'],
          description: 'The unit family being converted within.',
        },
        from: {
          type: 'string',
          description: 'Canonical id of the source unit (e.g. "mi").',
        },
        to: {
          type: 'string',
          description: 'Canonical id of the target unit (e.g. "km").',
        },
        value: {
          type: 'number',
          description: 'The numeric quantity to convert.',
        },
      },
      required: ['family', 'from', 'to', 'value'],
    },
  },
  {
    name: 'money',
    description:
      'Answer consumer-credit money questions: what an APR means per month, how long a balance takes to pay off at a fixed payment, and a worked compound-interest example.',
    parameters: {
      type: 'object',
      properties: {
        op: {
          type: 'string',
          enum: ['aprMeaning', 'payoff', 'compoundExample'],
          description: 'Which money question the turn asks.',
        },
        aprPercent: {
          type: 'number',
          description: 'The annual percentage rate, as a percentage (e.g. 24.99).',
        },
        balance: {
          type: 'number',
          description: 'For op "payoff": the outstanding balance.',
        },
        monthlyPayment: {
          type: 'number',
          description: 'For op "payoff": the fixed monthly payment.',
        },
      },
      required: ['op'],
    },
  },
  {
    name: 'wikipedia-grounding',
    description:
      'Look up a factual/entity question against Wikipedia/Wikidata, or decline honestly when no reliable source exists.',
    parameters: {
      type: 'object',
      properties: {
        entity: {
          type: 'string',
          description: 'The entity to look up.',
        },
        wikidataProperty: {
          type: ['string', 'null'],
          description:
            'A Wikidata property to ALSO fetch (e.g. "P1082" population), or null when the article extract alone answers the question.',
        },
        confidence: {
          type: 'string',
          enum: ['high', 'low', 'followup'],
          description: 'Extraction confidence for the entity span.',
        },
        fulltext: {
          type: 'boolean',
          description: 'True to use the zero-entity full-text search path.',
        },
        searchText: {
          type: 'string',
          description: 'Full-text mode only: the string actually sent to the search endpoint.',
        },
      },
      required: ['entity', 'wikidataProperty'],
    },
  },
] as const;

/** The literal preamble the schema block is introduced with. */
const TOOL_LIST_PREAMBLE = '\nList of tools: ';

/**
 * The schemas arm's system prompt: the shipped prompt, then the tool list. Nothing
 * else is added — see this module's header for why that restraint is the point.
 */
export function applyDispatchArm(basePrompt: string): string {
  return basePrompt + TOOL_LIST_PREAMBLE + JSON.stringify(DISPATCH_TOOL_SCHEMAS);
}

/** A parsed tool call: the name the model emitted plus the raw call text. */
export type DispatchCall = {
  /** The tool name exactly as emitted — UNKNOWN names are returned, not dropped. */
  tool: string;
  /** The raw call span, e.g. `[calculator(expression="47 * 89")]`. */
  raw: string;
};

/** `<|tool_call_start|>[ … ]<|tool_call_end|>` anywhere in the reply. */
const TAGGED_CALL = /<\|tool_call_start\|>\s*(\[[\s\S]*?\])\s*<\|tool_call_end\|>/;

/**
 * A bare `[name(...)]` call. Decoding can strip the special tokens, so a leading
 * bare call still counts — but only a LEADING one: a bracketed span deep inside
 * prose is far likelier to be ordinary text than a call, and counting it would
 * inflate the dispatch rate. "Leading" is the first 20 characters of the reply.
 */
const BARE_CALL = /\[\s*([A-Za-z0-9_.-]+)\s*\(([\s\S]*?)\)\s*\]/;
const BARE_CALL_MAX_START_INDEX = 20;

/**
 * Extract the FIRST tool call from a model reply, or `null` when the reply is
 * ordinary text.
 *
 * Deliberately permissive about the name: an unknown or misspelled tool name is
 * DATA (the model tried to dispatch and got the name wrong), so it is returned as
 * `tool` rather than discarded — grading, not parsing, decides what it means.
 */
export function parseDispatchCall(output: string): DispatchCall | null {
  if (typeof output !== 'string' || output.trim() === '') return null;

  const tagged = TAGGED_CALL.exec(output);
  if (tagged) {
    const inner = tagged[1] ?? '';
    const named = BARE_CALL.exec(inner);
    return { tool: named?.[1] ?? inner.trim(), raw: inner };
  }

  const bare = BARE_CALL.exec(output);
  if (bare && bare.index <= BARE_CALL_MAX_START_INDEX) {
    return { tool: bare[1] ?? '', raw: bare[0] };
  }

  return null;
}
