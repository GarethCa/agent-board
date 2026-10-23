import { describe, expect, it } from 'vitest';
import type { Agent } from '@agent-board/daemon/protocol';
import { agentStartLines, stepLine } from './StartTile';

const agent = (fields: Partial<Agent>) =>
  ({ harness: 'claude', branch: 'pick-a-cache', worktree: '/worktrees/pick-a-cache', ownsWorktree: true, exitCode: null, startup: null, ...fields }) as Agent;

describe('a starting tile', () => {
  it('reads each step as it goes, then as what it made', () => {
    expect(stepLine({ kind: 'issue', state: 'now', detail: null }, 'claude')).toEqual({ state: 'now', text: 'reading the issue…' });
    expect(stepLine({ kind: 'issue', state: 'done', detail: '#34' }, 'claude')).toEqual({ state: 'done', text: 'issue #34' });
    expect(stepLine({ kind: 'worktree', state: 'now', detail: null }, 'claude').text).toBe('creating worktree…');
    expect(stepLine({ kind: 'worktree', state: 'done', detail: 'pick-a-cache' }, 'claude').text).toBe('worktree pick-a-cache');
    expect(stepLine({ kind: 'worktree', state: 'failed', detail: null }, 'claude').text).toBe('creating worktree');
    expect(stepLine({ kind: 'launch', state: 'now', detail: null }, 'codex').text).toBe('starting Codex…');
    expect(stepLine({ kind: 'launch', state: 'failed', detail: null }, 'claude').text).toBe("couldn't start Claude");
  });

  it("lists a started agent's worktree, then its harness starting or how it exited before it came up", () => {
    expect(agentStartLines(agent({ startup: { output: null, failed: false } }))).toEqual([
      { state: 'done', text: 'worktree pick-a-cache' },
      { state: 'now', text: 'starting Claude…' },
    ]);
    expect(agentStartLines(agent({ exitCode: 1, startup: { output: 'ANTHROPIC_API_KEY not set', failed: true } }))).toEqual([
      { state: 'done', text: 'worktree pick-a-cache' },
      { state: 'failed', text: 'claude exited (code 1)' },
    ]);
    // A reviewer's detached checkout has no branch of its own: its folder names it; a folder it was put in, nothing.
    expect(agentStartLines(agent({ branch: '', startup: { output: null, failed: false } }))[0]!.text).toBe('worktree pick-a-cache');
    expect(agentStartLines(agent({ ownsWorktree: false, startup: { output: null, failed: false } }))).toEqual([{ state: 'now', text: 'starting Claude…' }]);
  });
});
