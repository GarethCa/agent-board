import { describe, expect, it } from 'vitest';
import type { Agent, ExternalSession } from '@agent-board/daemon/protocol';
import { deleteLines, needsConfirmation, sameDelete, type DeleteTargets, type PendingDelete } from './delete-plan';

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
  it('is left to a lone running crew’s card, and needed for one with anything else or for several', () => {
    expect(needsConfirmation({ ...none, crews: ['Fix the flake'] })).toBe(false);
    expect(needsConfirmation({ ...none, items: 1, crews: ['Fix the flake'] })).toBe(true);
    expect(needsConfirmation({ ...none, crews: ['Fix the flake', 'Fix the flake'] })).toBe(true);
    expect(needsConfirmation({ ...none, agents: [agent({})], crews: ['Fix the flake'] })).toBe(true);
  });
});

describe('sameDelete', () => {
  const ask = (fields: Partial<PendingDelete> = {}): PendingDelete => ({ title: 'Stop this crew?', lines: ['“Fix the flake”'], confirm: 'Stop crew', run: () => {}, ...fields });

  it('takes two questions in the same words as one, where neither has a key', () => {
    expect(sameDelete(ask(), ask())).toBe(true);
    expect(sameDelete(ask(), ask({ lines: ['“Fix the build”'] }))).toBe(false);
  });
  it('tells two crews asked the same thing apart by their keys', () => {
    expect(sameDelete(ask({ key: 'crew:a' }), ask({ key: 'crew:b' }))).toBe(false);
    expect(sameDelete(ask({ key: 'crew:a' }), ask({ key: 'crew:a', lines: ['other words'] }))).toBe(true);
    expect(sameDelete(ask({ key: 'crew:a' }), ask())).toBe(false);
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

  it('names each running crew a delete would stop, with what it was asked', () => {
    const lines = deleteLines({ ...none, items: 1, agents: [agent({ name: 'Live' })], crews: ['Fix the flake', 'Try a cache'] });
    expect(lines).toContain('1 board item deleted (undo brings them back).');
    expect(lines).toContain('The crew asked “Fix the flake” is stopped, and its card taken off the board. It can’t be started again.');
    expect(lines).toContain('The crew asked “Try a cache” is stopped, and its card taken off the board. It can’t be started again.');
    // Cards alone end no session.
    expect(deleteLines({ ...none, crews: ['Fix the flake', 'Try a cache'] }).join('\n')).not.toMatch(/sessions/);
  });

  it("says an agent's shells end with it, one in the singular", () => {
    const lines = deleteLines({ ...none, agents: [agent({ sessionId: 'a', name: 'Dev' }), agent({ sessionId: 'b', name: 'Solo' })], agentShells: new Map([['a', 2], ['b', 1]]) });
    expect(lines.join('\n')).toMatch(/Dev is still running.*Its 2 shells end with it\./);
    expect(lines.join('\n')).toMatch(/Solo.*Its shell ends with it\./);
  });
});
