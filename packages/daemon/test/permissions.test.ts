import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPermissionHolds, permissionReply, stateWithPrompts } from '../src/permissions.ts';

const BASH = { tool_name: 'Bash', tool_input: { command: 'rm -rf dist' } };
const request = (fields: Record<string, unknown> = {}) => ({ hook_event_name: 'PermissionRequest', ...BASH, ...fields });
const hook = (hook_event_name: string, fields: Record<string, unknown> = {}) => ({ hook_event_name, ...fields });
const inSubagent = (id: string) => ({ agent_id: id, agent_type: 'general-purpose' });

const HOLD_MS = 1_000;
const T0 = new Date('2026-10-09T10:00:00.000Z');

function holds() {
  const changed: string[] = [];
  const permissions = createPermissionHolds({ holdMs: HOLD_MS, onChange: (sessionId) => changed.push(sessionId) });
  return { permissions, changed };
}

const open = () => new AbortController().signal;

/** Whether `promise` has settled, and with what, after pending microtasks run. */
async function settled<T>(promise: Promise<T>): Promise<{ value: T } | undefined> {
  let result: { value: T } | undefined;
  void promise.then((value) => (result = { value }));
  await vi.advanceTimersByTimeAsync(0);
  return result;
}

// The daemon-level journeys (allow, deny, lapse, two subagents at once) are in agents.test.ts, with the fake claude.
// These pin the rules for what settles a prompt, which the fake can't reach one by one.
describe('permission holds', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => vi.useRealTimers());

  it('holds a PermissionRequest open as a prompt until the user decides', async () => {
    const { permissions } = holds();
    const reply = permissions.hold('s1', request(), open());

    const [prompt] = permissions.prompts('s1');
    expect(prompt).toEqual({
      id: expect.any(String),
      toolName: 'Bash',
      toolInput: { command: 'rm -rf dist' },
      subagent: null,
      requestedAt: T0.toISOString(),
      heldUntil: new Date(T0.getTime() + HOLD_MS).toISOString(),
    });
    expect(await settled(reply)).toBeUndefined();

    expect(permissions.decide('s1', prompt!.id, { behavior: 'allow' })).toBe(true);
    expect(await reply).toEqual(permissionReply({ behavior: 'allow' }));
    expect(permissions.prompts('s1')).toEqual([]);
  });

  it("answers in the harness's PermissionRequest decision shape, with a deny's reason", () => {
    expect(permissionReply({ behavior: 'allow' })).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    });
    expect(permissionReply({ behavior: 'deny', message: 'Not on main' })).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'Not on main' } },
    });
  });

  it('holds every request at once, each answered on its own', async () => {
    const { permissions } = holds();
    const first = permissions.hold('s1', request(inSubagent('a1')), open());
    const second = permissions.hold('s1', request({ ...inSubagent('a2'), tool_input: { command: 'rm -rf build' } }), open());

    const [one, two] = permissions.prompts('s1');
    expect(one).toMatchObject({ subagent: { id: 'a1', type: 'general-purpose' }, toolInput: { command: 'rm -rf dist' } });
    expect(two).toMatchObject({ subagent: { id: 'a2', type: 'general-purpose' }, toolInput: { command: 'rm -rf build' } });

    permissions.decide('s1', two!.id, { behavior: 'deny' });
    expect(await second).toEqual(permissionReply({ behavior: 'deny' }));
    expect(await settled(first)).toBeUndefined();
    expect(permissions.prompts('s1')).toEqual([one]);
  });

  it('refuses a decision for another request or session, or one already made', () => {
    const { permissions } = holds();
    void permissions.hold('s1', request(), open());
    const { id } = permissions.prompts('s1')[0]!;

    expect(permissions.decide('s1', 'other-id', { behavior: 'allow' })).toBe(false);
    expect(permissions.decide('s2', id, { behavior: 'allow' })).toBe(false);
    expect(permissions.decide('s1', id, { behavior: 'deny' })).toBe(true);
    expect(permissions.decide('s1', id, { behavior: 'allow' })).toBe(false);
  });

  it('lets the hold lapse to the terminal with no decision, keeping the prompt as context until it is settled there', async () => {
    const { permissions, changed } = holds();
    const reply = permissions.hold('s1', request(), open());
    const { id } = permissions.prompts('s1')[0]!;

    await vi.advanceTimersByTimeAsync(HOLD_MS);

    expect(await settled(reply)).toEqual({ value: undefined });
    expect(changed).toEqual(['s1']);
    expect(permissions.prompts('s1')).toEqual([expect.objectContaining({ id, heldUntil: null })]);
    expect(permissions.decide('s1', id, { behavior: 'allow' })).toBe(false);
    // The terminal's own prompt for it settles nothing.
    expect(permissions.afterHook('s1', hook('Notification', { notification_type: 'permission_prompt' }))).toBe(false);
    // Allowed in the terminal: that very call ran.
    expect(permissions.afterHook('s1', hook('PostToolUse', BASH))).toBe(true);
    expect(permissions.prompts('s1')).toEqual([]);
  });

  it('stops holding when the harness hangs up', async () => {
    const { permissions, changed } = holds();
    const abort = new AbortController();
    const reply = permissions.hold('s1', request(), abort.signal);

    abort.abort();

    expect(await settled(reply)).toEqual({ value: undefined });
    expect(changed).toEqual(['s1']);
    expect(permissions.prompts('s1')).toEqual([expect.objectContaining({ heldUntil: null })]);
    await vi.advanceTimersByTimeAsync(HOLD_MS);
    expect(changed).toEqual(['s1']);
  });

  it('settles a prompt once its own call runs, or its asker ends its turn or takes a new prompt', async () => {
    for (const [settling, fields] of [
      ['PostToolUse', BASH],
      ['Stop', {}],
      ['StopFailure', { error: 'rate_limit' }],
      ['Interrupt', {}],
      ['UserPromptSubmit', { prompt: 'never mind' }],
    ] as const) {
      const { permissions } = holds();
      const reply = permissions.hold('s1', request(), open());
      expect(permissions.afterHook('s1', hook(settling, fields)), settling).toBe(true);
      expect(await settled(reply), settling).toEqual({ value: undefined });
      expect(permissions.prompts('s1'), settling).toEqual([]);
    }
  });

  it('keeps a prompt through calls that may run beside it: other tools, or the same tool on other input', () => {
    const { permissions } = holds();
    void permissions.hold('s1', request(), open());

    expect(permissions.afterHook('s1', hook('PreToolUse', BASH))).toBe(false);
    expect(permissions.afterHook('s1', hook('PostToolUse', { tool_name: 'Read', tool_input: { file_path: '/a' } }))).toBe(false);
    expect(permissions.afterHook('s1', hook('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } }))).toBe(false);
    expect(permissions.prompts('s1')).toHaveLength(1);
  });

  it("ties a subagent's prompt to that subagent: only its own hooks, or its end, settle it", () => {
    const { permissions } = holds();
    void permissions.hold('s1', request(inSubagent('a1')), open());
    void permissions.hold('s1', request(inSubagent('a2')), open());

    // The parent's turn ending leaves background subagents asking.
    expect(permissions.afterHook('s1', hook('Stop'))).toBe(false);
    expect(permissions.afterHook('s1', hook('PostToolUse', BASH))).toBe(false);
    expect(permissions.afterHook('s1', hook('PostToolUse', { ...BASH, ...inSubagent('a2') }))).toBe(true);
    expect(permissions.prompts('s1')).toEqual([expect.objectContaining({ subagent: { id: 'a1', type: 'general-purpose' } })]);
    expect(permissions.afterHook('s1', hook('SubagentStop', inSubagent('a1')))).toBe(true);
    expect(permissions.prompts('s1')).toEqual([]);
  });

  it("keeps sessions apart, and drops a session's prompts when it ends", async () => {
    const { permissions } = holds();
    const one = permissions.hold('s1', request(), open());
    void permissions.hold('s2', request(), open());

    permissions.drop('s1');

    expect(await settled(one)).toEqual({ value: undefined });
    expect(permissions.prompts('s1')).toEqual([]);
    expect(permissions.prompts('s2')).toHaveLength(1);
  });

  it('tells no one once closed', async () => {
    const { permissions, changed } = holds();
    const reply = permissions.hold('s1', request(), open());

    permissions.close();
    await vi.advanceTimersByTimeAsync(HOLD_MS);

    expect(await settled(reply)).toEqual({ value: undefined });
    expect(changed).toEqual([]);
  });
});

describe("an agent's state with its permission prompts", () => {
  it('needs permission while any prompt is pending, whatever else its hooks say', () => {
    for (const state of ['running', 'thinking', 'idle', 'waiting', 'needs-permission'] as const) {
      expect(stateWithPrompts(state, { pending: 1, settled: false }), state).toBe('needs-permission');
    }
  });

  it('still ends, fails or hits a rate limit with prompts pending', () => {
    for (const state of ['done', 'failed', 'rate-limited'] as const) {
      expect(stateWithPrompts(state, { pending: 1, settled: false })).toBe(state);
    }
  });

  it('carries on running once its last prompt is settled by a hook that says nothing of its own state', () => {
    expect(stateWithPrompts('needs-permission', { pending: 0, settled: true })).toBe('running');
    expect(stateWithPrompts('idle', { pending: 0, settled: true })).toBe('idle');
  });

  it('leaves a needs-permission with no prompt of ours alone (the terminal asking on its own)', () => {
    expect(stateWithPrompts('needs-permission', { pending: 0, settled: false })).toBe('needs-permission');
  });
});
