import { describe, expect, it } from 'vitest';
import type { QueueJob } from '@agent-board/daemon/protocol';
import {
  agentLine,
  countsText,
  doneJobs,
  freshJob,
  jobCorner,
  jobState,
  linkText,
  matchingJobs,
  newestChange,
  newQueueData,
  nextJob,
  ordinal,
  openInCardOrder,
  queueData,
  queueTitle,
} from './queue-card';

const agent = { kind: 'agent', sessionId: 's1', name: 'impl-2' } as const;

function job(id: string, fields: Partial<QueueJob> = {}): QueueJob {
  return {
    id,
    queueId: 'q1',
    kind: 'job',
    text: `job ${id}`,
    link: null,
    state: 'queued',
    takenBy: null,
    takenAt: null,
    drops: 0,
    doneBy: null,
    doneAt: null,
    madeBy: { kind: 'user' },
    changedBy: { kind: 'user' },
    lastChange: 'add',
    createdAt: '2026-11-05T09:00:00.000Z',
    updatedAt: '2026-11-05T09:00:00.000Z',
    ...fields,
  };
}

describe('a queue card', () => {
  it('reads its saved data, filling in what an older card lacks, and names itself for its audience and zone', () => {
    expect(queueData({ title: 'api jobs', madeBy: agent, audience: 'user', noAgents: true, count: 2, folded: true })).toEqual({
      title: 'api jobs',
      madeBy: agent,
      audience: 'user',
      noAgents: true,
      count: 2,
      folded: true,
    });
    expect(queueData({})).toEqual({ title: 'Jobs', madeBy: { kind: 'user' }, audience: 'agents', noAgents: false, count: 0, folded: false });
    expect(newQueueData('api')).toMatchObject({ title: 'api jobs', audience: 'agents' });
    expect(newQueueData().title).toBe('Jobs');
    expect(queueTitle('user', 'api')).toBe('To look at');
  });

  it('lists the taken ones first, then the rest in order; the next is the first waiting job, never a note', () => {
    const jobs = [
      job('note', { kind: 'note' }),
      job('a'),
      job('t', { state: 'taken', takenBy: agent }),
      job('b'),
      job('d', { state: 'done', doneBy: agent }),
    ];
    expect(openInCardOrder(jobs).map((each) => each.id)).toEqual(['t', 'note', 'a', 'b']);
    expect(doneJobs(jobs).map((each) => each.id)).toEqual(['d']);
    expect(nextJob(jobs)?.id).toBe('a');
    expect(nextJob([job('n', { kind: 'note' })])).toBeUndefined();
  });

  it('says where each row is, a job dropped back dashed, with the try that comes next in its corner', () => {
    const next = job('a');
    expect(jobState(next, next)).toEqual({ text: 'next', tone: 'next' });
    expect(jobState(job('b'), next)).toEqual({ text: 'queued', tone: 'queued' });
    expect(jobState(job('b', { drops: 1 }), next)).toEqual({ text: 'queued', tone: 'back' });
    expect(jobState(job('a', { drops: 1 }), next)).toEqual({ text: 'next', tone: 'back' });
    expect(jobCorner(job('b', { drops: 1, link: '#4' }))).toBe('#4 · 2nd try');
    expect(jobCorner(job('b', { drops: 3 }))).toBe('4th try');
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111, 112].map(ordinal)).toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '23rd', '101st', '111th', '112th']);
    expect(jobState(job('t', { state: 'taken' }), next).text).toBe('taken');
    expect(jobState(job('d', { state: 'done' }), next).text).toBe('done');
    expect(jobState(job('n', { kind: 'note' }), next).text).toBe('note');
  });

  it('names its taker, who finished it, its link said short, or the agent that queued it: never the user', () => {
    expect(jobCorner(job('t', { state: 'taken', takenBy: agent }))).toBe('impl-2');
    expect(jobCorner(job('d', { state: 'done', doneBy: { kind: 'user' } }))).toBe('you');
    expect(jobCorner(job('l', { link: 'https://example.test/acme/api/issues/12' }))).toBe('#12');
    expect(jobCorner(job('m', { madeBy: agent }))).toBe('impl-2');
    expect(jobCorner(job('u'))).toBe('');
    expect(linkText('https://example.test/acme/api/pull/7/')).toBe('#7');
    expect(linkText('#31')).toBe('#31');
    expect(linkText('docs/plan.md')).toBe('plan.md');
  });

  it('counts its rows by where they are', () => {
    expect(countsText([])).toBe('No jobs yet');
    expect(countsText([job('a'), job('b'), job('t', { state: 'taken' }), job('n', { kind: 'note' }), job('d', { state: 'done' })])).toBe(
      '2 queued · 1 taken · 1 note · 1 done',
    );
    expect(countsText([job('a')], 'user')).toBe('1 to look at');
  });

  it('finds rows holding every word searched, in their text or link', () => {
    const jobs = [job('a', { text: 'Fix the login', link: 'https://example.test/issues/12' }), job('b', { text: 'Write the docs' })];
    expect(matchingJobs(jobs, 'LOGIN issues').map((each) => each.id)).toEqual(['a']);
    expect(matchingJobs(jobs, ' ')).toHaveLength(2);
  });

  it("flashes the change an agent made since it last read, credited to whoever made it, and says what it did", () => {
    const seen = '2026-11-05T09:00:00.000Z';
    const later = '2026-11-05T10:00:00.000Z';
    const taken = job('t', { state: 'taken', takenBy: agent, changedBy: agent, lastChange: 'take', updatedAt: later, text: 'Fix the login' });
    expect(freshJob([job('a'), taken], seen)?.id).toBe('t');
    expect(freshJob([taken], undefined)).toBeUndefined();
    // The user editing a job an agent queued is the user's change: no flash.
    expect(freshJob([job('a', { madeBy: agent, changedBy: { kind: 'user' }, lastChange: 'edit', updatedAt: later })], seen)).toBeUndefined();
    // An agent putting back a job the user queued is the agent's: it flashes, and says so.
    const dropped = job('d', { drops: 1, changedBy: agent, lastChange: 'drop', updatedAt: later, text: 'Docs' });
    expect(freshJob([dropped], seen)?.id).toBe('d');
    expect(agentLine(dropped)).toBe('impl-2 put back Docs');
    expect(agentLine(taken)).toBe('impl-2 took Fix the login');
    expect(agentLine(job('f', { state: 'done', doneBy: agent, changedBy: agent, lastChange: 'done', text: 'Docs' }))).toBe('impl-2 finished Docs');
    expect(newestChange([job('a'), taken])).toBe(later);
  });
});
