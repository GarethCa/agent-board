// A crew prefab as its flow editor draws and words it.
import { describe, expect, it } from 'vitest';
import type { CrewPrefab, PrefabMember } from '@agent-board/daemon/protocol';
import { draftProblems, flowLayout, flowSentence, gateRule, gateWait, graphLayout, graphSentence, joinBadge, memberBranch, memberLabel, memberModel, memberRun, modelChoice, newMember, prefabWeight, readModelChoice, type GraphPrefab } from './prefab-flow';

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

describe('a prefab drawn as a graph', () => {
  const designer = member({ id: 'des', role: 'designer', name: 'designer', starts: 'prompt', works: 'crew' });
  const designReview = member({ id: 'dr', role: 'reviewer', name: 'design review', starts: 'handoff' });
  const build = member({ id: 'b', name: 'Builder', starts: 'handoff', works: 'own' });
  const codeReview = member({ id: 'cr', role: 'reviewer', name: 'code review', starts: 'handoff' });
  const testsReview = member({ id: 'tr', role: 'reviewer', name: 'tests review', starts: 'handoff' });
  const canvasA: GraphPrefab = {
    members: [designer, designReview, build, codeReview, testsReview],
    inputs: [
      { id: 'p', kind: 'prompt' },
      { id: 'ok', kind: 'user' },
      { id: 'end', kind: 'end', as: 'ready' },
    ],
    gates: [
      { id: 'g1', rule: 'done', cap: 5, atCap: 'ask', timeout: 30 },
      { id: 'g2', rule: 'done', cap: 5, atCap: 'ask', timeout: 30 },
    ],
    lines: [
      { from: 'p', to: 'des' },
      { from: 'des', to: 'dr', carries: 'handoff' },
      { from: 'dr', to: 'g1', carries: 'review' },
      { from: 'g1', to: 'des', way: 'again' },
      { from: 'g1', to: 'ok', way: 'done' },
      { from: 'ok', to: 'b' },
      { from: 'b', to: 'cr', carries: 'handoff' },
      { from: 'b', to: 'tr', carries: 'handoff' },
      { from: 'cr', to: 'g2', carries: 'review' },
      { from: 'tr', to: 'g2', carries: 'review' },
      { from: 'g2', to: 'b', way: 'again' },
      { from: 'g2', to: 'end', way: 'done' },
    ],
  };
  const text = (words: { text: string }[]) => words.map((each) => each.text).join('');

  it('words a gate by who decides and its limit', () => {
    const gate = { id: 'g', rule: 'done', cap: 5, atCap: 'ask', timeout: 30 } as const;
    expect(gateRule(gate, [codeReview])).toBe('until it approves · max 5');
    expect(gateRule(gate, [codeReview, testsReview])).toBe('until both approve · max 5');
    expect(gateRule(gate, [codeReview, testsReview, designReview])).toBe('until all approve · max 5');
    expect(gateRule({ ...gate, cap: null }, [designer])).toBe('until done · no limit');
    expect(gateRule({ id: 'g', rule: 'rounds', rounds: 1, timeout: null }, [codeReview])).toBe('1 round');
    expect(gateRule({ id: 'g', rule: 'rounds', rounds: 3, timeout: null }, [codeReview])).toBe('3 rounds');
  });

  it('badges a member that waits for more than one line', () => {
    expect(joinBadge(codeReview, 1)).toBeNull();
    expect(joinBadge({ ...codeReview, timeout: 30 }, 2)).toBe('waits for both · 30 min');
    expect(joinBadge(codeReview, 3)).toBe('waits for all');
    expect(joinBadge({ ...codeReview, join: 'each' }, 2)).toBe('each as it comes');
  });

  it('lays nodes out in columns by the longest way from an input, the again lines left out', () => {
    const at = graphLayout(canvasA, { member: { width: 100, height: 60 }, input: { width: 80, height: 40 }, gate: { width: 50, height: 50 } }, { gap: 40, row: 20 });
    const x = (id: string) => at.get(id)!.x;
    expect(x('p')).toBe(0);
    expect(x('des')).toBe(120);
    expect(x('dr')).toBe(260);
    expect(x('g1')).toBeGreaterThan(x('dr'));
    expect(x('cr')).toBe(x('tr'));
    expect(x('end')).toBeGreaterThan(x('g2'));
    // Two in a column stand one above the other, centred on the row of one.
    expect(at.get('cr')!.y).toBeLessThan(at.get('tr')!.y);
    expect(at.get('cr')!.y + at.get('tr')!.y + 60).toBe(2 * at.get('b')!.y + 60);
  });

  it('lays out a graph with a cycle of plain lines without hanging', () => {
    const loop: GraphPrefab = { ...canvasA, gates: [], lines: [{ from: 'p', to: 'des' }, { from: 'des', to: 'dr' }, { from: 'dr', to: 'des' }] };
    const at = graphLayout(loop, { member: { width: 100, height: 60 }, input: { width: 80, height: 40 }, gate: { width: 50, height: 50 } }, { gap: 40, row: 20 });
    expect(at.size).toBe(loop.members.length + loop.inputs.length);
  });

  it('reads the graph as a sentence, as under the canvas', () => {
    expect(text(graphSentence(canvasA))).toBe(
      'Your prompt goes to designer, on the crew branch. Its work goes to design review; the loop gate waits 30 minutes for it, and sends it back until design review says done, at most 5 rounds. ' +
        'Then the crew waits for your OK. Builder gets it and works on its own branch. Its work goes to code review and tests review; the loop gate waits for both, or 30 minutes, and sends it back until both approve, at most 5 rounds. ' +
        'Then it stops, ready to merge.',
    );
    expect(graphSentence(canvasA).filter((each) => each.bold).map((each) => each.text)).toEqual(
      expect.arrayContaining(['Your prompt', 'designer', 'design review', 'waits for your OK', 'Builder', 'code review', 'tests review', 'ready to merge']),
    );
  });

  it('reads a lead crew and an unbounded loop', () => {
    const lead = member({ id: 'lead', role: 'orchestrator', name: 'Lead', starts: 'prompt' });
    const impl = member({ id: 'impl', name: 'Builder', starts: 'lead' });
    const led: GraphPrefab = {
      members: [lead, impl],
      inputs: [{ id: 'prompt', kind: 'prompt' }, { id: 'end', kind: 'end', as: 'done' }],
      gates: [],
      lines: [{ from: 'prompt', to: 'lead' }, { from: 'lead', to: 'impl', lead: true }, { from: 'lead', to: 'end' }],
    };
    expect(text(graphSentence(led))).toBe('Your prompt goes to Lead. Lead starts Builder when it needs them. Then it stops, done.');
    const solo: GraphPrefab = { members: [lead], inputs: led.inputs, gates: [], lines: [{ from: 'prompt', to: 'lead' }] };
    expect(text(graphSentence(solo))).toBe('Your prompt goes to Lead.');
    const open: GraphPrefab = { ...canvasA, gates: [{ id: 'g1', rule: 'done', cap: null, atCap: 'ask', timeout: null }, canvasA.gates[1]!] };
    expect(text(graphSentence(open))).toContain('until design review says done, with no limit.');
  });

  it('words what a loop gate waits for, on its badge', () => {
    expect(gateWait({ timeout: 30 }, 2)).toBe('waits for both · 30 min');
    expect(gateWait({ timeout: null }, 3)).toBe('waits for all 3');
    expect(gateWait({ timeout: 15 }, 1)).toBe('waits 15 min');
    expect(gateWait({ timeout: null }, 1)).toBeNull();
    expect(gateWait({ timeout: null }, 0)).toBeNull();
  });

  it('says a writer\'s branch from its role when it sets none, and capitalises a name that starts a sentence', () => {
    const plain = { ...canvasA, members: canvasA.members.map((each) => (each.id === 'b' ? member({ id: 'b', name: 'builder', starts: 'handoff' }) : each)) };
    expect(text(graphSentence(plain))).toContain('Then the crew waits for your OK. Builder gets it and works on its own branch.');
    // A crew of one writer says no branch.
    const one = { ...plain, members: plain.members.filter((each) => each.id !== 'des') };
    expect(memberBranch(one.members, 'b')).toBeNull();
    expect(memberBranch(plain.members, 'dr')).toBeNull();
  });

  it('says a one-decider loop gate\'s timeout', () => {
    const builder = member({ id: 'b', name: 'Builder', starts: 'prompt' });
    const review = member({ id: 'r', role: 'reviewer', name: 'Review', starts: 'handoff' });
    const pair: GraphPrefab = {
      members: [builder, review],
      inputs: [{ id: 'prompt', kind: 'prompt' }, { id: 'end', kind: 'end', as: 'ready' }],
      gates: [{ id: 'g', rule: 'rounds', rounds: 2, timeout: 15 }],
      lines: [{ from: 'prompt', to: 'b' }, { from: 'b', to: 'r' }, { from: 'r', to: 'g' }, { from: 'g', to: 'b', way: 'again' }, { from: 'g', to: 'end', way: 'done' }],
    };
    expect(text(graphSentence(pair))).toBe('Your prompt goes to Builder. Its work goes to Review; the loop gate waits 15 minutes for it, and sends it round again, 2 rounds in all. Then it stops, ready to merge.');
  });

  it("names your OK in the prompt's line and says the end once, last, and an agent whose work goes nowhere yet", () => {
    const web = member({ id: 'web', name: 'web', starts: 'prompt' });
    const both: GraphPrefab = {
      members: [web],
      inputs: [{ id: 'prompt', kind: 'prompt' }, { id: 'ok', kind: 'user' }, { id: 'end', kind: 'end', as: 'ready' }],
      gates: [],
      lines: [{ from: 'prompt', to: 'web' }, { from: 'prompt', to: 'ok' }, { from: 'ok', to: 'end' }, { from: 'web', to: 'end' }],
    };
    expect(text(graphSentence(both))).toBe('Your prompt goes to web, and to your OK. Then it stops, ready to merge.');
    // Your OK on to an agent of its own: the end is said once, last, after both.
    const builder = member({ id: 'b', name: 'B', starts: 'handoff' });
    const split: GraphPrefab = {
      members: [{ ...web, name: 'A' }, builder],
      inputs: both.inputs,
      gates: [],
      lines: [{ from: 'prompt', to: 'web' }, { from: 'web', to: 'end' }, { from: 'prompt', to: 'ok' }, { from: 'ok', to: 'b' }, { from: 'b', to: 'end' }],
    };
    expect(text(graphSentence(split))).toBe('Your prompt goes to A, on its own branch, and to your OK. After your OK, B gets it and works on its own branch. Then it stops, ready to merge.');
    const review = member({ id: 'r', role: 'reviewer', name: 'review', starts: 'handoff' });
    const half: GraphPrefab = { members: [web, review], inputs: [{ id: 'prompt', kind: 'prompt' }], gates: [], lines: [{ from: 'prompt', to: 'web' }, { from: 'web', to: 'r' }] };
    expect(text(graphSentence(half))).toBe('Your prompt goes to web. Its work goes to review. Nothing goes on from review yet.');
  });

  it('says once the reviewer two makers both hand to, and stops after it', () => {
    const web = member({ id: 'web', name: 'web', starts: 'prompt', works: 'own' });
    const api = member({ id: 'api', name: 'api', starts: 'prompt', works: 'own' });
    const integration = member({ id: 'int', role: 'reviewer', name: 'integration review', starts: 'handoff', join: 'all', timeout: 20 });
    const two: GraphPrefab = {
      members: [web, api, integration],
      inputs: [{ id: 'prompt', kind: 'prompt' }, { id: 'end', kind: 'end', as: 'ready' }],
      gates: [],
      lines: [{ from: 'prompt', to: 'web' }, { from: 'prompt', to: 'api' }, { from: 'web', to: 'int' }, { from: 'api', to: 'int' }, { from: 'int', to: 'end' }],
    };
    expect(text(graphSentence(two))).toBe('Your prompt goes to web and api, each on its own branch. Their work goes to integration review, which waits for both, or 20 minutes. Then it stops, ready to merge.');
    // Each as it comes; and all, with no timeout.
    const each: GraphPrefab = { ...two, members: [web, api, { ...integration, join: 'each' }] };
    expect(text(graphSentence(each))).toContain('Their work goes to integration review, which takes each as it comes.');
    // Work that goes to two members leaves the join to the later line that says it.
    const docsReview = member({ id: 'docs', role: 'reviewer', name: 'docs', starts: 'handoff' });
    const fork: GraphPrefab = {
      ...two,
      members: [web, api, integration, docsReview],
      lines: [...two.lines, { from: 'web', to: 'docs' }, { from: 'docs', to: 'end' }],
    };
    expect(text(graphSentence(fork))).toContain("Web's work goes to integration review and docs. Api's work goes to integration review, which waits for both, or 20 minutes.");
    // A later single-target line says the join, after both lines in, as before.
    const builder = member({ id: 'a', name: 'a', starts: 'prompt' });
    const sibling = member({ id: 'b', name: 'b', starts: 'handoff' });
    const joiner = member({ id: 'j', role: 'reviewer', name: 'j', starts: 'handoff', join: 'all', timeout: 10 });
    const later: GraphPrefab = {
      members: [builder, sibling, joiner],
      inputs: [{ id: 'prompt', kind: 'prompt' }, { id: 'end', kind: 'end', as: 'ready' }],
      gates: [],
      lines: [{ from: 'prompt', to: 'a' }, { from: 'a', to: 'b' }, { from: 'a', to: 'j' }, { from: 'b', to: 'j' }, { from: 'j', to: 'end' }],
    };
    expect(text(graphSentence(later))).toContain("Its work goes to b and j. B's work goes to j, which waits for both, or 10 minutes.");
    // Their work: both lines in are on the one multi-target line.
    const together: GraphPrefab = { ...fork, lines: [...two.lines, { from: 'api', to: 'docs' }, { from: 'web', to: 'docs' }, { from: 'docs', to: 'end' }] };
    expect(text(graphSentence(together))).toContain('Their work goes to integration review and docs. Integration review waits for both, or 20 minutes. Docs waits for both. Then it stops');
    // With a loop gate the join waits for the line it is still to be said by.
    const gated: GraphPrefab = {
      members: [web, api, integration, docsReview],
      inputs: two.inputs,
      gates: [{ id: 'loop', rule: 'done', cap: 3, atCap: 'ask', timeout: null }],
      lines: [{ from: 'prompt', to: 'web' }, { from: 'prompt', to: 'api' }, { from: 'web', to: 'int' }, { from: 'web', to: 'docs' }, { from: 'docs', to: 'loop' }, { from: 'loop', to: 'web' }, { from: 'api', to: 'int' }, { from: 'int', to: 'end' }],
    };
    expect(text(graphSentence(gated))).toContain("the loop gate sends it back until docs says done, at most 3 rounds. Api's work goes to integration review, which waits for both, or 20 minutes.");
    // Past the loop gate, once both lines in are said.
    const gatedTogether: GraphPrefab = { ...gated, lines: [...gated.lines, { from: 'api', to: 'docs' }] };
    expect(text(graphSentence(gatedTogether))).toContain('the loop gate sends it back until docs says done, at most 3 rounds. Integration review waits for both, or 20 minutes. Docs waits for both. Then it stops');
    const three: GraphPrefab = {
      ...two,
      members: [web, api, member({ id: 'docs', name: 'docs', starts: 'prompt', works: 'own' }), { ...integration, timeout: undefined }],
      lines: [...two.lines, { from: 'prompt', to: 'docs' }, { from: 'docs', to: 'int' }],
    };
    expect(text(graphSentence(three))).toContain('Their work goes to integration review, which waits for all.');
    // Makers whose work goes different ways are each said on their own.
    const apart: GraphPrefab = { ...two, lines: [...two.lines.filter((line) => !(line.from === 'api' && line.to === 'int')), { from: 'api', to: 'end' }] };
    // Said apart, each maker's work is said by name, so `its` can't mean either.
    const docs: GraphPrefab = { ...apart, members: [{ ...web, name: 'docs' }, api, integration] };
    expect(text(graphSentence(docs))).toContain("Docs' work goes to integration review.");
    expect(graphSentence(docs)).toContainEqual({ text: 'Docs', bold: true });
    expect(text(graphSentence(apart))).toBe("Your prompt goes to web and api, each on its own branch. Web's work goes to integration review. Then it stops, ready to merge.");
  });

  it('says the join of a member past your OK', () => {
    const web = member({ id: 'web', name: 'web', starts: 'prompt', works: 'own' });
    const review = member({ id: 'review', role: 'reviewer', name: 'review', starts: 'handoff', join: 'all', timeout: 20, works: 'own' });
    const api = member({ id: 'api', name: 'api', starts: 'prompt', works: 'own' });
    const joined: GraphPrefab = {
      members: [web, api, review],
      inputs: [{ id: 'prompt', kind: 'prompt' }, { id: 'ok', kind: 'user' }, { id: 'end', kind: 'end', as: 'ready' }],
      gates: [],
      lines: [{ from: 'prompt', to: 'web' }, { from: 'prompt', to: 'api' }, { from: 'web', to: 'ok' }, { from: 'ok', to: 'review' }, { from: 'api', to: 'review' }, { from: 'review', to: 'end' }],
    };
    expect(text(graphSentence(joined))).toBe(
      "Your prompt goes to web and api, each on its own branch. Then the crew waits for your OK. Review gets it, which waits for both, or 20 minutes. Api's work goes to review. Then it stops, ready to merge.",
    );
    // The joined member said first by its other line: the OK still goes on to it.
    const apiFirst: GraphPrefab = { ...joined, members: [api, web, review], lines: [joined.lines[1]!, joined.lines[0]!, ...joined.lines.slice(2)] };
    expect(text(graphSentence(apiFirst))).toBe(
      "Your prompt goes to api and web, each on its own branch. Api's work goes to review, which waits for both, or 20 minutes. Then the crew waits for your OK. Your OK goes on to review too. Then it stops, ready to merge.",
    );
    // The source goes to the OK itself, after the member that reaches the join.
    const straight: GraphPrefab = { ...joined, members: [web, review], lines: [{ from: 'prompt', to: 'web' }, { from: 'prompt', to: 'ok' }, { from: 'web', to: 'review' }, { from: 'ok', to: 'review' }, { from: 'review', to: 'end' }] };
    expect(text(graphSentence(straight))).toBe(
      'Your prompt goes to web, and to your OK. Its work goes to review, which waits for both, or 20 minutes. Your OK goes on to review too. Then it stops, ready to merge.',
    );
    const each: GraphPrefab = { ...joined, members: [web, api, { ...review, join: 'each', works: undefined }] };
    expect(text(graphSentence(each))).toContain('Review gets it, which takes each as it comes.');
    const writes: GraphPrefab = { ...joined, members: [web, api, member({ id: 'review', name: 'merge', starts: 'handoff', join: 'all', works: 'crew' })] };
    expect(text(graphSentence(writes))).toContain('Merge gets it, which waits for both, and works on the crew branch.');
  });

  it('reads work that goes to your OK first, and a decider\'s other lines out', () => {
    const builder = member({ id: 'builder', name: 'Builder', starts: 'prompt' });
    const review = member({ id: 'review', role: 'reviewer', name: 'Review', starts: 'handoff' });
    const asked: GraphPrefab = {
      members: [builder],
      inputs: [{ id: 'prompt', kind: 'prompt' }, { id: 'ok', kind: 'user' }, { id: 'end', kind: 'end', as: 'ready' }],
      gates: [],
      lines: [{ from: 'prompt', to: 'ok' }, { from: 'ok', to: 'builder' }, { from: 'builder', to: 'end' }],
    };
    expect(text(graphSentence(asked))).toBe('Your prompt starts it. Then the crew waits for your OK. Builder gets it. Then it stops, ready to merge.');
    const twoEnds: GraphPrefab = {
      members: [builder, review],
      inputs: [{ id: 'prompt', kind: 'prompt' }, { id: 'end', kind: 'end', as: 'ready' }, { id: 'done', kind: 'end', as: 'done' }],
      gates: [{ id: 'loop', rule: 'done', cap: 3, atCap: 'ask', timeout: null }],
      lines: [
        { from: 'prompt', to: 'builder' },
        { from: 'builder', to: 'review', carries: 'handoff' },
        { from: 'review', to: 'loop', carries: 'review' },
        { from: 'review', to: 'done' },
        { from: 'loop', to: 'builder', way: 'again' },
        { from: 'loop', to: 'end', way: 'done' },
      ],
    };
    expect(text(graphSentence(twoEnds))).toBe(
      'Your prompt goes to Builder. Its work goes to Review; the loop gate sends it back until Review says done, at most 3 rounds. Then it stops, ready to merge. Then it stops, done.',
    );
  });

  it('reads a prefab with no input as a prompt to draw one', () => {
    expect(text(graphSentence({ members: [designer], inputs: [], gates: [], lines: [] }))).toBe('Draw a line from Your prompt to the agent that starts.');
  });
});
