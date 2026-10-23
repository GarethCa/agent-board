import { describe, expect, it } from 'vitest';
import type { AgentStart } from '@agent-board/daemon/protocol';
import { LOST_START_ERROR, withListedStarts, withStartChange } from './use-agent-starts';

const start = (sessionId: string, fields: Partial<AgentStart> = {}): AgentStart => ({
  sessionId,
  zoneId: 'z',
  position: null,
  name: sessionId,
  harness: 'claude',
  model: null,
  spawnedBy: null,
  steps: [{ kind: 'worktree', state: 'now', detail: null }],
  error: null,
  confirm: false,
  ...fields,
});

describe("the board's agents being started", () => {
  it('takes in each change, and drops a start once it is over', () => {
    const one = withStartChange([], { type: 'agent.starting', start: start('a') });
    const moved = withStartChange(one, { type: 'agent.starting', start: start('a', { position: { x: 1, y: 2 } }) });
    expect(moved).toEqual([start('a', { position: { x: 1, y: 2 } })]);
    expect(withStartChange(moved, { type: 'agent.startEnded', sessionId: 'a' })).toEqual([]);
  });

  it('keeps a start a restarted daemon no longer knows as lost, with only Delete left, never spinning', () => {
    const listed = withListedStarts([start('a'), start('b')], [start('b', { name: 'renamed' })]);
    expect(listed).toEqual([start('b', { name: 'renamed' }), { ...start('a'), error: LOST_START_ERROR, confirm: false, lost: true }]);
  });
});
