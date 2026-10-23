import { afterEach, describe, expect, it } from 'vitest';
import { createFakeClock } from './fake-clock.ts';
import { createHookStates, type HookStateRow } from '../src/hook-states.ts';
import { createPermissionHolds, type PermissionHolds } from '../src/permissions.ts';
import type { SessionState } from '../src/protocol.ts';
import { createSubagentStore } from '../src/subagents.ts';

const row = (sessionId: string, fields: Partial<HookStateRow> = {}): HookStateRow => ({
  session_id: sessionId,
  harness: 'claude',
  state: 'idle',
  description: 'a task',
  ended_at: null,
  ...fields,
});

let holds: PermissionHolds | undefined;

afterEach(() => holds?.close());

/** Hook states over the agent `start`, recording what is saved, unseen and finished. */
function setup(start: HookStateRow) {
  let current = start;
  const clock = createFakeClock(new Date('2026-01-01T00:00:00Z'));
  const startingEnded: string[] = [];
  const saved: { state: SessionState; always: boolean }[] = [];
  const unseen: string[] = [];
  const finished: [string, string][] = [];
  const order: string[] = [];
  holds = createPermissionHolds({ holdMs: 60_000, onChange: () => {} });
  const states = createHookStates<HookStateRow>({
    permissions: holds,
    subagents: createSubagentStore(),
    save(saving, state, _next, always) {
      order.push(`save ${state}`);
      saved.push({ state, always });
      current = { ...saving, state };
    },
    unsee: (sessionId) => void unseen.push(sessionId),
    clock,
    startingEnded: (sessionId) => void startingEnded.push(sessionId),
    recordFinal: (_sessionId, finalMessage) => void order.push(`record ${finalMessage}`),
    finished: (sessionId, finalMessage) => void finished.push([sessionId, finalMessage]),
  });
  const hook = (payload: Record<string, unknown>) => states.onHook(current, payload, new AbortController().signal);
  return { states, hook, saved, unseen, finished, order, clock, startingEnded, row: () => current };
}

describe('a starting agent', () => {
  it('failed to start when its process exits while it is starting, until it is started again or deleted', () => {
    const { states, hook } = setup(row('a'));
    states.promptQueued('a');
    states.ended('a');
    expect(states.startFailed('a')).toBe(true);
    expect(states.isStarting('a')).toBe(false);
    states.promptQueued('a');
    expect(states.startFailed('a')).toBe(false);
    states.ended('a');
    states.relaunched('a');
    expect(states.startFailed('a')).toBe(false);
    states.promptQueued('a');
    states.ended('a');
    states.deleted('a');
    expect(states.startFailed('a')).toBe(false);

    // One that came up first, and exited later, did not fail to start.
    states.promptQueued('a');
    hook({ hook_event_name: 'SessionStart' });
    states.ended('a');
    expect(states.startFailed('a')).toBe(false);
  });

  it('is starting from its first prompt until its first hook', () => {
    const { states, hook, row: now } = setup(row('a'));
    states.promptQueued('a');
    expect(states.isStarting('a')).toBe(true);
    hook({ hook_event_name: 'SessionStart' });
    expect(states.isStarting('a')).toBe(false);
    expect(now().state).toBe('running');
  });

  it('stops being on output only once hooks have been late for a while', () => {
    const { states, clock, startingEnded } = setup(row('a'));
    states.promptQueued('a');
    states.outputSeen('a'); // the TUI drawing, as every session does at once
    expect(states.isStarting('a')).toBe(true);
    clock.advance(5_000);
    states.outputSeen('a');
    expect(states.isStarting('a')).toBe(false);
    expect(startingEnded).toEqual(['a']);
  });

  it('gives up after a bounded time with no hook and no output, and says so', () => {
    const { states, clock, startingEnded } = setup(row('a'));
    states.promptQueued('a');
    clock.advance(59_999);
    expect(states.isStarting('a')).toBe(true);
    clock.advance(1);
    expect(states.isStarting('a')).toBe(false);
    expect(startingEnded).toEqual(['a']);
    expect(clock.pending()).toBe(0);
  });

  it('leaves no timer behind once a hook, the end or a delete ends it', () => {
    const { states, hook, clock, startingEnded } = setup(row('a'));
    states.promptQueued('a');
    hook({ hook_event_name: 'SessionStart' });
    states.promptQueued('a');
    states.ended('a');
    states.promptQueued('a');
    states.deleted('a');
    expect(clock.pending()).toBe(0);
    expect(startingEnded).toEqual([]);
  });

  it("is not kept idle by its first hook when only a role template, not a typed task, is its prompt", () => {
    const { states, hook, row: now } = setup(row('a', { description: '' }));
    states.promptQueued('a');
    hook({ hook_event_name: 'SessionStart' });
    expect(now().state).toBe('running');
  });

  it('with no prompt at all, stays idle on its first hook', () => {
    const { hook, row: now } = setup(row('a', { description: '' }));
    hook({ hook_event_name: 'SessionStart' });
    expect(now().state).toBe('idle');
  });
  it('resumed (woken, or after a restart) with no new prompt, stays idle at its prompt on its SessionStart', () => {
    const { hook, row: now } = setup(row('a'));
    hook({ hook_event_name: 'SessionStart', source: 'resume' });
    expect(now().state).toBe('idle');
    // The prompt it was resumed with moves it on at its own hook.
    hook({ hook_event_name: 'UserPromptSubmit', prompt: 'Now run the linter' });
    expect(now().state).toBe('thinking');
  });

  it('resumed with a queued prompt, or started afresh on its task, runs from its SessionStart', () => {
    const resumed = setup(row('a'));
    resumed.states.promptQueued('a');
    resumed.hook({ hook_event_name: 'SessionStart', source: 'resume' });
    expect(resumed.row().state).toBe('running');
    const fresh = setup(row('b'));
    fresh.hook({ hook_event_name: 'SessionStart', source: 'startup' });
    expect(fresh.row().state).toBe('running');
  });
});

