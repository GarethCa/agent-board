import { describe, expect, it } from 'vitest';
import type { Agent } from '@agent-board/daemon/protocol';
import { agentSetupLine, effortText } from './AgentSetup';

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
