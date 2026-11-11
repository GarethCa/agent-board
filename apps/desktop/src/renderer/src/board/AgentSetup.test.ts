import { describe, expect, it } from 'vitest';
import type { Agent } from '@agent-board/daemon/protocol';
import { agentSetupLine, effortText, plainWhereLine, shelvesSetupLine } from './AgentSetup';

const setup = (fields: Partial<Agent> = {}) =>
  ({ harness: 'claude', model: null, effort: null, effortPending: null, role: null, roleName: null, reviews: null, ...fields }) as Agent;

describe("an agent's setup line", () => {
  it('names its reasoning effort after its model, and leaves it out for its harness’s own', () => {
    expect(agentSetupLine(setup({ model: 'opus', effort: 'high', role: 'reviewer' }))).toBe('Claude · Opus · High reasoning · Reviewer');
    expect(agentSetupLine(setup({ harness: 'codex' }))).toBe('Codex · default model · no role');
  });

  it('says when a new effort is still to be taken', () => {
    expect(effortText(setup({ effort: 'xhigh', effortPending: 'after-turn' }))).toBe('Extra high reasoning after this turn');
    expect(effortText(setup({ harness: 'codex', effort: 'low', effortPending: 'restart' }))).toBe('Low reasoning on restart');
    expect(effortText(setup())).toBeNull();
    expect(effortText(setup({ effortPending: 'restart' }))).toBe('Default reasoning on restart');
  });
});

describe("an agent's setup line on its shelves", () => {
  it('leaves out what is not there: a default model, no role', () => {
    expect(shelvesSetupLine(setup())).toBe('Claude');
    expect(shelvesSetupLine(setup({ model: 'opus' }))).toBe('Claude · Opus');
    expect(shelvesSetupLine(setup({ model: 'opus', effort: 'high', role: 'reviewer' }))).toBe('Claude · Opus · High reasoning · Reviewer');
  });
});

describe('the footer’s plain line', () => {
  const where = (fields: Partial<Agent> = {}) => plainWhereLine(setup({ plainFolder: false, ownsWorktree: true, worktree: '/w/a', repoRoot: '/r', ...fields }));

  it('says a copy of its own for an agent with a worktree', () => {
    expect(where()).toBe('Working in its own copy');
  });

  it('says the user’s checkout for an agent in the repo’s own folder', () => {
    expect(where({ ownsWorktree: false, worktree: '/r' })).toBe('Working in your checkout');
  });

  it('says the user’s folder for an agent in a plain folder', () => {
    expect(where({ plainFolder: true, ownsWorktree: false, worktree: '/r' })).toBe('Working in your folder');
  });

  it('names the branch a reviewer reviews', () => {
    expect(where({ reviews: { branch: 'docs/intro', head: 'abc1234' } as Agent['reviews'] })).toBe('Reviewing docs/intro’s changes');
  });
});
