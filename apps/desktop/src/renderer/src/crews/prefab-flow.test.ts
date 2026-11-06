// A crew prefab as its flow editor draws and words it.
import { describe, expect, it } from 'vitest';
import type { CrewPrefab, PrefabMember } from '@agent-board/daemon/protocol';
import { draftProblems, flowLayout, flowSentence, memberLabel, memberModel, memberRun, modelChoice, newMember, prefabWeight, readModelChoice } from './prefab-flow';

const member = (fields: Partial<PrefabMember> & Pick<PrefabMember, 'id' | 'starts'>): PrefabMember => ({
  role: 'implementer',
  name: null,
  harness: 'claude',
  model: null,
  effort: null,
  template: null,
  subagents: [],
  ...fields,
});

const prefab = (members: PrefabMember[], fields: Partial<CrewPrefab> = {}): CrewPrefab => ({
  name: 'Trio',
  icon: 'crew',
  purpose: '',
  roundLimit: 3,
  onBoard: 'card',
  members,
  ...fields,
});

const builder = member({ id: 'builder', name: 'Builder', model: 'opus', effort: 'high', starts: 'prompt' });
const code = member({ id: 'code-review', role: 'reviewer', starts: 'handoff' });
const design = member({ id: 'design-review', role: 'reviewer', name: 'Design review', starts: 'handoff' });

/** The sentence as plain text, with its bold runs in **. */
const said = (crew: CrewPrefab) => flowSentence(crew).map((words) => (words.bold ? `**${words.text}**` : words.text)).join('');

describe('a member, as the editor names it', () => {
  it('goes by its own name, else its id in words, with its model and reasoning under it', () => {
    expect(memberLabel(builder)).toBe('Builder');
    expect(memberLabel(code)).toBe('Code review');
    expect(memberModel(builder)).toBe('opus · high');
    expect(memberModel(code)).toBe('Its defaults');
    expect(memberModel({ model: null, effort: 'high' })).toBe('high');
  });
});

describe('the flow in words', () => {
  it('says who builds, who reviews at once, and when the crew stops or goes round again', () => {
    expect(said(prefab([builder, code, design]))).toBe(
      '**Builder** builds from your prompt. When it hands off, **Code review** and **Design review** review it at once. If both approve, the crew stops: **ready to merge**. If not, their reviews go back to Builder for the next round, **up to 3 rounds**. Anyone who needs you pauses it.',
    );
    expect(said(prefab([builder, code], { roundLimit: 1 }))).toBe(
      '**Builder** builds from your prompt. When it hands off, **Code review** reviews it. If it approves, the crew stops: **ready to merge**. If not, its review goes back to Builder for the next round, **up to 1 round**. Anyone who needs you pauses it.',
    );
  });

  it('says a lone member works on its own, and a lead starts its crew', () => {
    expect(said(prefab([builder]))).toBe('**Builder** builds from your prompt, on its own. No one reviews its work.');
    const lead = member({ id: 'lead', role: 'orchestrator', starts: 'prompt' });
    expect(said(prefab([lead, member({ id: 'impl', starts: 'lead' }), member({ id: 'review', role: 'reviewer', starts: 'lead' })]))).toBe(
      '**Lead** leads from your prompt, starting **Impl** and **Review** when their work is ready, for **up to 3 rounds of review**. Anyone who needs you pauses it.',
    );
    expect(said(prefab([code]))).toBe('Choose the member that starts with your prompt.');
  });
});

describe('the diagram', () => {
  it('draws your prompt, the builder, its reviewers stacked, the stop and the dashed loop back', () => {
    const layout = flowLayout(prefab([builder, code, design]));

    expect(layout.nodes.map((node) => [node.kind, node.id])).toEqual([
      ['start', null],
      ['member', 'builder'],
      ['member', 'code-review'],
      ['member', 'design-review'],
      ['add', null],
      ['decision', null],
      ['end', null],
    ]);
    const [, first, second, third] = layout.nodes;
    expect(second!.x).toBe(third!.x);
    expect(third!.y).toBeGreaterThan(second!.y);
    // The builder sits level with the middle of its reviewers.
    expect(first!.y).toBe((second!.y + third!.y) / 2);
    expect(layout.wires.filter((wire) => wire.loop)).toHaveLength(1);
    expect(layout.labels.map((label) => label.text)).toEqual(['handover', 'No: reviews go back · next round · up to 3']);
    expect(layout.end).toBe('Ready');
  });

  it('runs the loop back under every member and the add bubble, however many reviewers there are', () => {
    const reviewers = Array.from({ length: 7 }, (_, n) => member({ id: `review-${n}`, role: 'reviewer', starts: 'handoff' }));
    const layout = flowLayout(prefab([builder, ...reviewers]));
    const lowest = Math.max(...layout.nodes.filter((node) => node.kind === 'member' || node.kind === 'add').map((node) => node.y + 88));
    const loop = layout.wires.find((wire) => wire.loop)!;
    const runsAt = Number(/H\d+ Q\S+ (\d+)/.exec(loop.d)![1]);
    expect(runsAt).toBeGreaterThan(lowest);
    expect(layout.height).toBeGreaterThan(runsAt);
    // The stop sits level with the builder, in the middle of the stack.
    const [, first] = layout.nodes;
    const stop = layout.nodes.find((node) => node.kind === 'decision')!;
    expect(stop.y + 40).toBe(first!.y + 22);
  });

  it('ends a lone member at Done, and a lead at its crew, with no stop of the board’s', () => {
    expect(flowLayout(prefab([builder]))).toMatchObject({ end: 'Done', labels: [] });
    const lead = member({ id: 'lead', role: 'orchestrator', starts: 'prompt' });
    const led = flowLayout(prefab([lead, member({ id: 'impl', starts: 'lead' })], { roundLimit: 2 }));
    expect(led.end).toBeNull();
    expect(led.nodes.some((node) => node.kind === 'decision')).toBe(false);
    expect(led.labels.map((label) => label.text)).toEqual(['starts', 'The lead runs its own rounds · up to 2']);
  });

  it('draws members unwired until one starts with your prompt', () => {
    const layout = flowLayout(prefab([code, design]));
    expect(layout.wires).toEqual([]);
    expect(layout.nodes.map((node) => node.kind)).toEqual(['member', 'member', 'add']);
  });
});