describe('hook states', () => {
  it('keeps the final message before it saves the state that says the turn ended, and announces it then', () => {
    const { hook, saved, order } = setup(row('a'));
    hook({ hook_event_name: 'UserPromptSubmit', prompt: 'go' });
    hook({ hook_event_name: 'Stop', last_assistant_message: 'Done.' });
    expect(order.slice(-2)).toEqual(['record Done.', 'save idle']);
    expect(saved.at(-1)!.always).toBe(true);
  });

  it('takes an agent through a turn, and hands off its final message when it stops', () => {
    const { states, hook, saved, finished, row: now } = setup(row('a'));
    hook({ hook_event_name: 'UserPromptSubmit', prompt: 'go' });
    expect(now().state).toBe('thinking');
    expect(states.whyNotReady(now())).toBe('it was still working');
    hook({ hook_event_name: 'Stop', last_assistant_message: 'Done.' });
    expect(saved.map(({ state }) => state)).toEqual(['thinking', 'idle']);
    expect(finished).toEqual([['a', 'Done.']]);
    expect(states.lastMessage('a')).toBe('Done.');
    expect(states.whyNotReady(now())).toBeUndefined();
  });

  it("shows a turn that ended on a question as waiting for you, even when it's scheduled", () => {
    const { states, hook, row: now } = setup(row('a', { state: 'thinking' }));
    hook({ hook_event_name: 'Stop', last_assistant_message: 'Which branch?' });
    expect(states.scheduledState(now())).toBe('waiting');
    expect(states.whyNotReady(now())).toBe('it was waiting for you');
    expect(states.whyNotReady(now(), true)).toBeUndefined();
  });

  it('counts an agent its idle prompt left waiting as at its prompt, ready for its next run', () => {
    const { states, hook, row: now } = setup(row('a'));
    hook({ hook_event_name: 'Notification', notification_type: 'idle_prompt' });
    expect(now().state).toBe('waiting');
    expect(states.scheduledState(now())).toBe('scheduled');
  });

  it("tells its idle prompt from Claude's own question, both of which leave it waiting", () => {
    const { states, hook, row: now } = setup(row('a', { state: 'thinking' }));
    hook({ hook_event_name: 'Stop', last_assistant_message: 'Done.' });
    hook({ hook_event_name: 'Notification', notification_type: 'idle_prompt' });
    expect(now().state).toBe('waiting');
    expect(states.idlePrompted('a')).toBe(true);

    hook({ hook_event_name: 'UserPromptSubmit', prompt: 'go on' });
    hook({ hook_event_name: 'Notification', notification_type: 'agent_needs_input', message: 'Which branch?' });
    expect(now().state).toBe('waiting');
    expect(states.idlePrompted('a')).toBe(false);
  });

  it('holds a permission request as a new ask, and drops its late echo once it is settled', () => {
    const { hook, unseen, saved, row: now } = setup(row('a', { state: 'running' }));
    const tool = { tool_name: 'Bash', tool_input: { command: 'ls' } };
    expect(hook({ hook_event_name: 'PermissionRequest', ...tool })).toBeInstanceOf(Promise);
    expect(unseen).toEqual(['a']);
    expect(now().state).toBe('needs-permission');
    // Answered in the terminal: the tool ran.
    hook({ hook_event_name: 'PostToolUse', ...tool });
    expect(now().state).toBe('thinking');
    const before = saved.length;
    expect(hook({ hook_event_name: 'Notification', notification_type: 'permission_prompt' })).toBeUndefined();
    expect(now().state).toBe('thinking');
    expect(saved).toHaveLength(before);
  });

  it("ignores an interrupted turn's work still landing, until the next prompt", () => {
    const { states, hook, saved, row: now } = setup(row('a'));
    states.interrupted('a');
    hook({ hook_event_name: 'PostToolUse', tool_name: 'Bash' });
    expect(saved).toEqual([]);
    hook({ hook_event_name: 'UserPromptSubmit', prompt: 'again' });
    hook({ hook_event_name: 'PostToolUse', tool_name: 'Bash' });
    expect(now().state).toBe('thinking');
    expect(saved).toHaveLength(2);
  });

  it('starts an agent with no task idle for its first message', () => {
    const { hook, row: now } = setup(row('a', { description: '' }));
    hook({ hook_event_name: 'SessionStart' });
    expect(now().state).toBe('idle');
  });

  it('holds a run back while you type at its prompt, until you submit', () => {
    const { states, hook, row: now } = setup(row('a'));
    states.typed('a', 'half a th');
    expect(states.whyNotReady(now())).toBe('you were typing in its terminal');
    hook({ hook_event_name: 'UserPromptSubmit', prompt: 'half a thought' });
    hook({ hook_event_name: 'Stop', last_assistant_message: 'Ok.' });
    expect(states.whyNotReady(now())).toBeUndefined();
  });

  it('forgets what a relaunched agent said and typed, and keeps whether its idle prompt left it waiting', () => {
    const { states, hook, saved, row: now } = setup(row('a'));
    hook({ hook_event_name: 'Stop', last_assistant_message: 'Done.' });
    hook({ hook_event_name: 'Notification', notification_type: 'idle_prompt' });
    states.typed('a', 'ma');
    states.relaunched('a');
    expect(states.lastMessage('a')).toBeUndefined();
    expect(states.whyNotReady(now())).toBeUndefined();
    expect(states.scheduledState(now())).toBe('scheduled');
    // Still interrupted: its old turn's work landing late stays stale.
    states.interrupted('a');
    states.relaunched('a');
    const before = saved.length;
    hook({ hook_event_name: 'PostToolUse', tool_name: 'Bash' });
    expect(saved).toHaveLength(before);
  });

  it('keeps that a relaunched agent had its permission prompt settled', () => {
    const { states, hook, row: now } = setup(row('a'));
    states.permissionDecided('a');
    states.relaunched('a');
    expect(hook({ hook_event_name: 'Notification', notification_type: 'permission_prompt' })).toBeUndefined();
    expect(now().state).toBe('idle');
  });

  it('forgets what an ended agent waited on and was typed at it, and keeps what it last said', () => {
    const { states, hook, saved, row: now } = setup(row('a'));
    hook({ hook_event_name: 'Stop', last_assistant_message: 'Which branch?' });
    hook({ hook_event_name: 'Notification', notification_type: 'idle_prompt' });
    states.interrupted('a');
    states.permissionDecided('a');
    states.ended('a');
    states.typed('b', 'ma');
    states.ended('b');
    expect(states.whyNotReady(row('b'))).toBeUndefined();
    // An ended tile still shows its last message.
    expect(states.lastMessage('a')).toBe('Which branch?');
    expect(states.scheduledState(now())).toBe('waiting');
    hook({ hook_event_name: 'Notification', notification_type: 'permission_prompt' });
    expect(now().state).toBe('needs-permission');
    const before = saved.length;
    hook({ hook_event_name: 'PostToolUse', tool_name: 'Bash' });
    expect(saved).toHaveLength(before + 1);
  });

  it('forgets that an ended agent was at its idle prompt', () => {
    const { states, hook, row: now } = setup(row('c'));
    hook({ hook_event_name: 'Stop', last_assistant_message: 'Done.' });
    hook({ hook_event_name: 'Notification', notification_type: 'idle_prompt' });
    expect(states.scheduledState(now())).toBe('scheduled');
    states.ended('c');
    expect(states.scheduledState(now())).toBe('waiting');
  });

  it('forgets what a deleted agent said, typed and waited on, but not that it was interrupted', () => {
    const { states, hook, saved, row: now } = setup(row('a'));
    hook({ hook_event_name: 'Stop', last_assistant_message: 'Done.' });
    hook({ hook_event_name: 'Notification', notification_type: 'idle_prompt' });
    states.interrupted('a');
    states.deleted('a');
    states.typed('b', 'ma');
    states.deleted('b');
    expect(states.whyNotReady(row('b'))).toBeUndefined();
    expect(states.lastMessage('a')).toBeUndefined();
    expect(states.scheduledState(now())).toBe('waiting');
    const before = saved.length;
    hook({ hook_event_name: 'PostToolUse', tool_name: 'Bash' });
    expect(saved).toHaveLength(before);
    // The assertion above pins today's behaviour (the interrupted set is never cleaned up on delete), not intent.
  });

  it('keeps that a deleted agent had its permission prompt settled', () => {
    const { states, hook, row: now } = setup(row('a'));
    states.permissionDecided('a');
    states.deleted('a');
    // Pins today's behaviour (the settled set is never cleaned up on delete), not intent: the echo is still dropped.
    hook({ hook_event_name: 'Notification', notification_type: 'permission_prompt' });
    expect(now().state).toBe('idle');
  });
});

