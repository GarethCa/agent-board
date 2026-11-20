import { describe, expect, it } from 'vitest';
import { answerTicket, clickOpensFrom, defaultClickOpens, OPEN_TILE_WINDOW_PATH, openAgentTile, tileOpenAction } from './click-opens';
import { expandTile, keptOnBoard } from './expanded';

describe('the click setting', () => {
  it('opens the pop-up unless another choice was saved', () => {
    expect(clickOpensFrom(null)).toBe('popup');
    expect(clickOpensFrom('popup')).toBe('popup');
    expect(clickOpensFrom('window')).toBe('window');
    expect(clickOpensFrom('expand')).toBe('expand');
    expect(clickOpensFrom('maximised')).toBe('maximised');
    expect(clickOpensFrom('sideways')).toBe('popup');
    expect(clickOpensFrom({ expand: true })).toBe('popup');
  });

  it('takes the default from the window it opens in, when that names one', () => {
    expect(defaultClickOpens('?clickOpens=window')).toBe('window');
    expect(defaultClickOpens('?clickOpens=sideways')).toBe('popup');
    expect(defaultClickOpens('')).toBe('popup');
    expect(clickOpensFrom(null, 'window')).toBe('window');
    expect(clickOpensFrom('expand', 'window')).toBe('expand');
  });
});

describe('what opening a tile does', () => {
  it("opens an agent's pop-up by default", () => {
    expect(tileOpenAction('popup', { hasWindow: true, agent: true })).toBe('popup');
  });

  it("opens a shell's window under the pop-up setting: the pop-up is an agent's", () => {
    expect(tileOpenAction('popup', { hasWindow: true, agent: false })).toBe('window');
  });

  it('opens the session window with that setting', () => {
    expect(tileOpenAction('window', { hasWindow: true, agent: true })).toBe('window');
  });

  it('opens the session window under the Maximised setting too: the window is what maximises', () => {
    expect(tileOpenAction('maximised', { hasWindow: true, agent: true })).toBe('window');
    expect(tileOpenAction('maximised', { hasWindow: false, agent: false })).toBe('expand');
  });

  it('expands in place with the setting changed', () => {
    expect(tileOpenAction('expand', { hasWindow: true, agent: true })).toBe('expand');
  });

  it("expands an external session's tile, which has no session window", () => {
    expect(tileOpenAction('popup', { hasWindow: false, agent: false })).toBe('expand');
    expect(tileOpenAction('window', { hasWindow: false, agent: false })).toBe('expand');
  });
});

describe("opening an agent's tile", () => {
  const calls: string[] = [];
  const actions = {
    popUp: (agent: { sessionId: string }) => calls.push(`popUp ${agent.sessionId}`),
    openAgent: (agent: { sessionId: string }) => calls.push(`openAgent ${agent.sessionId}`),
    expand: (nodeId: string) => calls.push(`expand ${nodeId}`),
  };

  it('does what the setting says, once', () => {
    calls.length = 0;
    const agent = { sessionId: 's1' };
    openAgentTile('popup', actions, 'agent:s1', agent);
    openAgentTile('window', actions, 'agent:s1', agent);
    openAgentTile('maximised', actions, 'agent:s1', agent);
    openAgentTile('expand', actions, 'agent:s1', agent);
    expect(calls).toEqual(['popUp s1', 'openAgent s1', 'openAgent s1', 'expand agent:s1']);
  });

  it('brings a tile pinned expanded forward, not into its window or pop-up, when opening it (Enter, ⌘K ↵)', () => {
    expect(keptOnBoard('pinned', new Set(['pinned']), expandTile([], 'pinned'), OPEN_TILE_WINDOW_PATH)).toBe(true);
  });
});

describe("a ticket tile's Answer", () => {
  const calls: string[] = [];
  const actions = {
    popUp: (agent: { sessionId: string }, _path?: undefined, on?: string) => calls.push(on === undefined ? `popUp ${agent.sessionId}` : `popUp ${agent.sessionId} on ${on}`),
    openAgent: (agent: { sessionId: string }) => calls.push(`openAgent ${agent.sessionId}`),
  };
  const chat = { sessionId: 'chat' };
  const helper = { sessionId: 'builder' };

  it('opens the pop-up on the helper that asks, under the pop-up setting', () => {
    calls.length = 0;
    answerTicket('popup', actions, chat, helper);
    expect(calls).toEqual(['popUp chat on builder']);
  });

  it('opens the pop-up on its chat when the chat is the one that asks', () => {
    calls.length = 0;
    answerTicket('popup', actions, chat, chat);
    expect(calls).toEqual(['popUp chat']);
  });

  it("opens the asker's session window under the other settings", () => {
    calls.length = 0;
    answerTicket('window', actions, chat, helper);
    answerTicket('expand', actions, chat, helper);
    expect(calls).toEqual(['openAgent builder', 'openAgent builder']);
  });
});