describe('a draft', () => {
  it('adds a reviewer at the hand-off, or one more for a lead to start', () => {
    expect(newMember(prefab([builder]))).toMatchObject({ id: 'member-2', role: 'reviewer', starts: 'handoff' });
    expect(newMember(prefab([]))).toMatchObject({ id: 'member-1', role: 'implementer', starts: 'prompt' });
    const lead = member({ id: 'lead', role: 'orchestrator', starts: 'prompt' });
    expect(newMember(prefab([lead, member({ id: 'member-2', starts: 'lead' })]))).toMatchObject({ id: 'member-3', starts: 'lead' });
  });

  it('lists what it lacks before the library would take it', () => {
    expect(draftProblems(prefab([builder, code]))).toEqual([]);
    expect(draftProblems(prefab([], { name: ' ' }))).toEqual(['Name the prefab.', 'Add a member.']);
    expect(draftProblems(prefab([builder, { ...code, starts: 'prompt' }]))).toEqual(['Exactly one member starts with your prompt.']);
    expect(draftProblems(prefab([builder, { ...code, role: 'designer' }]))).toEqual(['Code review starts after a hand-off, so it is a reviewer or follow-up reviewer.']);
    expect(draftProblems(prefab([builder, member({ id: 'impl', starts: 'lead' })]))).toEqual(['Impl is started by the lead, so Builder is an orchestrator.']);
    const lead = member({ id: 'lead', role: 'orchestrator', starts: 'prompt' });
    expect(draftProblems(prefab([lead, member({ id: 'impl', starts: 'lead' }), code]))).toEqual([
      'Code review starts after a hand-off, but in a crew with a lead the lead starts its members.',
    ]);
  });

  it('reads a crew as led as the library does: an orchestrator on the prompt, in any case, with or without its crew yet', () => {
    const lead = member({ id: 'lead', role: 'orchestrator', starts: 'prompt' });
    expect(draftProblems(prefab([lead, code]))).toEqual(['Code review starts after a hand-off, but in a crew with a lead the lead starts its members.']);
    expect(newMember(prefab([lead]))).toMatchObject({ role: 'implementer', starts: 'lead' });
    expect(said(prefab([lead]))).toBe('**Lead** leads from your prompt. Add the members it starts.');
    expect(flowLayout(prefab([lead]))).toMatchObject({ end: null });
    const imported = { ...lead, role: 'Orchestrator' };
    expect(draftProblems(prefab([imported, member({ id: 'impl', starts: 'lead' })]))).toEqual([]);
    expect(said(prefab([imported, member({ id: 'impl', starts: 'lead' })]))).toMatch(/^\*\*Lead\*\* leads from your prompt, starting/);
  });

  it('flags a name too long, a role with no name and an empty template of its own, as the library would', () => {
    expect(draftProblems(prefab([builder, code], { name: 'x'.repeat(49) }))).toEqual(["A prefab's name is at most 48 characters."]);
    expect(draftProblems(prefab([{ ...builder, role: '' }, code]))).toEqual(["Builder's role needs a name."]);
    expect(draftProblems(prefab([{ ...builder, role: 'designer', template: ' ' }, code]))).toEqual(["Builder's own template is empty: write it, or use the zone's."]);
  });
});

describe('the AI and model picker', () => {
  it('reads a model back whole, colons and all, and a harness default as null', () => {
    const bedrock = 'us.anthropic.claude-opus-4-v1:0';
    expect(readModelChoice(modelChoice('claude', bedrock))).toEqual({ harness: 'claude', model: bedrock });
    expect(readModelChoice(modelChoice('codex', null))).toEqual({ harness: 'codex', model: null });
    expect(readModelChoice(modelChoice('claude', 'opus'))).toEqual({ harness: 'claude', model: 'opus' });
  });
});

describe('a prefab, as its card and prompt box word it', () => {
  it('says how heavy it runs', () => {
    expect(prefabWeight(prefab([builder]))).toBe('no loop');
    expect(prefabWeight(prefab([builder, code]))).toBe('3 rounds');
    expect(prefabWeight(prefab([builder, code], { roundLimit: 1 }))).toBe('1 round');
    expect(prefabWeight(prefab([member({ id: 'lead', role: 'orchestrator', starts: 'prompt' }), member({ id: 'impl', starts: 'lead' })]))).toBe('lead decides');
  });

  it('says what each member does and when it starts', () => {
    const crew = prefab([builder, code]);
    expect(memberRun(builder, crew)).toMatchObject({ does: 'builds it', when: 'starts now' });
    expect(memberRun(code, crew)).toMatchObject({ does: 'reviews it', when: 'after Builder hands off' });
    const led = prefab([member({ id: 'lead', role: 'orchestrator', starts: 'prompt' }), member({ id: 'impl', starts: 'lead' })]);
    expect(memberRun(led.members[0]!, led)).toMatchObject({ does: 'runs the crew', when: 'starts now' });
    expect(memberRun(builder, crew, false).detail).not.toMatch(/worktree|branch/);
    expect(memberRun(led.members[1]!, led)).toMatchObject({ when: 'by the lead' });
  });
});
