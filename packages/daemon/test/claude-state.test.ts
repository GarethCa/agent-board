import { describe, expect, it } from 'vitest';
import { lastMessageAfterHook, claudeStateAfterHook, stateAfterExit } from '../src/claude-state.ts';
import type { AgentState } from '../src/protocol.ts';

const hook = (hook_event_name: string, fields: Record<string, unknown> = {}) => ({ hook_event_name, ...fields });

describe('Claude hook → agent state (ADR-0004)', () => {
  it.each<[string, Record<string, unknown>, AgentState]>([
    ['SessionStart', { source: 'startup' }, 'running'],
    ['UserPromptSubmit', { prompt: 'fix the tests' }, 'thinking'],
    ['PreToolUse', { tool_name: 'Bash' }, 'running'],
    ['PostToolUse', { tool_name: 'Bash' }, 'thinking'],
    ['PermissionRequest', { tool_name: 'Bash' }, 'needs-permission'],
    ['Notification', { notification_type: 'permission_prompt' }, 'needs-permission'],
    ['Notification', { notification_type: 'idle_prompt' }, 'waiting'],
    ['Notification', { notification_type: 'agent_needs_input' }, 'waiting'],
    ['Stop', { last_assistant_message: 'All tests pass.' }, 'idle'],
    ['StopFailure', { error: 'rate_limit' }, 'rate-limited'],
    ['StopFailure', { error: 'server_error' }, 'failed'],
    ['StopFailure', {}, 'failed'],
    ['SessionEnd', { reason: 'prompt_input_exit' }, 'done'],
  ])('%s %j → %s', (event, fields, expected) => {
    expect(claudeStateAfterHook('running', hook(event, fields))).toBe(expected);
  });

  it.each(['SubagentStart', 'SubagentStop'])('%s leaves the state alone: subagents show as characters', (event) => {
    expect(claudeStateAfterHook('thinking', hook(event, { agent_id: 'a1', agent_type: 'Explore' }))).toBe('thinking');
  });

  it('keeps a rate-limited agent so through its idle prompt: its limit still stops it until a turn starts', () => {
    expect(claudeStateAfterHook('rate-limited', hook('Notification', { notification_type: 'idle_prompt' }))).toBe('rate-limited');
    expect(claudeStateAfterHook('rate-limited', hook('UserPromptSubmit', { prompt: 'continue' }))).toBe('thinking');
  });

  it('ignores notifications it has no state for, and events it does not know', () => {
    expect(claudeStateAfterHook('idle', hook('Notification', { notification_type: 'auth_success' }))).toBe('idle');
    expect(claudeStateAfterHook('running', hook('PreCompact'))).toBe('running');
  });

  it('follows a turn that asks a question, gets an answer and finishes', () => {
    const states: AgentState[] = [];
    let state: AgentState = 'idle';
    for (const [event, fields] of [
      ['SessionStart', { source: 'startup' }],
      ['UserPromptSubmit', { prompt: 'pick a database' }],
      ['Stop', {}],
      ['Notification', { notification_type: 'idle_prompt' }],
      ['UserPromptSubmit', { prompt: 'SQLite' }],
      ['PreToolUse', { tool_name: 'Bash' }],
      ['PostToolUse', { tool_name: 'Bash' }],
      ['Stop', {}],
      ['SessionEnd', { reason: 'prompt_input_exit' }],
    ] as const) {
      state = claudeStateAfterHook(state, hook(event, fields));
      states.push(state);
    }
    expect(states).toEqual(['running', 'thinking', 'idle', 'waiting', 'thinking', 'running', 'thinking', 'idle', 'done']);
  });
});

describe('agent state when its process exits', () => {
  it('is done after a clean exit', () => {
    expect(stateAfterExit('idle', 0)).toBe('done');
  });

  it('is failed after a non-zero exit or a signal', () => {
    expect(stateAfterExit('thinking', 1)).toBe('failed');
    expect(stateAfterExit('waiting', null)).toBe('failed');
  });

  it('stays done once the session has ended itself', () => {
    expect(stateAfterExit('done', null)).toBe('done');
  });
});

describe("an agent's last message to the user, from its Claude hooks", () => {
  it("is its own turn's final message", () => {
    expect(lastMessageAfterHook(null, hook('Stop', { last_assistant_message: 'Which database?' }))).toBe('Which database?');
  });

  it('is a mid-turn request for input, in place of the last turn\'s message', () => {
    const asking = hook('Notification', { notification_type: 'agent_needs_input', message: 'Pick a region' });
    expect(lastMessageAfterHook('Done.', asking)).toBe('Pick a region');
  });

  it("is forgotten when a new prompt starts the next turn, so it can't stand for a later question", () => {
    expect(lastMessageAfterHook('Which database?', hook('UserPromptSubmit', { prompt: 'SQLite' }))).toBeNull();
  });

  it("ignores subagents' hooks, generic notifications and everything else", () => {
    const keep = 'Which database?';
    expect(lastMessageAfterHook(keep, hook('Stop', { agent_id: 'a1', last_assistant_message: 'sub' }))).toBe(keep);
    expect(lastMessageAfterHook(keep, hook('UserPromptSubmit', { agent_id: 'a1' }))).toBe(keep);
    const idle = hook('Notification', { notification_type: 'idle_prompt', message: 'Claude is waiting for your input' });
    expect(lastMessageAfterHook(keep, idle)).toBe(keep);
    expect(lastMessageAfterHook(keep, hook('PreToolUse'))).toBe(keep);
  });
});
