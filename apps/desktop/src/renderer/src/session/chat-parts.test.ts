import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import { CallOutcome, liveLine } from './chat-parts';
import type { ToolCall } from './chat';

const START = '2026-10-10T10:00:00.000Z';
const at = (ms: number) => Date.parse(START) + ms;

describe('the time a live state shows', () => {
  test('thinking and compacting count whole seconds, then minutes', () => {
    const rows: [number, string][] = [
      [0, '0s'],
      [1_400, '1s'],
      [9_900, '9s'],
      [59_000, '59s'],
      [65_400, '1m 5s'],
    ];
    for (const [ms, shown] of rows) {
      expect(liveLine({ kind: 'thinking', since: START }, at(ms)).time, `thinking ${ms} ms`).toBe(shown);
      expect(liveLine({ kind: 'compacting', since: START }, at(ms)).time, `compacting ${ms} ms`).toBe(shown);
    }
  });

  test('a running tool counts whole seconds too', () => {
    const call: ToolCall = { kind: 'call', id: 'x', name: 'Bash', input: { command: 'npm test' }, at: START };
    expect(liveLine({ kind: 'tool', call }, at(2_400)).time).toBe('2s');
  });

  test('a turn that is done shows its precise time', () => {
    expect(liveLine({ kind: 'done', ms: 2_400 }, at(0)).time).toBe('2.4s');
  });

  test("a call's outcome counts whole seconds while it runs, and shows its precise time once it is done", () => {
    const running: ToolCall = { kind: 'call', id: 'x', name: 'Bash', input: { command: 'npm test' }, at: START };
    const done: ToolCall = { ...running, result: { output: '12 passed', isError: false, at: '2026-10-10T10:00:02.400Z' } };
    const text = (call: ToolCall, status: 'running' | 'done') => renderToStaticMarkup(createElement(CallOutcome, { call, status, now: at(2_400) })).replace(/<[^>]*>/g, '');
    expect(text(running, 'running')).toBe('2s');
    expect(text(done, 'done')).toBe('12 passed · 2.4s');
  });
});
