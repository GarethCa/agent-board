import { describe, expect, it } from 'vitest';
import type { Agent, ExternalSession } from '@agent-board/daemon/protocol';
import { deleteLines, needsConfirmation, type DeleteTargets } from './delete-plan';

const agent = (patch: Partial<Agent>) => ({ name: 'Ada', endedAt: null, ownsWorktree: true, cwd: '/w', ...patch }) as Agent;
const external = (patch: Partial<ExternalSession>) => ({ name: 'Ext', state: 'running', ...patch }) as ExternalSession;
const none: DeleteTargets = { agents: [], shells: [], externals: [], items: 0, connectors: 0 };

describe('needsConfirmation', () => {
  it('is not needed for items alone: undo covers them', () => {
    expect(needsConfirmation({ ...none, items: 3, connectors: 1 })).toBe(false);
  });
  it('is needed for any combination of items and a session, and for several sessions', () => {
    expect(needsConfirmation({ ...none, items: 1, externals: [external({ state: 'done' })] })).toBe(true);
    expect(needsConfirmation({ ...none, agents: [agent({ endedAt: 'x' }), agent({ endedAt: 'y' })] })).toBe(true);
  });
  it('is left to the session itself for a lone one', () => {
    expect(needsConfirmation({ ...none, agents: [agent({})] })).toBe(false);
  });
});

describe('deleteLines', () => {
  it('says what happens to each kind, and that sessions cannot be undone', () => {
    const lines = deleteLines({
      items: 2,
      connectors: 0,
      agents: [agent({ name: 'Live' }), agent({ name: 'Done', endedAt: 'x' }), agent({ name: 'Folder', ownsWorktree: false, endedAt: 'x' })],
      shells: [{ name: 'Sh', live: true }],
      externals: [external({ name: 'Out' }), external({ name: 'Gone', state: 'done' })],
    }).join('\n');
    expect(lines).toContain('2 board items');
    expect(lines).toMatch(/Sh.*still has running shells/);
    expect(lines).toContain('Live is still running');
    expect(lines).toMatch(/Done.*worktree and branch/);
    expect(lines).toMatch(/Folder.*left as it is/);
    expect(lines).toMatch(/Out.*keeps running/);
    expect(lines).toMatch(/Gone.*taken off the board/);
    expect(lines).toMatch(/can't be undone/);
  });

  it("says an agent's shells end with it, one in the singular", () => {
    const lines = deleteLines({ ...none, agents: [agent({ sessionId: 'a', name: 'Dev' }), agent({ sessionId: 'b', name: 'Solo' })], agentShells: new Map([['a', 2], ['b', 1]]) });
    expect(lines.join('\n')).toMatch(/Dev is still running.*Its 2 shells end with it\./);
    expect(lines.join('\n')).toMatch(/Solo.*Its shell ends with it\./);
  });
});
