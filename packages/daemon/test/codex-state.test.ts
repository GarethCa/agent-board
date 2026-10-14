import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { codexStateAfterHook } from '../src/codex-state.ts';
import type { AgentState } from '../src/protocol.ts';

/** Every event the spike captured a payload for. */
const EVENTS = [
  'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse',
  'SubagentStart', 'SubagentStop', 'Stop', 'Interrupt', 'PreCompact', 'PostCompact',
];

const fixtures = new URL('../../../fixtures/codex/', import.meta.url);

/** A real payload captured by the spike. */
const captured = (event: string): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(`hooks/${event}.json`, fixtures), 'utf8')) as Record<string, unknown>;

/** The hook payloads of a captured session, in order (notify calls left out: the board doesn't use them). */
function scenario(name: string): Record<string, unknown>[] {
  return readFileSync(new URL(`scenarios/${name}.jsonl`, fixtures), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { kind: string; payload: Record<string, unknown> })
    .filter((call) => call.kind === 'hook')
    .map((call) => call.payload);
}

/** The states an idle, just-spawned agent goes through, without repeats. */
function replay(payloads: Record<string, unknown>[]): AgentState[] {
  const states: AgentState[] = [];
  let state: AgentState = 'idle';
  for (const payload of payloads) {
    state = codexStateAfterHook(state, payload);
    if (states.at(-1) !== state) states.push(state);
  }
  return states;
}

describe('Codex hook → agent state (ADR-0004)', () => {
  it.each<[string, AgentState]>([
    ['SessionStart', 'running'],
    ['UserPromptSubmit', 'thinking'],
    ['PreToolUse', 'running'],
    ['PostToolUse', 'thinking'],
    ['PermissionRequest', 'needs-permission'],
    ['Stop', 'idle'],
    ['Interrupt', 'idle'],
    ['PreCompact', 'running'],
    ['SessionEnd', 'done'],
  ])('captured %s → %s', (event, expected) => {
    expect(codexStateAfterHook('thinking', captured(event))).toBe(expected);
  });

  it('a manual /compact ends at the composer (no Stop follows), an automatic one mid-turn keeps it running', () => {
    expect(captured('PostCompact').trigger).toBe('manual');
    expect(codexStateAfterHook('running', captured('PostCompact'))).toBe('idle');
    expect(codexStateAfterHook('running', { ...captured('PostCompact'), trigger: 'auto' })).toBe('running');
  });

  it.each(['SubagentStart', 'SubagentStop'])('captured %s leaves the state alone: subagents show as characters', (event) => {
    expect(codexStateAfterHook('running', captured(event))).toBe('running');
  });

  it('ignores events it does not know', () => {
    expect(codexStateAfterHook('thinking', { hook_event_name: 'SomethingNew' })).toBe('thinking');
  });

  it('never moves to waiting: Codex has no idle-prompt event', () => {
    const states = EVENTS.map((event) => codexStateAfterHook('idle', captured(event)));
    expect(states).not.toContain('waiting');
  });

  it('replays a TUI session: denied permission, an interrupt, /compact and /quit', () => {
    expect(replay(scenario('tui-permission-interrupt-compact'))).toEqual([
      'running', // SessionStart
      'thinking', // UserPromptSubmit
      'running', // PreToolUse
      'needs-permission', // denied by the hook: no PostToolUse
      'idle', // Stop
      'thinking',
      'running',
      'idle', // Interrupt (no Stop)
      'running', // PreCompact
      'idle', // PostCompact manual
      'done', // SessionEnd
    ]);
  });

  it('replays a TUI session whose permission was allowed: back to thinking on PostToolUse', () => {
    expect(replay(scenario('tui-permission-allow-blocking-hook'))).toEqual([
      'running',
      'thinking',
      'running',
      'needs-permission',
      'thinking',
      'idle',
      'thinking',
      'running',
      'thinking',
      'idle',
    ]);
  });

  it('replays an exec session with a subagent: the parent keeps running while it works', () => {
    expect(replay(scenario('exec-subagent'))).toEqual([
      'running',
      'thinking',
      'running',
      'thinking',
      'running', // spawn_agent's PreToolUse, then SubagentStart/Stop change nothing
      'thinking',
      'idle',
      'done',
    ]);
  });

  it.each(['exec-shell', 'exec-sandboxed-network'])('replays %s', (name) => {
    expect(replay(scenario(name))).toEqual(['running', 'thinking', 'running', 'thinking', 'idle', 'done']);
  });
});

