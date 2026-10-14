import { describe, expect, it } from 'vitest';
import type { Subagent } from '../src/protocol.ts';
import { recentSubagents, SUBAGENT_RETAIN_MS, subagentsAfterExit, subagentsAfterHook } from '../src/subagents.ts';

const hook = (hook_event_name: string, fields: Record<string, unknown> = {}) => ({ hook_event_name, ...fields });

const T0 = new Date('2026-10-09T10:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);

const explorer: Subagent = {
  id: 'a1',
  type: 'Explore',
  state: 'running',
  startedAt: T0.toISOString(),
  endedAt: null,
  result: null,
};

/** Plays `events` from no subagents, one millisecond apart. */
function play(...events: Record<string, unknown>[]): readonly Subagent[] {
  return events.reduce<readonly Subagent[]>((subagents, payload, index) => subagentsAfterHook(subagents, payload, at(index)), []);
}

describe('subagents from Claude hooks (ADR-0004)', () => {
  it('adds a running subagent on SubagentStart', () => {
    expect(play(hook('SubagentStart', { agent_id: 'a1', agent_type: 'Explore' }))).toEqual([explorer]);
  });

  it('marks it done with its final message on SubagentStop, and keeps it so its tile can show it leave', () => {
    const subagents = play(
      hook('SubagentStart', { agent_id: 'a1', agent_type: 'Explore' }),
      hook('SubagentStop', { agent_id: 'a1', agent_type: 'Explore', last_assistant_message: 'Found it.' }),
    );
    expect(subagents).toEqual([{ ...explorer, state: 'done', endedAt: at(1).toISOString(), result: 'Found it.' }]);
  });

  it('moves a subagent with the hooks fired inside it, which carry its agent_id', () => {
    const start = hook('SubagentStart', { agent_id: 'a1', agent_type: 'Explore' });
    const inside = (event: string, fields: Record<string, unknown> = {}) =>
      hook(event, { agent_id: 'a1', agent_type: 'Explore', ...fields });
    expect(play(start, inside('PostToolUse', { tool_name: 'Read' }))[0]!.state).toBe('thinking');
    expect(play(start, inside('PermissionRequest', { tool_name: 'Bash' }))[0]!.state).toBe('needs-permission');
    expect(play(start, inside('PermissionRequest'), inside('PreToolUse'))[0]!.state).toBe('running');
  });

  it("leaves subagents alone on the parent's own tool calls", () => {
    const start = play(hook('SubagentStart', { agent_id: 'a1', agent_type: 'Explore' }));
    expect(subagentsAfterHook(start, hook('PostToolUse', { tool_name: 'Read' }), at(5))).toBe(start);
    expect(subagentsAfterHook(start, hook('PostToolUse', { agent_id: 'other' }), at(5))).toBe(start);
  });

  it('tracks several at once, each by its own id', () => {
    const subagents = play(
      hook('SubagentStart', { agent_id: 'a1', agent_type: 'Explore' }),
      hook('SubagentStart', { agent_id: 'a2', agent_type: 'Plan' }),
      hook('PostToolUse', { agent_id: 'a2' }),
      hook('SubagentStop', { agent_id: 'a1' }),
    );
    expect(subagents.map(({ id, type, state, result }) => ({ id, type, state, result }))).toEqual([
      { id: 'a1', type: 'Explore', state: 'done', result: null },
      { id: 'a2', type: 'Plan', state: 'thinking', result: null },
    ]);
  });

  it('ignores a SubagentStart it already has, a SubagentStop for one it never saw, and a start without an id', () => {
    const start = play(hook('SubagentStart', { agent_id: 'a1', agent_type: 'Explore' }));
    expect(subagentsAfterHook(start, hook('SubagentStart', { agent_id: 'a1', agent_type: 'Explore' }), at(1))).toBe(start);
    expect(subagentsAfterHook(start, hook('SubagentStop', { agent_id: 'zz' }), at(1))).toBe(start);
    expect(play(hook('SubagentStart', { agent_type: 'Explore' }))).toEqual([]);
  });

  it('calls a subagent with no agent_type "agent"', () => {
    expect(play(hook('SubagentStart', { agent_id: 'a1' }))[0]!.type).toBe('agent');
  });

  it("dozes live subagents when the parent's turn ends: background agents outlive it", () => {
    const subagents = play(
      hook('SubagentStart', { agent_id: 'a1', agent_type: 'Explore' }),
      hook('SubagentStart', { agent_id: 'a2', agent_type: 'Plan' }),
      hook('SubagentStop', { agent_id: 'a2' }),
      hook('Stop'),
    );
    expect(subagents.map((s) => s.state)).toEqual(['idle', 'done']);
  });

  it("marks live subagents rate-limited or failed when the parent's turn fails", () => {
    const start = hook('SubagentStart', { agent_id: 'a1', agent_type: 'Explore' });
    expect(play(start, hook('StopFailure', { error: 'rate_limit' }))[0]!.state).toBe('rate-limited');
    expect(play(start, hook('StopFailure', { error: 'server_error' }))[0]!.state).toBe('failed');
  });

  it(`forgets a finished subagent ${SUBAGENT_RETAIN_MS} ms after it ended`, () => {
    const subagents = play(
      hook('SubagentStart', { agent_id: 'a1', agent_type: 'Explore' }),
      hook('SubagentStop', { agent_id: 'a1' }),
    );
    const late = hook('SubagentStart', { agent_id: 'a2', agent_type: 'Plan' });
    expect(subagentsAfterHook(subagents, late, at(SUBAGENT_RETAIN_MS)).map((s) => s.id)).toEqual(['a1', 'a2']);
    expect(subagentsAfterHook(subagents, late, at(1 + SUBAGENT_RETAIN_MS)).map((s) => s.id)).toEqual(['a2']);
  });
});

describe('subagents when their parent exits', () => {
  const live = play(
    hook('SubagentStart', { agent_id: 'a1', agent_type: 'Explore' }),
    hook('SubagentStart', { agent_id: 'a2', agent_type: 'Plan' }),
    hook('SubagentStop', { agent_id: 'a2', last_assistant_message: 'Plan ready.' }),
  );

  it('ends the live ones with the agent: done after a clean exit', () => {
    expect(subagentsAfterExit(live, 'done', at(10))).toEqual([
      { ...live[0], state: 'done', endedAt: at(10).toISOString() },
      live[1],
    ]);
  });

  it('topples the live ones when the agent failed', () => {
    expect(subagentsAfterExit(live, 'failed', at(10)).map((s) => s.state)).toEqual(['failed', 'done']);
  });

  it('changes nothing with no subagents', () => {
    const none: Subagent[] = [];
    expect(subagentsAfterExit(none, 'done', at(10))).toBe(none);
  });
});

describe('subagents a client is told about', () => {
  const subagents = play(
    hook('SubagentStart', { agent_id: 'a1', agent_type: 'Explore' }),
    hook('SubagentStart', { agent_id: 'a2', agent_type: 'Plan' }),
    hook('SubagentStop', { agent_id: 'a2' }),
  );

  it(`are the live ones, and the ones that finished less than ${SUBAGENT_RETAIN_MS} ms ago, with no hook needed`, () => {
    expect(recentSubagents(subagents, at(1 + SUBAGENT_RETAIN_MS)).map((s) => s.id)).toEqual(['a1', 'a2']);
    expect(recentSubagents(subagents, at(2 + SUBAGENT_RETAIN_MS)).map((s) => s.id)).toEqual(['a1']);
  });

  it('are the same list when none has been forgotten', () => {
    expect(recentSubagents(subagents, at(3))).toBe(subagents);
  });
});
