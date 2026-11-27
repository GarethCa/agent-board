// One close for every agent: its helpers, then its reviewers, then itself; unsaved work judged one way.
import { describe, expect, it } from 'vitest';
import { createAgentCloser, type CloseHow } from '../src/agent-close.ts';
import { AGENT_ERROR, type Agent } from '../src/protocol.ts';

/** An agent as the closer reads it, owning its worktree unless told. */
const agent = (sessionId: string, fields: Partial<Agent> = {}): Agent =>
  ({
    sessionId,
    name: sessionId,
    ticket: null,
    reviewOf: null,
    endedAt: null,
    ownsWorktree: true,
    repoRoot: '/repo',
    worktree: `/worktrees/${sessionId}`,
    ownedBranch: sessionId,
    ...fields,
  }) as Agent;

/**
 * A board of `agents`, `reviewers` by the agent they review, and the unsaved work each holds: `running` while it runs,
 * `ended` once it has stopped (what it writes as it stops). Every stop and delete is written to `calls`.
 */
function board(
  agents: Agent[],
  options: { reviewers?: Record<string, string[]>; running?: Record<string, string>; ended?: Record<string, string>; onDelete?: (sessionId: string) => void } = {},
) {
  const live = new Map(agents.map((each) => [each.sessionId, each]));
  const calls: string[] = [];
  const reviewers = options.reviewers ?? {};
  const closer = createAgentCloser({
    agents: {
      get: (sessionId) => live.get(sessionId),
      list: () => [...live.values()],
      stop: async (sessionId) => {
        calls.push(`stop ${sessionId}`);
        live.set(sessionId, { ...live.get(sessionId)!, endedAt: 'now' });
      },
      delete: async (sessionId, _why, force, keepWorktree = false, keepBranch = false) => {
        if (!live.has(sessionId)) throw new Error(`no agent ${sessionId}`);
        calls.push(`delete ${sessionId}${force ? ' forced' : ''}${keepWorktree ? ' keeping its worktree' : ''}${keepBranch ? ' and branch' : ''}`);
        live.delete(sessionId);
        options.onDelete?.(sessionId);
      },
    },
    reviews: {
      reviewersOf: (sessionId) => (reviewers[sessionId] ?? []).filter((id) => live.has(id)),
      // As the reviews host's: its reviewers go first, forced, then the agent.
      deleteAgent: async (sessionId, _why, remove) => {
        for (const reviewer of reviewers[sessionId] ?? []) {
          if (live.has(reviewer)) {
            calls.push(`delete ${reviewer} forced`);
            live.delete(reviewer);
          }
        }
        return remove();
      },
    },
    unsaved: async (each) => (each.endedAt === null ? options.running?.[each.sessionId] : (options.ended?.[each.sessionId] ?? options.running?.[each.sessionId])),
    log: () => {},
  });
  return { closer, calls, left: () => [...live.keys()] };
}

const close: CloseHow = { why: 'a close', ends: true, unsaved: 'keep' };

