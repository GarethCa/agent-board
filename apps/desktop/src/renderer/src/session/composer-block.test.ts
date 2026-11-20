import { describe, expect, it } from 'vitest';
import { AGENT_STATES } from '@agent-board/daemon/protocol';
import { composerBlock, composerPlaceholder, wakesAtText } from './composer-block';

const live = { endedAt: null, state: 'idle', reviewOf: null } as const;

describe('composerBlock', () => {
  it('takes messages in every state of a live agent, working or waiting included', () => {
    // Every state but the two that block, so a new state has to be decided here.
    const sending = AGENT_STATES.filter((state) => state !== 'needs-permission' && state !== 'stopped-by-restart');
    expect(sending).toContain('handing-off');
    for (const state of sending) expect(composerBlock({ ...live, state })).toBeUndefined();
  });

  it('points at the terminal while a permission prompt waits', () => {
    expect(composerBlock({ ...live, state: 'needs-permission' })).toEqual({ reason: 'Waiting on a permission prompt', action: 'show-prompt' });
  });

  it("points at the terminal while Claude's question dialog is up, so nothing typed lands in it", () => {
    const AT = '2026-10-11T10:00:00Z';
    const permissions = [{ id: 'q', toolName: 'AskUserQuestion', toolInput: {}, subagent: null, requestedAt: AT, heldUntil: null, asksInTerminal: true, sessionGrant: null, dialog: null, plan: null, questions: [{ question: 'Which cache?', header: 'Cache', options: [{ label: 'Redis', description: '' }, { label: 'In memory', description: '' }], multiSelect: false }] }];
    expect(composerBlock({ ...live, state: 'waiting', permissions })).toEqual({ reason: 'Its questions wait in its terminal', action: 'show-prompt' });
  });

  it('offers to wake an agent a restart stopped', () => {
    expect(composerBlock({ ...live, endedAt: '2026-10-11T10:00:00Z', state: 'stopped-by-restart' })).toEqual({
      reason: 'Stopped by a restart',
      action: 'wake',
    });
  });

  it('takes a message for a paused agent, which wakes with it', () => {
    expect(composerBlock({ ...live, endedAt: '2026-10-11T10:00:00Z', state: 'hibernated' })).toBeUndefined();
  });

  it('wakes an agent that is done or exited, by a message or by Wake', () => {
    expect(composerBlock({ ...live, endedAt: '2026-10-11T10:00:00Z', state: 'done' })).toEqual({ reason: 'Done. Wake carries on this conversation.', action: 'restart' });
    expect(composerBlock({ ...live, endedAt: '2026-10-11T10:00:00Z', state: 'failed' })).toEqual({ reason: 'Stopped on an error. A message, or Wake, starts it again here.', action: 'restart' });
  });

  it('offers a reviewer, whose round ended with it, and a harness running in its shell, no way to wake', () => {
    expect(composerBlock({ ...live, endedAt: '2026-10-11T10:00:00Z', state: 'done', reviewOf: 'impl-1' })).toEqual({ reason: 'The agent has ended' });
    expect(composerBlock({ ...live, endedAt: '2026-10-11T10:00:00Z', state: 'done', shellHarness: 'claude' })).toEqual({ reason: 'The agent has ended' });
  });
});

describe('wakesAtText', () => {
  const clock = { clockId: 'c', cron: '30 22 * * *', prompt: 'Sweep', enabled: true, nextRunAt: '2026-10-11T22:30:00', lastRun: null, hibernates: false };

  it('says when its clock wakes it, and that a message wakes it now', () => {
    expect(wakesAtText({ state: 'scheduled', endedAt: null, schedule: clock })).toBe('Wakes at 22:30. A message wakes it now.');
    expect(composerPlaceholder({ ...live, state: 'scheduled', queuedUntilUp: 0, schedule: clock })).toBe('Wakes at 22:30. A message wakes it now.');
  });

  it('says so of one its clock pauses between runs, or starts again once it has ended', () => {
    const paused = { ...live, state: 'hibernated' as const, endedAt: '2026-10-11T06:34:00', queuedUntilUp: 0, schedule: { ...clock, hibernates: true } };
    expect(composerPlaceholder(paused)).toBe('Wakes at 22:30. A message wakes it now.');
    const done = { ...live, state: 'done' as const, endedAt: '2026-10-11T06:34:00', schedule: clock };
    expect(composerBlock(done)).toEqual({ reason: 'Wakes at 22:30. A message wakes it now.', action: 'restart' });
  });

  it('says nothing once its clock is off', () => {
    expect(wakesAtText({ state: 'scheduled', endedAt: null, schedule: { ...clock, enabled: false } })).toBeUndefined();
    expect(wakesAtText({ state: 'idle', endedAt: null, schedule: clock })).toBeUndefined();
  });
});

describe('composerPlaceholder', () => {
  const agent = (more: Partial<Parameters<typeof composerPlaceholder>[0]> = {}) => ({ ...live, queuedUntilUp: 0, ...more });

  it('invites a message, or a reply once the agent is waiting on the user', () => {
    expect(composerPlaceholder(agent({ state: 'running' }))).toBe('Message this agent…');
    expect(composerPlaceholder(agent({ state: 'waiting' }))).toBe('Reply…');
  });

  it("keeps a placeholder the caller gave while the agent can take a message, as the Captain's does", () => {
    expect(composerPlaceholder(agent(), 'Ask the Captain…')).toBe('Ask the Captain…');
    expect(composerPlaceholder(agent({ state: 'waiting' }), 'Ask the Captain…')).toBe('Ask the Captain…');
  });

  it('says in a sentence what each state the field cannot simply take a message in is', () => {
    expect(composerPlaceholder(agent({ endedAt: '2026-10-11T10:00:00Z', state: 'hibernated' }))).toBe('Paused: sending wakes it');
    expect(composerPlaceholder(agent({ state: 'rate-limited' }))).toBe('Rate-limited: your message will wait');
    expect(composerPlaceholder(agent({ state: 'starting', queuedUntilUp: 1 }))).toBe('1 message queued until it is up');
    expect(composerPlaceholder(agent({ state: 'starting', queuedUntilUp: 3 }))).toBe('3 messages queued until it is up');
  });

  it('gives the reason a blocked field is off, over a placeholder the caller gave', () => {
    expect(composerPlaceholder(agent({ state: 'needs-permission' }), 'Ask the Captain…')).toBe('Waiting on a permission prompt');
    expect(composerPlaceholder(agent({ endedAt: '2026-10-11T10:00:00Z', state: 'done', reviewOf: 'impl-1' }))).toBe('The agent has ended');
  });
});
