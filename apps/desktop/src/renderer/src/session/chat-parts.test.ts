import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { PermissionDecision, PermissionPrompt } from '@agent-board/daemon/protocol';
import { galleryAgent } from '../board/TileGallery';
import { CallOutcome, LiveActions, LiveTime, liveLine, PlanChoices, type PlanStep } from './chat-parts';
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
    const prompt = { id: 'q', toolName: 'AskUserQuestion', toolInput: { questions }, subagent: null, requestedAt: START, heldUntil: null, asksInTerminal: true, sessionGrant: null, dialog: null, plan: null, questions };
    expect(liveLine({ kind: 'permission', prompt })).toMatchObject({ label: 'Which cache?', detail: 'Which cache? (Redis · In memory)', tone: 'wait' });
  });
});

describe("Claude's plan approval in the chat's live actions", () => {
  const PLAN = '# Add Redis in front of getProduct()\n\n1. Add a `cache.ts` client';
  const planPrompt = (fields: Partial<PermissionPrompt> = {}): PermissionPrompt => ({
    id: 'p1',
    toolName: 'ExitPlanMode',
    toolInput: { plan: PLAN },
    subagent: null,
    requestedAt: START,
    heldUntil: '2026-10-10T11:00:00.000Z',
    asksInTerminal: true,
    sessionGrant: 'all edits',
    questions: null,
    dialog: null,
    plan: PLAN,
    ...fields,
  });
  const agent = { ...galleryAgent('waiting'), sessionId: 's1', name: 'Pick a cache' };
  const actions = (prompt: PermissionPrompt, compact = false) =>
    renderToStaticMarkup(createElement(LiveActions, { agent, live: { kind: 'permission', prompt }, onShowTerminal: () => {}, compact }));

  test('offers Claude’s choices in its words, never Allow and Deny, and points to its terminal for the rest', () => {
    const html = actions(planPrompt());
    expect(html).toContain('Yes, auto-accept edits');
    expect(html).toContain('Yes, approve each edit');
    expect(html).toContain('No, keep planning…');
    expect(html).toContain('Clear context or bypass permissions:');
    expect(html).not.toContain('Allow');
    expect(html).not.toContain('Deny');
  });

  test('the status line folds them to one Answer plan, as an ask’s is one Answer', () => {
    const html = actions(planPrompt(), true);
    expect(html).toContain('Answer plan');
    expect(html).not.toContain('auto-accept');
    expect(html).not.toContain('Allow');
  });

  /** `PlanChoices` drawn at `step`, with every call it makes recorded, and a way to press its controls by their words. */
  const choices = (step: PlanStep, words = '') => {
    const calls = { step: [] as PlanStep[], decide: [] as PermissionDecision[], terminal: 0 };
    const tree = PlanChoices({
      step,
      words,
      busy: false,
      onStep: (next) => calls.step.push(next),
      onWords: () => {},
      onDecide: (decision) => calls.decide.push(decision),
      onShowTerminal: () => calls.terminal++,
    });
    const controls: ReactElement<{ children?: ReactNode; onClick?(): void; onKeyDown?(event: { key: string }): void }>[] = [];
    const walk = (node: ReactNode) => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (!isValidElement<{ children?: ReactNode; onClick?(): void }>(node)) return;
      if (node.props.onClick !== undefined || node.type === 'input') controls.push(node as never);
      walk(node.props.children);
    };
    walk(tree);
    const text = (node: ReactNode): string => (Array.isArray(node) ? node.map(text).join('') : typeof node === 'string' ? node : '');
    const press = (words: string) => controls.find((control) => text(control.props.children) === words)!.props.onClick!();
    const key = (key: string) => controls.find((control) => control.type === 'input')!.props.onKeyDown!({ key });
    return { calls, press, key };
  };

  test('each choice sends its own decision', () => {
    const view = choices('choices');
    view.press('Yes, auto-accept edits');
    view.press('Yes, approve each edit');
    expect(view.calls.decide).toEqual([{ behavior: 'allow', scope: 'session' }, { behavior: 'allow' }]);
    view.press('No, keep planning…');
    expect(view.calls.step).toEqual(['changing']);
    view.press('in its terminal');
    expect(view.calls.terminal).toBe(1);
  });

  test('Answer plan unfolds the choices', () => {
    const view = choices('folded');
    view.press('Answer plan');
    expect([view.calls.step, view.calls.decide]).toEqual([['choices'], []]);
  });

  test('what to change goes with Keep planning or Return, and Cancel or Escape go back without deciding', () => {
    const view = choices('changing', '  Also bust on the stock import ');
    view.press('Keep planning');
    view.key('Enter');
    expect(view.calls.decide).toEqual([
      { behavior: 'deny', message: 'Also bust on the stock import' },
      { behavior: 'deny', message: 'Also bust on the stock import' },
    ]);
    view.press('Cancel');
    view.key('Escape');
    expect(view.calls.step).toEqual(['choices', 'choices']);
    expect(view.calls.decide).toHaveLength(2);
    const empty = choices('changing');
    empty.key('Enter');
    expect(empty.calls.decide).toEqual([{ behavior: 'deny' }]);
  });

  test('sends its terminal there once the hold has lapsed', () => {
    const html = actions(planPrompt({ heldUntil: null }));
    expect(html).toContain('Answer in the terminal');
    expect(html).not.toContain('auto-accept');
  });

  test('reads as its plan, not as allowing its plan tool', () => {
    const line = liveLine({ kind: 'permission', prompt: planPrompt() });
    expect(line.label).toBe('Plan ready');
    expect(line.detail).toBe('Add Redis in front of getProduct()');
  });
});
