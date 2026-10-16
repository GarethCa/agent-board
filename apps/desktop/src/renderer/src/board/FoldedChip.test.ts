import { describe, expect, it } from 'vitest';
import type { Agent } from '@agent-board/daemon/protocol';
import { chipPill } from './FoldedChip';

const ended = (extra: Partial<Agent>) => ({ endedAt: 'then', exitCode: 0, state: 'done', pullRequests: [], ...extra }) as Agent;

describe('chipPill', () => {
  it('says ended for an ended agent, with its exit code', () => {
    expect(chipPill(ended({}))).toEqual({ state: 'done', label: 'ended · exit 0' });
    expect(chipPill(ended({ exitCode: 1, state: 'failed' }))).toEqual({ state: 'failed', label: 'ended · exit 1' });
  });

  it('says merged only when all its own pull requests are', () => {
    const pr = (state: string) => ({ number: 1, title: '', url: '', state, checks: 'passing' }) as Agent['pullRequests'][number];
    expect(chipPill(ended({ pullRequests: [pr('merged'), pr('open')] }))).toEqual({ state: 'done', label: 'ended · exit 0' });
    expect(chipPill(ended({ pullRequests: [pr('merged'), pr('merged')] }))).toEqual({ state: 'done', label: 'merged' });
  });

  it('says merged once its own pull request is', () => {
    const merged = { number: 1, title: '', url: '', state: 'merged', checks: 'passing' } as Agent['pullRequests'][number];
    expect(chipPill(ended({ pullRequests: [merged] }))).toEqual({ state: 'done', label: 'merged' });
  });
});