describe('closing an agent', () => {
  it('keeps its worktree and branch when they hold unsaved work, and says so: the agent goes', async () => {
    const { closer, calls, left } = board([agent('impl')], { running: { impl: 'its worktree has uncommitted changes' } });
    await expect(closer.closeAgent('impl', close)).resolves.toEqual({
      worktree: '/worktrees/impl',
      branch: 'impl',
      why: 'its worktree has uncommitted changes',
    });
    expect(calls).toEqual(['stop impl', 'delete impl forced keeping its worktree and branch']);
    expect(left()).toEqual([]);
  });

  it('ends it before it looks: what it writes as it stops keeps its worktree too', async () => {
    const { closer, calls } = board([agent('impl')], { ended: { impl: 'its worktree has uncommitted changes' } });
    await expect(closer.closeAgent('impl', close)).resolves.toMatchObject({ why: 'its worktree has uncommitted changes' });
    expect(calls).toEqual(['stop impl', 'delete impl forced keeping its worktree and branch']);
  });

  it('takes its worktree and branch when they hold nothing unsaved', async () => {
    const { closer, calls } = board([agent('impl')]);
    await expect(closer.closeAgent('impl', close)).resolves.toBeNull();
    expect(calls).toEqual(['stop impl', 'delete impl forced']);
  });

  it("closes a ticket's helpers first, then its reviewers, then the chat", async () => {
    const { closer, calls, left } = board(
      [agent('chat'), agent('builder', { ticket: 'chat' }), agent('review', { ticket: 'chat', reviewOf: 'chat' }), agent('loose')],
      { reviewers: { chat: ['review'], builder: ['builder-review'] } },
    );
    await closer.closeAgent('chat', close);
    expect(calls).toEqual(['stop builder', 'delete builder forced', 'stop chat', 'delete review forced', 'delete chat forced']);
    expect(left()).toEqual(['loose']);
  });

  it('closes none of a ticket while a helper holds unsaved work, whether it had it running or wrote it as it stopped', async () => {
    for (const unsaved of [{ running: { builder: 'its worktree has uncommitted changes' } }, { ended: { builder: 'its worktree has uncommitted changes' } }]) {
      const { closer, calls, left } = board([agent('chat'), agent('builder', { ticket: 'chat' })], unsaved);
      const refusal = await closer.closeAgent('chat', close).catch((error: unknown) => error);
      expect(refusal).toMatchObject({ code: AGENT_ERROR.unsavedWork, message: 'builder: its worktree has uncommitted changes', sessionId: 'builder' });
      expect(calls.filter((call) => call.startsWith('delete'))).toEqual([]);
      expect(left()).toEqual(['chat', 'builder']);
    }
  });

  it('refuses, ended, when the close says unsaved work refuses it, as a crew does: work it had running, or wrote as it stopped', async () => {
    for (const unsaved of [{ running: { impl: 'its worktree has uncommitted changes' } }, { ended: { impl: 'its worktree has uncommitted changes' } }]) {
      const { closer, calls, left } = board([agent('impl')], unsaved);
      await expect(closer.closeAgent('impl', { ...close, unsaved: 'refuse' })).rejects.toMatchObject({ sessionId: 'impl', reason: 'its worktree has uncommitted changes' });
      expect(calls).toEqual(['stop impl']);
      expect(left()).toEqual(['impl']);
    }
  });

  it('ends the agent and keeps its work with keep, though the close leaves out ends', async () => {
    const { closer, calls } = board([agent('impl')], { running: { impl: 'its worktree has uncommitted changes' } });
    await expect(closer.closeAgent('impl', { why: 'a close', unsaved: 'keep' })).resolves.toMatchObject({ why: 'its worktree has uncommitted changes' });
    expect(calls).toEqual(['stop impl', 'delete impl forced keeping its worktree and branch']);
  });

  it('never looks at an agent that owns no worktree: it takes nothing of the user’s', async () => {
    const { closer, calls } = board([agent('adopted', { ownsWorktree: false })], { running: { adopted: 'its worktree has uncommitted changes' } });
    await expect(closer.closeAgent('adopted', { ...close, unsaved: 'refuse' })).resolves.toBeNull();
    expect(calls).toEqual(['stop adopted', 'delete adopted forced']);
  });

  it('deletes with the worktree and branch the merge gate judged, after helpers that are clean', async () => {
    const gate: CloseHow = { why: 'the gate', ends: true, unsaved: 'lose', keep: { worktree: true, branch: false } };
    const { closer, calls } = board([agent('chat', { endedAt: 'then' }), agent('builder', { ticket: 'chat' })]);
    await expect(closer.closeAgent('chat', gate)).resolves.toBeNull();
    expect(calls).toEqual(['stop builder', 'delete builder forced', 'delete chat forced keeping its worktree']);
    const held = board([agent('chat'), agent('builder', { ticket: 'chat' })], { running: { builder: 'its worktree has uncommitted changes' } });
    await expect(held.closer.closeAgent('chat', gate)).rejects.toMatchObject({ sessionId: 'builder' });
    expect(held.left()).toEqual(['chat', 'builder']);
  });
});

