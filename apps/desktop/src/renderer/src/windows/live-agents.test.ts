import { describe, expect, it } from 'vitest';
import type { Agent } from '@agent-board/daemon/protocol';
import { withChange } from './live-agents';

const agent = (sessionId: string, name = sessionId) => ({ sessionId, name }) as Agent;

describe('withChange', () => {
  it('changes an agent in its place, adds a new one at the end, and leaves out one removed', () => {
    const agents = [agent('chat'), agent('helper')];
    expect(withChange(agents, 'chat', agent('chat', 'Renamed')).map((each) => each.name)).toEqual(['Renamed', 'helper']);
    expect(withChange(agents, 'new', agent('new')).map((each) => each.sessionId)).toEqual(['chat', 'helper', 'new']);
    expect(withChange(agents, 'helper', null).map((each) => each.sessionId)).toEqual(['chat']);
  });
});
