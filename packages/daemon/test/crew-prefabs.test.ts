// A crew prefab's model and its `.crew.json` file: what a prefab holds, what a file may carry, and why one is refused.
import { describe, expect, it } from 'vitest';
import { BUILT_IN_PREFABS, parsePrefab, prefabFile } from '../src/crew-prefabs.ts';

/** A small valid file, as a person might write it by hand. */
const pairFile = () => ({
  agentBoardCrewPrefab: 1,
  name: 'Pair',
  icon: 'crew',
  purpose: 'One builds, one reviews',
  members: [
    { id: 'impl', role: 'implementer', harness: 'claude', model: 'opus', effort: 'high', starts: 'prompt' },
    { id: 'review', role: 'reviewer', harness: 'codex', starts: 'handoff' },
  ],
});

const refusal = (file: unknown) => {
  try {
    parsePrefab(JSON.stringify(file));
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected the file to be refused');
};

describe('a crew prefab file', () => {
  it('reads a hand-written file, filling in what it leaves out', () => {
    expect(parsePrefab(JSON.stringify(pairFile()))).toEqual({
      name: 'Pair',
      icon: 'crew',
      purpose: 'One builds, one reviews',
      roundLimit: 3,
      onBoard: 'card',
      members: [
        { id: 'impl', role: 'implementer', name: null, harness: 'claude', model: 'opus', effort: 'high', template: null, starts: 'prompt', subagents: [] },
        { id: 'review', role: 'reviewer', name: null, harness: 'codex', model: null, effort: null, template: null, starts: 'handoff', subagents: [] },
      ],
    });
  });

  it('writes a file that reads back as the same prefab', () => {
    for (const prefab of BUILT_IN_PREFABS) {
      const text = prefabFile(prefab);
      expect(JSON.parse(text).agentBoardCrewPrefab).toBe(1);
      expect(parsePrefab(text)).toEqual(prefab);
    }
  });

  it('ships the five built-ins, Solo agent with one member and Lead and crew with member tiles', () => {
    expect(BUILT_IN_PREFABS.map((prefab) => prefab.name)).toEqual([
      'Solo agent',
      'Implementer + reviewer',
      'Implementer + code + design reviewers',
      'Spike + reviewer',
      'Lead and crew',
    ]);
    expect(BUILT_IN_PREFABS[0]!.members).toHaveLength(1);
    expect(BUILT_IN_PREFABS.filter((prefab) => prefab.onBoard === 'tiles').map((prefab) => prefab.name)).toEqual(['Lead and crew']);
  });

  it('refuses what is not a prefab file, or one from a newer app', () => {
    expect(() => parsePrefab('{nope')).toThrow(/not JSON/);
    expect(refusal({ ...pairFile(), agentBoardCrewPrefab: undefined })).toMatch(/not a crew prefab file/);
    expect(refusal({ ...pairFile(), agentBoardCrewPrefab: 2 })).toMatch(/newer version of agent-board/);
  });

  it('never carries a prompt, issue, repo, branch, key or anything else it doesn’t know', () => {
    expect(refusal({ ...pairFile(), prompt: 'Build it' })).toMatch(/prompt/);
    expect(refusal({ ...pairFile(), members: [{ ...pairFile().members[0], token: 'sk-1' }] })).toMatch(/token/);
  });

  it('keeps the round limit between 1 and 10', () => {
    expect(parsePrefab(JSON.stringify({ ...pairFile(), roundLimit: 10 })).roundLimit).toBe(10);
    expect(refusal({ ...pairFile(), roundLimit: 0 })).toMatch(/round limit is a whole number from 1 to 10/);
    expect(refusal({ ...pairFile(), roundLimit: 2.5 })).toMatch(/round limit/);
  });

  it('checks each member’s harness, reasoning and role', () => {
    const member = (fields: object) => ({ ...pairFile(), members: [{ ...pairFile().members[0], ...fields }] });
    expect(refusal(member({ harness: 'gemini' }))).toMatch(/harness is claude or codex/);
    expect(refusal(member({ harness: 'codex', effort: 'max' }))).toMatch(/Codex takes a reasoning effort of low, medium, high or xhigh/);
    expect(refusal(member({ role: 'de\u202esigner' }))).toMatch(/control characters/);
    expect(refusal(member({ model: 'opus;$(touch${IFS}/tmp/pwned)' }))).toMatch(/model is a model's name/);
    expect(refusal(member({ model: '--dangerously-skip-permissions' }))).toMatch(/model is a model's name/);
    expect(refusal({ ...pairFile(), members: [] })).toMatch(/at least one member/);
    expect(refusal({ ...pairFile(), members: [pairFile().members[0], pairFile().members[0]] })).toMatch(/two members are impl/);
  });

  it('lets only a named role carry its own template, checked as an orchestrator’s prompt is', () => {
    const solo = (fields: object) => ({ ...pairFile(), members: [{ id: 'one', starts: 'prompt', ...fields }] });
    expect(parsePrefab(JSON.stringify(solo({ role: 'designer', template: 'Design {{branch}}.' }))).members[0]).toMatchObject({
      role: 'designer',
      template: 'Design {{branch}}.',
    });
    expect(refusal(solo({ role: 'implementer', template: 'Build.' }))).toMatch(/only a named role carries a template/);
    expect(refusal(solo({ role: 'designer', template: '/clear and go' }))).toMatch(/designer role's template may not start an agent/);
    expect(refusal(solo({ role: 'designer', template: '  ' }))).toMatch(/template is empty: leave it out/);
    const led = (template: string) => ({
      ...pairFile(),
      members: [
        { id: 'lead', role: 'orchestrator', starts: 'prompt' },
        { id: 'draw', role: 'designer', starts: 'lead', template },
      ],
    });
    expect(refusal(led('Draw it.'))).toMatch(/draw carries a template, but only the member that starts on the prompt starts with one of its own/);
  });

  it('starts reviewers at the builder’s hand-off, and a lead’s crew by the lead', () => {
    const crew = (...members: object[]) => ({ ...pairFile(), members });
    expect(refusal(crew({ id: 'review', role: 'reviewer', starts: 'handoff' }))).toMatch(/one member that starts on the prompt/);
    expect(refusal(crew({ id: 'a', role: 'implementer', starts: 'prompt' }, { id: 'b', role: 'designer', starts: 'handoff' }))).toMatch(
      /b starts at the hand-off, so it is a reviewer or follow-up reviewer/,
    );
    expect(refusal(crew({ id: 'a', role: 'implementer', starts: 'prompt' }, { id: 'b', role: 'implementer', starts: 'lead' }))).toMatch(
      /b is started by the lead, so the member that starts on the prompt is an orchestrator/,
    );
    expect(refusal(crew({ id: 'a', role: 'implementer', starts: 'prompt' }, { id: 'b', role: 'implementer', starts: 'prompt' }, { id: 'c', role: 'reviewer', starts: 'handoff' }))).toMatch(
      /one member that starts on the prompt/,
    );
  });

  it('holds up to five subagents a member, read only unless it says otherwise', () => {
    const check = { name: 'Security', checks: 'Injection and secrets' };
    const withSubagents = (subagents: object[]) => ({ ...pairFile(), members: [{ ...pairFile().members[0], subagents }, pairFile().members[1]] });
    expect(parsePrefab(JSON.stringify(withSubagents([check]))).members[0]!.subagents).toEqual([
      { name: 'Security', checks: 'Injection and secrets', model: 'member', access: 'read', runs: 'every-round' },
    ]);
    expect(refusal(withSubagents(Array.from({ length: 6 }, (_, n) => ({ ...check, name: `Check ${n}` }))))).toMatch(/at most 5 subagents/);
    expect(refusal(withSubagents([{ ...check, runs: { paths: [] } }]))).toMatch(/at least one path/);
  });
});