describe('where a prompt stands, for pressing Enter on what was typed there', () => {
  it('is at its prompt while idle, idle-prompted, after a failed turn, and a failed turn its idle prompt fired after', () => {
    const idle = setup(row('a'));
    expect(idle.states.promptNow(idle.row())).toBe('at-prompt');
    idle.hook({ hook_event_name: 'Notification', notification_type: 'idle_prompt' });
    expect(idle.row().state).toBe('waiting');
    expect(idle.states.promptNow(idle.row())).toBe('at-prompt');

    const failed = setup(row('a', { state: 'thinking' }));
    failed.hook({ hook_event_name: 'StopFailure', error: 'server_error', last_assistant_message: 'API Error' });
    expect(failed.row().state).toBe('failed');
    expect(failed.states.promptNow(failed.row())).toBe('at-prompt');
    failed.hook({ hook_event_name: 'Notification', notification_type: 'idle_prompt' });
    expect(failed.row().state).toBe('waiting');
    expect(failed.states.promptNow(failed.row())).toBe('at-prompt');
  });

  it('is at its prompt after a turn that ended on a question: a hand-off is its next input either way', () => {
    const { states, hook, row: now } = setup(row('a', { state: 'thinking' }));
    hook({ hook_event_name: 'Stop', last_assistant_message: 'Postgres or SQLite?' });
    expect(states.promptNow(now())).toBe('at-prompt');
  });

  it('is working through its turn, and has moved on on a permission prompt, its own question, a rate limit, or once ended', () => {
    const { states, hook, row: now } = setup(row('a'));
    hook({ hook_event_name: 'UserPromptSubmit', prompt: 'go' });
    expect(states.promptNow(now())).toBe('working');
    hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash' });
    expect(states.promptNow(now())).toBe('working');
    void hook({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'rm -rf dist' } });
    expect(now().state).toBe('needs-permission');
    expect(states.promptNow(now())).toBe('moved-on');
    // A subagent's prompt pending holds it too, whatever its own state says.
    expect(states.promptNow({ ...now(), state: 'idle' })).toBe('moved-on');

    const asking = setup(row('b', { state: 'thinking' }));
    asking.hook({ hook_event_name: 'Notification', notification_type: 'agent_needs_input', message: 'Which branch?' });
    expect(asking.row().state).toBe('waiting');
    expect(asking.states.promptNow(asking.row())).toBe('moved-on');

    const limited = setup(row('c', { state: 'thinking' }));
    limited.hook({ hook_event_name: 'StopFailure', error: 'rate_limit', last_assistant_message: 'API Error: 429' });
    expect(limited.row().state).toBe('rate-limited');
    expect(limited.states.promptNow(limited.row())).toBe('moved-on');
    // Its harness may still show a menu of what to do about the limit, where Enter would pick one: it is still limited.
    limited.hook({ hook_event_name: 'Notification', notification_type: 'idle_prompt' });
    expect(limited.row().state).toBe('rate-limited');
    expect(limited.states.promptNow(limited.row())).toBe('moved-on');

    const ended = setup(row('d'));
    expect(ended.states.promptNow({ ...ended.row(), ended_at: '2026-01-01T00:00:00Z' })).toBe('moved-on');
  });

  it('is being typed at while the user has a draft there, until they submit it', () => {
    const { states, hook, row: now } = setup(row('a'));
    states.typed('a', 'half a th');
    expect(states.promptNow(now())).toBe('typing');
    hook({ hook_event_name: 'UserPromptSubmit', prompt: 'half a thought' });
    expect(states.promptNow(now())).toBe('working');
  });

  it("tells a stale hook of an interrupted turn from news of a new one", () => {
    const { states, hook } = setup(row('a'));
    states.interrupted('a');
    expect(states.isStale('a', { hook_event_name: 'PostToolUse' })).toBe(true);
    expect(states.isStale('a', { hook_event_name: 'UserPromptSubmit' })).toBe(false);
    hook({ hook_event_name: 'UserPromptSubmit', prompt: 'again' });
    expect(states.isStale('a', { hook_event_name: 'PostToolUse' })).toBe(false);
  });
});
