import { afterEach, describe, expect, it } from 'vitest';
import { createFakeClock } from './fake-clock.ts';
import { createHookStates, DRAFT_HOLD_MS, USER_QUEUE_HOLD_MS, USER_QUEUED_REASON, type HookStateRow } from '../src/hook-states.ts';
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
function setup(
  start: HookStateRow,
  firstPromptDue = false,
  onCommand = false,
  silentChanged?: (sessionId: string, silent: boolean) => void,
  silent?: string[],
) {
  let current = start;
  const clock = createFakeClock(new Date('2026-01-01T00:00:00Z'));
  const startingEnded: string[] = [];
  const saved: { state: SessionState; always: boolean }[] = [];
  const unseen: string[] = [];
  const finished: [string, string][] = [];
  const order: string[] = [];
  const logged: string[] = [];
  const lapsed: string[] = [];
  holds = createPermissionHolds({ holdMs: 60_000, askingHoldMs: 600_000, onChange: () => {} });
  const states = createHookStates<HookStateRow>({
    permissions: holds,
    subagents: createSubagentStore(),
    firstPromptDue: () => firstPromptDue,
    onCommand: () => onCommand,
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
    log: (message) => void logged.push(message),
    silentChanged,
    silent,
    userQueueLapsed: (sessionId) => void lapsed.push(sessionId),
  });
  const hook = (payload: Record<string, unknown>) => states.onHook(current, payload, new AbortController().signal);
  return { states, hook, saved, unseen, finished, order, clock, startingEnded, logged, lapsed, row: () => current };
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

  it('with its first prompt still to be typed, sits idle at its prompt and starting from its SessionStart until that prompt goes up', () => {
    const { states, hook, row: now, clock, startingEnded } = setup(row('a'), true);
    states.promptQueued('a');
    clock.advance(10_000);
    hook({ hook_event_name: 'SessionStart', source: 'startup' });
    expect(states.isStarting('a')).toBe(true);
    expect(now().state).toBe('idle');
    expect(states.isAtPrompt(now())).toBe(true);
    expect(states.isUp('a')).toBe(true);
    // The prompt drawn as it is typed, however slowly, is no sign of hooks not arriving.
    states.outputSeen('a');
    clock.advance(10_000);
    states.outputSeen('a');
    expect(startingEnded).toEqual([]);
    hook({ hook_event_name: 'UserPromptSubmit', prompt: 'a task' });
    expect(states.isStarting('a')).toBe(false);
    expect(now().state).toBe('thinking');
  });

  it('gives up on a first prompt typed at its prompt a minute after its SessionStart, not before', () => {
    const { states, hook, clock, startingEnded } = setup(row('a'), true);
    states.promptQueued('a');
    clock.advance(50_000);
    hook({ hook_event_name: 'SessionStart', source: 'startup' });
    clock.advance(59_000);
    expect(states.isStarting('a')).toBe(true);
    clock.advance(1_000);
    expect(states.isStarting('a')).toBe(false);
    expect(startingEnded).toEqual(['a']);
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

  it('heard from by no hook a minute after it started, is flagged as silent until its first hook, which is saved and told', () => {
    const changed: [string, boolean][] = [];
    const { states, hook, clock, saved } = setup(row('a'), false, false, (sessionId, silent) => void changed.push([sessionId, silent]));
    states.promptQueued('a');
    clock.advance(59_999);
    expect(states.hooksSilent('a')).toBe(false);
    clock.advance(1);
    expect(states.hooksSilent('a')).toBe(true);
    expect(changed).toEqual([['a', true]]);
    hook({ hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'Claude is waiting for your input' });
    expect(states.hooksSilent('a')).toBe(false);
    expect(changed).toEqual([['a', true], ['a', false]]);
    expect(saved.at(-1)?.always).toBe(true);
  });

  it('given up on by its output after 5 s, is not flagged as silent until a minute has gone by with no hook', () => {
    const { states, clock } = setup(row('a'));
    states.promptQueued('a');
    clock.advance(5_000);
    states.outputSeen('a');
    expect(states.isStarting('a')).toBe(false);
    expect(states.hooksSilent('a')).toBe(false);
    clock.advance(54_999);
    expect(states.hooksSilent('a')).toBe(false);
    clock.advance(1);
    expect(states.hooksSilent('a')).toBe(true);

    // A slow start whose hook lands late, after its output gave it up: never flagged.
    const slow = setup(row('b'));
    slow.states.promptQueued('b');
    slow.clock.advance(5_000);
    slow.states.outputSeen('b');
    slow.clock.advance(20_000);
    slow.hook({ hook_event_name: 'SessionStart' });
    slow.clock.advance(60_000);
    expect(slow.states.hooksSilent('b')).toBe(false);
    expect(slow.clock.pending()).toBe(0);
  });

  it('up by its screen and still starting at a minute, is flagged only when it is given up on with no hook', () => {
    const { states, clock } = setup(row('a', { harness: 'codex' }));
    states.promptQueued('a');
    clock.advance(30_000);
    states.composerUp('a');
    clock.advance(30_000);
    expect(states.isStarting('a')).toBe(true);
    expect(states.hooksSilent('a')).toBe(false);
    clock.advance(30_000);
    expect(states.isStarting('a')).toBe(false);
    expect(states.hooksSilent('a')).toBe(true);
  });

  it('is not flagged as silent when a hook came before the minute was up, or after it came up', () => {
    const { states, hook, clock } = setup(row('a'), true);
    states.promptQueued('a');
    hook({ hook_event_name: 'SessionStart', source: 'startup' });
    clock.advance(60_000);
    expect(states.isStarting('a')).toBe(false);
    expect(states.hooksSilent('a')).toBe(false);

    const quick = setup(row('b'));
    quick.states.promptQueued('b');
    quick.hook({ hook_event_name: 'SessionStart' });
    quick.clock.advance(60_000);
    expect(quick.states.hooksSilent('b')).toBe(false);
  });

  it('stays silent when it ends, is relaunched or started again, and drops it only on its first hook or its delete', () => {
    const { states, hook, clock } = setup(row('a'));
    states.promptQueued('a');
    clock.advance(60_000);
    expect(states.hooksSilent('a')).toBe(true);
    states.ended('a');
    states.relaunched('a');
    expect(states.hooksSilent('a')).toBe(true);
    states.promptQueued('a');
    clock.advance(60_000);
    expect(states.hooksSilent('a')).toBe(true);
    hook({ hook_event_name: 'SessionStart' });
    expect(states.hooksSilent('a')).toBe(false);

    states.promptQueued('a');
    clock.advance(60_000);
    expect(states.hooksSilent('a')).toBe(true);
    states.deleted('a');
    expect(states.hooksSilent('a')).toBe(false);
  });

  it('starts with the agents kept as silent, until each one sends a hook', () => {
    const { states, hook } = setup(row('a'), false, false, undefined, ['a']);
    expect(states.hooksSilent('a')).toBe(true);
    hook({ hook_event_name: 'SessionStart' });
    expect(states.hooksSilent('a')).toBe(false);
  });

  it('drops it on a stale hook of an interrupted turn too, and says so though that hook saves nothing', () => {
    const changed: [string, boolean][] = [];
    const { states, hook, saved } = setup(row('a'), false, false, (id, silent) => changed.push([id, silent]), ['a']);
    states.interrupted('a');
    hook({ hook_event_name: 'PostToolUse', tool_name: 'Bash' });
    expect(saved).toEqual([]);
    expect(states.hooksSilent('a')).toBe(false);
    expect(changed).toEqual([['a', false]]);
  });

  it('is not flagged when its process exits before the minute is up', () => {
    const { states, clock } = setup(row('a'));
    states.promptQueued('a');
    clock.advance(10_000);
    states.ended('a');
    clock.advance(60_000);
    expect(states.hooksSilent('a')).toBe(false);
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
    expect(states.waitsAtPrompt('a')).toBe(true);

    hook({ hook_event_name: 'UserPromptSubmit', prompt: 'go on' });
    hook({ hook_event_name: 'Notification', notification_type: 'agent_needs_input', message: 'Which branch?' });
    expect(now().state).toBe('waiting');
    expect(states.waitsAtPrompt('a')).toBe(false);
  });

  it("keeps an agent whose turn ended at its prompt when Claude says another session needs input, its idle prompt after", () => {
    const { states, hook, logged, row: now } = setup(row('a', { state: 'thinking' }));
    hook({ hook_event_name: 'Stop', last_assistant_message: 'Review written.' });
    hook({ hook_event_name: 'Notification', notification_type: 'agent_needs_input', message: 'Docs pass needs your input: which branch?' });
    hook({ hook_event_name: 'Notification', notification_type: 'idle_prompt' });
    expect(logged).toEqual(['agent a went waiting at its prompt, its turn ended: Notification agent_needs_input "Docs pass needs your input: which branch?"']);

    expect(now().state).toBe('waiting');
    // What crew events read: not a question for its orchestrator, and waiting only as idle is.
    expect(states.waitsAtPrompt('a')).toBe(true);
    expect(states.isAtPrompt(now())).toBe(true);
    expect(states.promptNow(now())).toBe('at-prompt');
    expect(states.whyNotReady(now())).toBeUndefined();
    // Another session's question is not the agent's last word.
    expect(states.lastMessage('a')).toBe('Review written.');
  });

  it('keeps an agent at its prompt when Claude says another session needs input after its idle prompt', () => {
    const { states, hook, row: now } = setup(row('a', { state: 'thinking' }));
    hook({ hook_event_name: 'Stop', last_assistant_message: 'Review written.' });
    hook({ hook_event_name: 'Notification', notification_type: 'idle_prompt' });
    hook({ hook_event_name: 'Notification', notification_type: 'agent_needs_input', message: 'Docs pass needs your input: which branch?' });

    expect(states.promptNow(now())).toBe('at-prompt');
    expect(states.lastMessage('a')).toBe('Review written.');
  });

  it('stays idle, not waiting, when Claude says another session needs input while a command it left runs', () => {
    const { hook, row: now } = setup(row('a', { state: 'thinking' }), false, true);
    hook({ hook_event_name: 'Stop', last_assistant_message: 'Gate started.' });
    hook({ hook_event_name: 'Notification', notification_type: 'agent_needs_input', message: 'Docs pass needs your input' });
    expect(now().state).toBe('idle');
  });

  it.each([
    ['notice first', ['notice', 'idle']],
    ['idle prompt first', ['idle', 'notice']],
  ])('keeps a failed turn at its prompt when Claude says another session needs input (%s)', (_order, steps) => {
    const { states, hook, logged, row: now } = setup(row('a', { state: 'thinking' }));
    hook({ hook_event_name: 'StopFailure', error: 'server_error', last_assistant_message: 'API Error: overloaded' });
    for (const step of steps) {
      if (step === 'notice') hook({ hook_event_name: 'Notification', notification_type: 'agent_needs_input', message: 'Docs pass needs your input: which branch?' });
      else hook({ hook_event_name: 'Notification', notification_type: 'idle_prompt' });
    }

    expect(now().state).toBe('waiting');
    expect(states.promptNow(now())).toBe('at-prompt');
    expect(states.lastMessage('a')).toBeUndefined();
    expect(logged).toEqual([expect.stringMatching(/^agent a went waiting at its prompt, its turn ended: /)]);
  });

  it('keeps a rate-limited agent rate-limited when Claude says another session needs input', () => {
    const { states, hook, row: now } = setup(row('a', { state: 'thinking' }));
    hook({ hook_event_name: 'StopFailure', error: 'rate_limit', last_assistant_message: 'Limit reached' });
    hook({ hook_event_name: 'Notification', notification_type: 'agent_needs_input', message: 'Docs pass needs your input' });
    hook({ hook_event_name: 'Notification', notification_type: 'idle_prompt' });

    expect(now().state).toBe('rate-limited');
    expect(states.lastMessage('a')).toBeUndefined();
  });

  it("counts a dialog of Claude's own at its prompt as a question up: never typed into, and it is what the agent last said", () => {
    const { states, hook, logged, row: now } = setup(row('a', { state: 'thinking' }), false, true);
    hook({ hook_event_name: 'Stop', last_assistant_message: 'Review written.' });
    const notice = 'Auto mode has a classifier billing notice to acknowledge';
    hook({ hook_event_name: 'Notification', notification_type: 'agent_needs_input', message: notice });
    hook({ hook_event_name: 'Notification', notification_type: 'idle_prompt' });

    // Over a command it left running too: the dialog is up all the same.
    expect(now().state).toBe('waiting');
    expect(states.promptNow(now())).toBe('moved-on');
    expect(states.waitsAtPrompt('a')).toBe(false);
    expect(states.lastMessage('a')).toBe(notice);
    expect(logged).toEqual([`agent a went waiting from idle, a dialog of Claude's own up: Notification agent_needs_input "${notice}"`]);
  });

  it.each([
    ['its turn ended', { hook_event_name: 'Stop', last_assistant_message: 'Review written.' }],
    ['its turn failed', { hook_event_name: 'StopFailure', error: 'server_error', last_assistant_message: 'API Error: overloaded' }],
  ])("counts a dialog of Claude's own as a question up when it opens after its idle prompt (%s)", (_how, end) => {
    const { states, hook, logged, unseen, row: now } = setup(row('a', { state: 'thinking' }));
    hook(end);
    hook({ hook_event_name: 'Notification', notification_type: 'idle_prompt' });
    expect(states.promptNow(now())).toBe('at-prompt');
    logged.length = 0;
    unseen.length = 0;

    const notice = 'Auto mode has a classifier billing notice to acknowledge';
    hook({ hook_event_name: 'Notification', notification_type: 'agent_needs_input', message: notice });

    expect(now().state).toBe('waiting');
    expect(states.promptNow(now())).toBe('moved-on');
    expect(states.waitsAtPrompt('a')).toBe(false);
    expect(states.lastMessage('a')).toBe(notice);
    // A new ask, as one moving it to waiting would be.
    expect(unseen).toEqual(['a']);
    expect(logged).toEqual([`agent a has a dialog of Claude's own up at its prompt: Notification agent_needs_input "${notice}"`]);
  });

  it('still counts a request for input during a turn as a question up, not the prompt', () => {
    const { states, hook, logged, row: now } = setup(row('a', { state: 'thinking' }));
    hook({ hook_event_name: 'Notification', notification_type: 'agent_needs_input', message: 'Which branch?' });
    hook({ hook_event_name: 'Notification', notification_type: 'idle_prompt' });
    expect(logged).toEqual(['agent a went waiting from thinking, a question of its own up: Notification agent_needs_input "Which branch?"']);

    expect(now().state).toBe('waiting');
    expect(states.promptNow(now())).toBe('moved-on');
    expect(states.lastMessage('a')).toBe('Which branch?');
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

  it("holds Claude's own request for the long hold, as its terminal asks too, and a subagent's or Codex's for the short one", () => {
    const tool = { tool_name: 'Bash', tool_input: { command: 'ls' } };
    const asks = (start: HookStateRow, fields: Record<string, unknown> = {}) => {
      const { hook } = setup(start);
      void hook({ hook_event_name: 'PermissionRequest', ...tool, ...fields });
      const asked = holds!.prompts(start.session_id)[0]!.asksInTerminal;
      holds!.close();
      return asked;
    };
    expect(asks(row('a', { state: 'running' }))).toBe(true);
    expect(asks(row('b', { state: 'running' }), { agent_id: 'sub', agent_type: 'Explore' })).toBe(false);
    expect(asks(row('c', { state: 'running', harness: 'codex' }))).toBe(false);
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

  it('keeps a draft too long for one row of its terminal through Ctrl-U, which clears only the last row', () => {
    const { states, row: now } = setup(row('a'));
    states.typed('a', 'x'.repeat(150), now(), 80);
    states.typed('a', '\x15', now(), 80);
    expect(states.isDrafting('a')).toBe(true);
    states.typed('a', '\x03', now(), 80);
    states.typed('a', 'x'.repeat(40), now(), 80);
    states.typed('a', '\x15', now(), 80);
    expect(states.isDrafting('a')).toBe(false);
  });

  it('is being typed at while the user has a draft there, until they submit it', () => {
    const { states, hook, row: now } = setup(row('a'));
    states.typed('a', 'half a th');
    expect(states.promptNow(now())).toBe('typing');
    hook({ hook_event_name: 'UserPromptSubmit', prompt: 'half a thought' });
    expect(states.promptNow(now())).toBe('working');
  });

  it('holds back what others send for a while after the last key at a draft, as the board may have it wrong', () => {
    const { states, row: now, clock } = setup(row('a'));
    expect(states.draftHeldFor('a')).toBeUndefined();
    states.typed('a', 'half a', now());
    clock.advance(DRAFT_HOLD_MS - 1_000);
    expect(states.whyNotReady(now(), true, false)).toBe('you were typing in its terminal');
    // Any key there, an arrow too, starts the wait again.
    states.typed('a', '\x1b[D', now());
    expect(states.draftHeldFor('a')).toBe(DRAFT_HOLD_MS);
    clock.advance(DRAFT_HOLD_MS);
    expect(states.draftHeldFor('a')).toBe(0);
    expect(states.whyNotReady(now(), true, false)).toBeUndefined();
    // Still a draft for all else: a run, a flag or a hand-off waits for the user's Enter or Ctrl-U, as it always has.
    expect(states.whyNotReady(now())).toBe('you were typing in its terminal');
    expect(states.promptNow(now())).toBe('typing');
  });

  it('has no draft once the user deletes what they typed, key by key', () => {
    const { states, row: now } = setup(row('a'));
    states.typed('a', 'hi', now());
    states.typed('a', '\x7f\x7f', now());
    expect(states.promptNow(now())).toBe('at-prompt');
    expect(states.whyNotReady(now())).toBeUndefined();
  });

  it('takes keys answering a permission prompt, a question or a rate limit for no draft at its prompt', () => {
    const { states, hook, row: now } = setup(row('a'));
    hook({ hook_event_name: 'UserPromptSubmit', prompt: 'go' });
    void hook({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'rm -rf dist' } });
    expect(now().state).toBe('needs-permission');
    states.typed('a', '2', now());
    hook({ hook_event_name: 'Stop', last_assistant_message: 'Ok.' });
    expect(states.promptNow(now())).toBe('at-prompt');
    expect(states.whyNotReady(now())).toBeUndefined();

    const asking = setup(row('b', { state: 'thinking' }));
    asking.hook({ hook_event_name: 'Notification', notification_type: 'agent_needs_input', message: 'Which branch?' });
    asking.states.typed('b', '1', asking.row());
    expect(asking.states.isDrafting('b')).toBe(false);

    const limited = setup(row('c', { state: 'thinking' }));
    limited.hook({ hook_event_name: 'StopFailure', error: 'rate_limit', last_assistant_message: 'API Error: 429' });
    limited.states.typed('c', '1', limited.row());
    expect(limited.states.isDrafting('c')).toBe(false);
  });

  it('takes a message the user queued mid-turn back as their draft when Escape interrupts the turn', () => {
    const { states, hook, row: now } = setup(row('a'));
    hook({ hook_event_name: 'UserPromptSubmit', prompt: 'go' });
    states.typed('a', 'and then tests\r', now());
    expect(states.isDrafting('a')).toBe(false);
    states.typed('a', '\x1b', now());
    expect(states.promptNow(now())).toBe('typing');
    hook({ hook_event_name: 'UserPromptSubmit', prompt: 'and then tests' });
    expect(states.isDrafting('a')).toBe(false);
    // Escape with nothing queued puts nothing back.
    states.typed('a', '\x1b', now());
    expect(states.isDrafting('a')).toBe(false);
  });

  it('takes it back too when the user typed it key by key, as a terminal sends it', () => {
    const { states, hook, row: now } = setup(row('a'));
    hook({ hook_event_name: 'UserPromptSubmit', prompt: 'go' });
    for (const key of 'and then') states.typed('a', key, now());
    expect(states.promptNow(now())).toBe('typing');
    states.typed('a', '\r', now());
    expect(states.isDrafting('a')).toBe(false);
    states.typed('a', '\x1b', now());
    expect(states.isDrafting('a')).toBe(true);
    // So another agent's send waits (deliveries' `userTyping` reads this hold), at the prompt the interrupt leaves.
    expect(states.draftHeldFor('a')).toBeGreaterThan(0);
    hook({ hook_event_name: 'Stop' });
    expect(states.whyNotReady(now(), true, false)).toBe('you were typing in its terminal');
  });

  it('holds back what others send while a line the user sent mid-turn waits, past the turn, till a prompt takes it up', () => {
    const { states, hook, row: now } = setup(row('a'));
    hook({ hook_event_name: 'UserPromptSubmit', prompt: 'go' });
    states.typed('a', 'and then tests\r', now());
    expect(states.isUserQueued('a')).toBe(true);
    hook({ hook_event_name: 'Stop', last_assistant_message: 'Done.' });
    // Its turn is over and no draft is left, but the harness has the line still: what others send would join it.
    expect(states.isDrafting('a')).toBe(false);
    expect(states.whyNotReady(now(), true, false)).toBe(USER_QUEUED_REASON);
    expect(states.whyNotReady(now())).toBe(USER_QUEUED_REASON);
    hook({ hook_event_name: 'UserPromptSubmit', prompt: 'and then tests' });
    expect(states.isUserQueued('a')).toBe(false);
    hook({ hook_event_name: 'Stop', last_assistant_message: 'Tests too.' });
    expect(states.whyNotReady(now(), true, false)).toBeUndefined();
  });

  it('lets the hold go a while after the turn when no prompt takes the line up, as the harness took it at a step', () => {
    const { states, hook, row: now, clock, lapsed } = setup(row('a'));
    hook({ hook_event_name: 'UserPromptSubmit', prompt: 'go' });
    states.typed('a', 'and then tests\r', now());
    // Mid-turn it holds as long as the turn runs.
    clock.advance(USER_QUEUE_HOLD_MS * 3);
    expect(lapsed).toEqual([]);
    hook({ hook_event_name: 'Stop', last_assistant_message: 'Done.' });
    clock.advance(USER_QUEUE_HOLD_MS - 1);
    expect(states.whyNotReady(now(), true, false)).toBe(USER_QUEUED_REASON);
    clock.advance(1);
    expect(lapsed).toEqual(['a']);
    expect(states.whyNotReady(now(), true, false)).toBeUndefined();
    // A prompt later stops nothing that is gone.
    hook({ hook_event_name: 'UserPromptSubmit', prompt: 'next' });
    expect(lapsed).toEqual(['a']);
  });

  it('starts that on an idle prompt, or a turn seen to end with no hook, as on a Stop', () => {
    const idle = setup(row('a'));
    idle.hook({ hook_event_name: 'UserPromptSubmit', prompt: 'go' });
    idle.states.typed('a', 'and then tests\r', idle.row());
    idle.hook({ hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'Claude is waiting for your input' });
    idle.clock.advance(USER_QUEUE_HOLD_MS);
    expect(idle.lapsed).toEqual(['a']);

    const quiet = setup(row('b'));
    quiet.hook({ hook_event_name: 'UserPromptSubmit', prompt: 'go' });
    quiet.states.typed('b', 'and then tests\r', quiet.row());
    quiet.states.turnEndedQuietly('b');
    quiet.clock.advance(USER_QUEUE_HOLD_MS);
    expect(quiet.lapsed).toEqual(['b']);
  });

  it('starts that while a lost Stop leaves the agent at work, once something asks', () => {
    const { states, hook, row: now, clock, lapsed } = setup(row('a'));
    hook({ hook_event_name: 'UserPromptSubmit', prompt: 'go' });
    states.typed('a', 'and then tests\r', now());
    expect(states.whyNotReady({ ...now(), state: 'idle' }, true, false)).toBe(USER_QUEUED_REASON);
    clock.advance(USER_QUEUE_HOLD_MS);
    expect(lapsed).toEqual(['a']);
  });

  it('stops holding once the user takes the line back, or the turn is interrupted from the board', () => {
    const escaped = setup(row('a'));
    escaped.hook({ hook_event_name: 'UserPromptSubmit', prompt: 'go' });
    escaped.states.typed('a', 'and then tests\r', escaped.row());
    escaped.hook({ hook_event_name: 'Stop', last_assistant_message: 'Done.' });
    escaped.states.typed('a', '\x1b', escaped.row());
    expect(escaped.states.isUserQueued('a')).toBe(false);
    escaped.clock.advance(USER_QUEUE_HOLD_MS);
    expect(escaped.lapsed).toEqual([]);

    const cut = setup(row('b'));
    cut.hook({ hook_event_name: 'UserPromptSubmit', prompt: 'go' });
    cut.states.typed('b', 'and then tests\r', cut.row());
    // The harness may have taken the line at a step of the turn already, so no draft is made of it: a hand-off or a
    // run after the interrupt goes, as no Enter, Ctrl-C or prompt would come to end a draft the prompt never had.
    cut.states.interrupted('b');
    expect(cut.states.isUserQueued('b')).toBe(false);
    expect(cut.states.isDrafting('b')).toBe(false);
    expect(cut.states.draftHeldFor('b')).toBeUndefined();
    expect(cut.states.whyNotReady({ ...cut.row(), state: 'idle' })).toBeUndefined();
    cut.clock.advance(USER_QUEUE_HOLD_MS);
    expect(cut.lapsed).toEqual([]);
  });

  it('forgets the line when the agent is relaunched or deleted', () => {
    const { states, hook, row: now, clock, lapsed } = setup(row('a'));
    hook({ hook_event_name: 'UserPromptSubmit', prompt: 'go' });
    states.typed('a', 'and then tests\r', now());
    hook({ hook_event_name: 'Stop', last_assistant_message: 'Done.' });
    states.relaunched('a');
    expect(states.isUserQueued('a')).toBe(false);
    states.typed('a', 'x\r', now());
    states.deleted('a');
    clock.advance(USER_QUEUE_HOLD_MS);
    expect(lapsed).toEqual([]);
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

describe('an agent compacting its conversation', () => {
  it('says since when from PreCompact until PostCompact, saving the agent each time though its state stays', () => {
    const { states, hook, saved, clock } = setup(row('a', { state: 'thinking' }));
    clock.advance(5_000);
    void hook({ hook_event_name: 'PreCompact', trigger: 'auto' });
    expect(states.compactingSince('a')).toBe('2026-01-01T00:00:05.000Z');
    expect(saved.at(-1)).toEqual({ state: 'thinking', always: true });
    void hook({ hook_event_name: 'PostCompact', trigger: 'auto' });
    expect(states.compactingSince('a')).toBeUndefined();
    expect(saved.at(-1)).toEqual({ state: 'thinking', always: true });
  });

  it('stops at an interrupt and when the agent ends', () => {
    const { states, hook } = setup(row('a', { state: 'thinking' }));
    void hook({ hook_event_name: 'PreCompact' });
    states.interrupted('a');
    expect(states.compactingSince('a')).toBeUndefined();
    void hook({ hook_event_name: 'UserPromptSubmit', prompt: 'go on' });
    void hook({ hook_event_name: 'PreCompact' });
    states.ended('a');
    expect(states.compactingSince('a')).toBeUndefined();
  });
});
