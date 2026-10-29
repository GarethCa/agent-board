import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import type { ChatEntry, PermissionPrompt, PlanSummary } from '@agent-board/daemon/protocol';
import { createTranscriptParser } from '@agent-board/daemon/transcript-adapters';
import { chatItems } from './chat';
import { liveCallId, liveState, type LiveFacts } from './chat-live';

/** A recorded Claude transcript's lines. */
const linesOf = (name: string) =>
  readFileSync(new URL(`../../../../../../fixtures/claude/transcripts/${name}.jsonl`, import.meta.url), 'utf8')
    .split('\n')
    .filter((line) => line !== '');

const lines = linesOf('5f0c2a51-7d3e-4b8a-9c11-2e6f0a9b4c7d');
/** A turn a background task's notification started, hours after the last, then a long run and a call turned down. */
const background = linesOf('background-turn');

/** The chat of the transcript's first `count` lines, read as the daemon reads them: its entries and items. */
function chatOf(count = lines.length, from = lines) {
  const parser = createTranscriptParser('claude');
  const entries: ChatEntry[] = from.slice(0, count).flatMap((line) => parser.push(line));
  return { entries, items: chatItems(entries) };
}

/** The live state of `agent` at the end of the chat of the transcript's first `count` lines. */
const liveOf = (agent: LiveFacts, count?: number, from?: string[]) => {
  const { items, entries } = chatOf(count, from);
  return liveState(agent, items, entries);
};

/** The line of the transcript the entry with `text` in it is on, plus one: the transcript up to and including it. */
const through = (text: string, from = lines) => from.findIndex((line) => line.includes(text)) + 1;

const facts = (fields: Partial<LiveFacts> = {}): LiveFacts => ({
  state: 'idle',
  endedAt: null,
  permissions: [],
  ask: null,
  plan: null,
  compactingSince: null,
  notice: null,
  ...fields,
});

const prompt = (toolName: string, subagent: PermissionPrompt['subagent'] = null): PermissionPrompt => ({
  id: 'p1',
  toolName,
  toolInput: { command: 'pnpm lint' },
  subagent,
  requestedAt: '2026-10-10T21:10:15.000Z',
  heldUntil: '2026-10-10T21:11:15.000Z',
});

const plan = (fields: Partial<PlanSummary> = {}): PlanSummary => ({
  id: 'plan-1',
  version: 1,
  title: 'Add the flag',
  format: 'markdown',
  presentedAt: '2026-10-10T21:10:15.000Z',
  expiresAt: null,
  left: false,
  decision: null,
  author: 'agent',
  path: null,
  ...fields,
});

