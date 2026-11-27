import { describe, expect, it } from 'vitest';
import { scopeText, whenText, whoText } from './list-card-text';

const NOW = new Date(2026, 10, 5, 15, 0);

describe("a list card's text", () => {
  it('says who may use it: its zone, the whole board when loose, or no agents', () => {
    expect(scopeText(false, 'api')).toBe('Zone · api');
    expect(scopeText(false, undefined)).toBe('Board');
    expect(scopeText(true, 'api')).toBe('No agents');
  });

  it('says who wrote a row and when: the time today, the weekday this week, else the date', () => {
    expect(whoText({ kind: 'user' })).toBe('you');
    expect(whoText({ kind: 'agent', sessionId: 's1', name: 'impl-2' })).toBe('impl-2');
    expect(whenText(new Date(2026, 10, 5, 10, 40).toISOString(), NOW)).toBe('10:40');
    expect(whenText(new Date(2026, 10, 2, 10, 40).toISOString(), NOW)).toBe('Mon');
    expect(whenText(new Date(2026, 9, 20, 10, 40).toISOString(), NOW)).toBe('20 Oct');
    expect(whenText('not a date', NOW)).toBe('');
  });
});
