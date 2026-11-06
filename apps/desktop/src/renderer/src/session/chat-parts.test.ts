import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { CallOutcome, LiveTime, liveLine } from './chat-parts';
import { startLiveClock } from './chat';
import type { ToolCall } from './chat';

const START = '2026-10-10T10:00:00.000Z';
const at = (ms: number) => Date.parse(START) + ms;

describe('the time a live state shows', () => {
  const text = (element: ReturnType<typeof createElement>) => renderToStaticMarkup(element).replace(/<[^>]*>/g, '');

  test('thinking and compacting tick in tenths up to a minute, then count minutes', () => {
    const rows: [number, string][] = [
      [0, '0.0s'],
      [100, '0.1s'],
      [200, '0.2s'],
      [9_900, '9.9s'],
      [10_000, '10.0s'],
      [59_900, '59.9s'],
      [65_400, '1m 5s'],
    ];
    for (const kind of ['thinking', 'compacting'] as const) {
      const line = liveLine({ kind, since: START });
      expect(line.since).toBe(START);
      for (const [ms, shown] of rows) {
        expect(text(createElement(LiveTime, { since: START, now: at(ms) })), `${kind} ${ms} ms`).toBe(shown);
      }
    }
  });

  test('a running tool ticks too', () => {
    const call: ToolCall = { kind: 'call', id: 'x', name: 'Bash', input: { command: 'npm test' }, at: START };
    expect(liveLine({ kind: 'tool', call }).since).toBe(START);
  });

  test('a turn that is done shows its precise time, not a ticking one', () => {
    const line = liveLine({ kind: 'done', ms: 2_400 });
    expect([line.time, line.since]).toEqual(['2.4s', undefined]);
  });

  test("a call's outcome ticks in tenths while it runs, and shows its precise time once it is done", () => {
    const running: ToolCall = { kind: 'call', id: 'x', name: 'Bash', input: { command: 'npm test' }, at: START };
    const done: ToolCall = { ...running, result: { output: '12 passed', isError: false, at: '2026-10-10T10:00:02.400Z' } };
    const outcome = (call: ToolCall, status: 'running' | 'done') => text(createElement(CallOutcome, { call, status, now: at(2_400) }));
    expect(outcome(running, 'running')).toBe('2.4s');
    expect(outcome(done, 'done')).toBe('12 passed · 2.4s');
  });
});

describe('the live clock', () => {
  afterEach(() => vi.useRealTimers());

  test('ticks every 100 ms under a minute, every second past it, and stops', () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse(START) + 59_700);
    const ticks: number[] = [];
    const clock = startLiveClock(START, (now) => ticks.push(now - Date.parse(START)));
    vi.advanceTimersByTime(300);
    expect(ticks).toEqual([59_800, 59_900, 60_000]);
    vi.advanceTimersByTime(2_500);
    expect(ticks.slice(3)).toEqual([61_000, 62_000]);
    clock.stop();
    vi.advanceTimersByTime(5_000);
    expect(ticks).toHaveLength(5);
  });

  test('pauses while the window is hidden and ticks again once it is shown', () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse(START));
    let hidden = false;
    let ticks = 0;
    const clock = startLiveClock(START, () => ticks++, () => hidden);
    vi.advanceTimersByTime(200);
    expect(ticks).toBe(2);
    hidden = true;
    vi.advanceTimersByTime(1_000);
    expect(ticks).toBe(2);
    hidden = false;
    clock.resume();
    vi.advanceTimersByTime(100);
    expect(ticks).toBe(4);
    clock.stop();
  });
});

describe("the live line for Claude's question tool", () => {
  test('reads as its question and options, not as an allow', () => {
    const questions = [{ question: 'Which cache?', header: 'Cache', options: [{ label: 'Redis', description: '' }, { label: 'In memory', description: '' }], multiSelect: false }];
    const prompt = { id: 'q', toolName: 'AskUserQuestion', toolInput: { questions }, subagent: null, requestedAt: START, heldUntil: null, asksInTerminal: true, sessionGrant: null, questions };
    expect(liveLine({ kind: 'permission', prompt })).toMatchObject({ label: 'Which cache?', detail: 'Which cache? (Redis · In memory)', tone: 'wait' });
  });
});