describe('the live state at the end of the chat, from a recorded transcript and the agent', () => {
  test('between turns: how the last turn ended, done with how long it took, or interrupted', () => {
    // Before Claude writes the turn's length, from its prompt to its last reply; then as Claude counts it.
    const reply = through('Added `--verbose`');
    expect(liveOf(facts(), reply)).toEqual({ kind: 'done', ms: 15_000 });
    expect(liveOf(facts({ state: 'waiting' }), through('"turn_duration"'))).toEqual({ kind: 'done', ms: 52_144 });
    expect(liveOf(facts())).toEqual({ kind: 'interrupted' });
    expect(liveState(facts(), [], [])).toBeUndefined();
  });

  test("a turn a background task's notification started takes its time from Claude, not from the turn before", () => {
    const gate = through('The gate passed.', background);
    // Without Claude's count, from the notification; never from the prompt three hours before.
    expect(liveOf(facts(), gate, background)).toEqual({ kind: 'done', ms: 7_980 });
    expect(liveOf(facts(), gate + 1, background)).toEqual({ kind: 'done', ms: 8_000 });
  });

  test('at work: the call with no result yet, from when it was written, or thinking since the transcript last heard from it', () => {
    const running = through('"pnpm lint"');
    expect(liveOf(facts({ state: 'running' }), running)).toMatchObject({ kind: 'tool', call: { name: 'Bash', input: { command: 'pnpm lint' } }, since: '2026-10-10T21:10:14.000Z' });
    // After a run of calls, from its latest result, five minutes after the run began.
    expect(liveOf(facts({ state: 'thinking' }), through('Tests  412 passed', background), background)).toEqual({ kind: 'thinking', since: '2026-10-20T13:25:00.000Z' });
    // After a background task's notification, which the chat doesn't show, from it.
    expect(liveOf(facts({ state: 'thinking' }), through('"turnOrigin":"task_notification"', background), background)).toEqual({ kind: 'thinking', since: '2026-10-20T13:15:00.020Z' });
    // A call an agent no longer at work never finished is not running.
    expect(liveOf(facts(), running)).toBeUndefined();
  });

  test("a permission prompt stands at its call, the latest waiting with its tool; a subagent's call isn't in this transcript", () => {
    const running = through('"pnpm lint"');
    const live = liveOf(facts({ state: 'needs-permission', permissions: [prompt('Bash')] }), running);
    expect(live).toMatchObject({ kind: 'permission', prompt: { id: 'p1' }, call: { id: 'toolu_01Bash000000000000000005' } });
    expect(liveCallId(live)).toBe('toolu_01Bash000000000000000005');
    const sub = liveOf(facts({ state: 'needs-permission', permissions: [prompt('Bash', { id: 'a1', type: 'Explore' })] }), running);
    expect(sub).toMatchObject({ kind: 'permission' });
    expect(liveCallId(sub)).toBeUndefined();
  });

  test('waiting on you comes first: a prompt, then a question, then a plan; a plan the agent left waits on nothing', () => {
    const ask = { id: 'q1', question: 'Stack codes?', options: ['Yes', 'No'], freeText: true, askedAt: 't', expiresAt: 't', onBoard: false, at: null };
    const count = through('"pnpm lint"');
    expect(liveOf(facts({ state: 'waiting', ask, plan: plan(), permissions: [prompt('Bash')] }), count)?.kind).toBe('permission');
    expect(liveOf(facts({ state: 'waiting', ask, plan: plan() }), count)).toMatchObject({ kind: 'ask', ask: { id: 'q1' } });
    expect(liveOf(facts({ state: 'waiting', plan: plan() }), count)).toMatchObject({ kind: 'plan', plan: { id: 'plan-1' } });
    expect(liveOf(facts({ plan: plan({ left: true }) }), count)?.kind).not.toBe('plan');
    expect(liveOf(facts({ plan: plan({ decision: { outcome: 'approved', comments: '', decidedAt: 't' } }) }), count)?.kind).not.toBe('plan');
  });

  test('then its usage limit, compacting and a failed turn', () => {
    expect(liveOf(facts({ state: 'rate-limited' }))).toEqual({ kind: 'rate-limited' });
    expect(liveOf(facts({ state: 'thinking', compactingSince: '2026-10-10T21:11:00.000Z' }))).toEqual({ kind: 'compacting', since: '2026-10-10T21:11:00.000Z' });
    expect(liveOf(facts({ state: 'failed', notice: 'API error: overloaded' }))).toEqual({ kind: 'failed', text: 'API error: overloaded' });
    expect(liveOf(facts({ state: 'failed' }))).toEqual({ kind: 'failed', text: 'The turn failed.' });
  });
});

describe('the chat of a recorded transcript with a background task', () => {
  const { items } = chatOf(background.length, background);

  test("thinking is timed from what started it: a notification hours after the turn before, or the last result of a long run, not Claude's records beside it", () => {
    expect(items.filter((item) => item.kind === 'thinking').map((item) => item.ms)).toEqual([3_000, 6_500, 4_000]);
  });

  test('a call the user turned down is stopped, and the interruption names it', () => {
    expect(items.at(-1)).toMatchObject({ kind: 'interrupted', stopped: { name: 'Bash', input: { command: 'git push' }, stopped: true } });
  });
});