describe('deleting an agent', () => {
  const remove: CloseHow = { why: 'a delete', unsaved: 'refuse' };

  it('refuses while it, a helper, or with checkReviewers a reviewer holds unsaved work, and leaves every one running', async () => {
    for (const [holder, how] of [
      ['chat', remove],
      ['builder', remove],
      ['review', { ...remove, checkReviewers: true }],
    ] as const) {
      const { closer, calls, left } = board([agent('chat'), agent('builder', { ticket: 'chat' }), agent('review', { reviewOf: 'chat' })], {
        reviewers: { chat: ['review'] },
        running: { [holder]: 'its worktree has uncommitted changes' },
      });
      await expect(closer.closeAgent('chat', how)).rejects.toMatchObject({ code: AGENT_ERROR.unsavedWork, message: `${holder}: its worktree has uncommitted changes` });
      expect(calls).toEqual([]);
      expect(left()).toEqual(['chat', 'builder', 'review']);
    }
  });

  it('looks again just before the kill: work written while its helpers went refuses it, and the chat stays', async () => {
    const running: Record<string, string> = {};
    const { closer, calls, left } = board([agent('chat'), agent('builder', { ticket: 'chat' })], {
      running,
      onDelete: (sessionId) => {
        if (sessionId === 'builder') running.chat = 'its worktree has uncommitted changes';
      },
    });
    await expect(closer.closeAgent('chat', remove)).rejects.toMatchObject({ sessionId: 'chat' });
    expect(calls).toEqual(['delete builder forced']);
    expect(left()).toEqual(['chat']);
  });

  it("looks again at a helper's reviewers just before the helper goes: one that turns dirty after the first look refuses, and nothing goes", async () => {
    let looks = 0;
    const running = {
      get 'builder-review'() {
        looks += 1;
        return looks > 1 ? 'its worktree has uncommitted changes' : undefined;
      },
    } as Record<string, string>;
    const { closer, calls, left } = board([agent('chat'), agent('builder', { ticket: 'chat' }), agent('builder-review', { reviewOf: 'builder' })], {
      reviewers: { builder: ['builder-review'] },
      running,
    });
    await expect(closer.closeAgent('chat', { ...remove, checkReviewers: true })).rejects.toMatchObject({ sessionId: 'builder-review' });
    expect(calls).toEqual([]);
    expect(left()).toEqual(['chat', 'builder', 'builder-review']);
  });

  it('kills each as it goes, never ending it first, and takes a reviewer with unsaved work unless asked to check it', async () => {
    const { closer, calls } = board([agent('chat'), agent('builder', { ticket: 'chat' }), agent('review', { reviewOf: 'chat' })], {
      reviewers: { chat: ['review'] },
      running: { review: 'its worktree has uncommitted changes' },
    });
    await closer.closeAgent('chat', remove);
    expect(calls).toEqual(['delete builder forced', 'delete review forced', 'delete chat forced']);
  });

  it("goes, helpers and all, without a look when the user forces it, or keeps every worktree when the user keeps its own", async () => {
    const unsaved = { running: { chat: 'x', builder: 'y' } };
    const forced = board([agent('chat'), agent('builder', { ticket: 'chat' })], unsaved);
    await forced.closer.closeAgent('chat', { why: 'forced', unsaved: 'lose', helpers: 'as-agent' });
    expect(forced.calls).toEqual(['delete builder forced', 'delete chat forced']);
    const kept = board([agent('chat'), agent('builder', { ticket: 'chat' })], unsaved);
    await kept.closer.closeAgent('chat', { why: 'kept', unsaved: 'refuse', keep: { worktree: true, branch: true }, helpers: 'as-agent' });
    expect(kept.calls).toEqual(['delete builder forced keeping its worktree and branch', 'delete chat forced keeping its worktree and branch']);
  });

  it('refuses an agent that is not there', async () => {
    const { closer } = board([]);
    await expect(closer.closeAgent('gone', remove)).rejects.toThrow(/no agent gone/);
  });
});
