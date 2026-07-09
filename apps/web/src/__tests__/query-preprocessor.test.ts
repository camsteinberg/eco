// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect } from 'vitest';
import {
  sanitizeQuery,
  classifyQuery,
  preprocessQuery,
} from '../lib/query-preprocessor';

describe('query-preprocessor', () => {
  describe('sanitizeQuery()', () => {
    it('strips email addresses', () => {
      const result = sanitizeQuery('Send an email to user@example.com please');
      expect(result.sanitized).toBe('Send an email to [EMAIL] please');
      expect(result.redactions.length).toBe(1);
      expect(result.redactions[0]!.type).toBe('email');
    });

    it('strips multiple email addresses', () => {
      const result = sanitizeQuery('From alice@test.org to bob@company.co.uk');
      expect(result.sanitized).toContain('[EMAIL]');
      expect(result.redactions.length).toBe(2);
    });

    it('strips phone numbers', () => {
      const result = sanitizeQuery('Call me at +1-555-123-4567 today');
      expect(result.sanitized).toBe('Call me at [PHONE] today');
      expect(result.redactions.length).toBe(1);
      expect(result.redactions[0]!.type).toBe('phone');
    });

    it('strips phone numbers without country code', () => {
      const result = sanitizeQuery('My number is (555) 123-4567');
      expect(result.sanitized).toContain('[PHONE]');
      expect(result.redactions.length).toBe(1);
    });

    it('strips URLs', () => {
      const result = sanitizeQuery('Check https://example.com/path?q=1 for details');
      expect(result.sanitized).toBe('Check [URL] for details');
      expect(result.redactions.length).toBe(1);
      expect(result.redactions[0]!.type).toBe('url');
    });

    it('strips http URLs too', () => {
      const result = sanitizeQuery('Go to http://localhost:3000/api');
      expect(result.sanitized).toContain('[URL]');
    });

    it('strips names after "my name is"', () => {
      const result = sanitizeQuery('Hello, my name is John and I need help');
      expect(result.sanitized).toBe('Hello, my name is [NAME] and I need help');
      expect(result.redactions.length).toBe(1);
      expect(result.redactions[0]!.type).toBe('name');
    });

    it('strips names after "I\'m" pattern', () => {
      const result = sanitizeQuery("Hi, I'm Sarah, can you help?");
      expect(result.sanitized).toContain('[NAME]');
    });

    it('strips names after "call me" pattern', () => {
      const result = sanitizeQuery('Just call me Dave please');
      expect(result.sanitized).toContain('[NAME]');
    });

    it('strips IP addresses', () => {
      const result = sanitizeQuery('Connect to 192.168.1.100 on port 8080');
      expect(result.sanitized).toBe('Connect to [IP] on port 8080');
      expect(result.redactions.length).toBe(1);
      expect(result.redactions[0]!.type).toBe('ip');
    });

    it('preserves technical content (code snippets)', () => {
      const code = 'function myName() { return "test@example"; }';
      const result = sanitizeQuery(code);
      // Should NOT strip "myName" as a name (it's camelCase code)
      expect(result.sanitized).toContain('myName');
    });

    it('preserves error messages', () => {
      const error = 'TypeError: Cannot read properties of undefined (reading "map")';
      const result = sanitizeQuery(error);
      expect(result.sanitized).toBe(error);
      expect(result.redactions.length).toBe(0);
    });

    it('handles combined PII types', () => {
      const text = 'My name is Alice, email alice@test.com, call 555-123-4567';
      const result = sanitizeQuery(text);
      expect(result.sanitized).toContain('[NAME]');
      expect(result.sanitized).toContain('[EMAIL]');
      expect(result.sanitized).toContain('[PHONE]');
      expect(result.redactions.length).toBe(3);
    });

    it('handles empty input', () => {
      const result = sanitizeQuery('');
      expect(result.sanitized).toBe('');
      expect(result.redactions.length).toBe(0);
    });

    it('handles text with no PII', () => {
      const text = 'How do I sort an array in JavaScript?';
      const result = sanitizeQuery(text);
      expect(result.sanitized).toBe(text);
      expect(result.redactions.length).toBe(0);
    });
  });

  describe('classifyQuery()', () => {
    it('classifies code queries', () => {
      expect(classifyQuery('```python\nprint("hello")\n```')).toBe('code');
      expect(classifyQuery('How do I write a function in JavaScript?')).toBe('code');
      expect(classifyQuery('Fix this import statement')).toBe('code');
    });

    it('classifies reasoning queries', () => {
      expect(classifyQuery('Why does water boil at 100 degrees?')).toBe('reasoning');
      expect(classifyQuery('How does photosynthesis work?')).toBe('reasoning');
      expect(classifyQuery('Explain the difference between TCP and UDP')).toBe('reasoning');
      expect(classifyQuery('Compare React and Vue frameworks')).toBe('reasoning');
    });

    it('classifies creative queries', () => {
      expect(classifyQuery('Write a poem about the ocean')).toBe('creative');
      expect(classifyQuery('Create a short story about a dragon')).toBe('creative');
      expect(classifyQuery('Write me a haiku')).toBe('creative');
    });

    it('defaults to general for unclassified queries', () => {
      expect(classifyQuery('What time is it?')).toBe('general');
      expect(classifyQuery('Thanks!')).toBe('general');
      expect(classifyQuery('Hello')).toBe('general');
    });
  });

  describe('preprocessQuery()', () => {
    it('returns structured preprocessing result', () => {
      const result = preprocessQuery('My name is Bob, email bob@test.com');
      expect(result.sanitized).toContain('[NAME]');
      expect(result.sanitized).toContain('[EMAIL]');
      expect(result.classification).toBe('general');
      expect(result.originalLength).toBe('My name is Bob, email bob@test.com'.length);
      expect(result.redactedCount).toBe(2);
    });

    it('classifies and sanitizes independently', () => {
      const result = preprocessQuery('Write a function for user@test.com');
      expect(result.sanitized).toContain('[EMAIL]');
      expect(result.classification).toBe('code');
      expect(result.redactedCount).toBe(1);
    });

    it('handles no redactions', () => {
      const result = preprocessQuery('Explain how sorting works');
      expect(result.sanitized).toBe('Explain how sorting works');
      expect(result.classification).toBe('reasoning');
      expect(result.redactedCount).toBe(0);
    });
  });
});
