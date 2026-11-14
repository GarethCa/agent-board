import type { Agent } from '@agent-board/daemon/protocol';
import { describe, expect, it } from 'vitest';
import { clickableLinksView, startedOtherwise } from './clickable-links';

const agent = (fields: Partial<Agent>): Agent => ({ sessionId: 'a', name: 'Ada', harness: 'claude', endedAt: null, clickableLinks: true, ...fields }) as Agent;

describe('the clickable links switch', () => {
  it('is on until the settings are read, then shows the setting', () => {
    expect(clickableLinksView(undefined)).toEqual({ checked: true, locked: false });
    expect(clickableLinksView({ clickableLinks: false, clickableLinksFromEnvironment: null })).toEqual({ checked: false, locked: false });
  });

  it("shows the user's own FORCE_HYPERLINK, locked, whatever the setting says", () => {
    expect(clickableLinksView({ clickableLinks: false, clickableLinksFromEnvironment: true })).toEqual({ checked: true, locked: true });
    expect(clickableLinksView({ clickableLinks: true, clickableLinksFromEnvironment: false })).toEqual({ checked: false, locked: true });
  });
});

describe('the agents the restart offer counts', () => {
  const agents = [
    agent({ sessionId: 'with' }),
    agent({ sessionId: 'without', clickableLinks: false }),
    agent({ sessionId: 'ended', endedAt: '2026-11-14T10:00:00Z' }),
    agent({ sessionId: 'codex', harness: 'codex' }),
    agent({ sessionId: 'not ours', clickableLinks: null }),
  ];

  it('are the live Claude agents this daemon started the other way, worked out from the agents alone', () => {
    expect(startedOtherwise(agents, { clickableLinks: false, clickableLinksFromEnvironment: null }).map((a) => a.sessionId)).toEqual(['with']);
    expect(startedOtherwise(agents, { clickableLinks: true, clickableLinksFromEnvironment: null }).map((a) => a.sessionId)).toEqual(['without']);
  });

  it("are none before the settings are read, or while the user's own variable decides", () => {
    expect(startedOtherwise(agents, undefined)).toEqual([]);
    expect(startedOtherwise(agents, { clickableLinks: true, clickableLinksFromEnvironment: true })).toEqual([]);
  });
});
