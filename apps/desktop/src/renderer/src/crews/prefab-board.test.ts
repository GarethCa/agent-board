import { describe, expect, it } from 'vitest';
import { SOURCE_NAMES } from './prefab-flow';
import { PROMPT_PLACE, type CrewPrefab, type PrefabLine, type PrefabMember } from '@agent-board/daemon/protocol';
import {
  addAgent,
  addGate,
  addInput,
  withInputKind,
  SOURCE_KINDS,
  AGENT_TILE,
  GATE_SIZE,
  PROMPT_PILL,
  agentPrefab,
  againDip,
  boardDraft,
  boardPlaces,
  boardPrefab,
  boardSentence,
  END_PILL,
  branchTag,
  fitPadding,
  fitViewport,
  graphBounds,
  loopSag,
  joinCount,
  copyName,
  libraryBoard,
  lineKind,
  newPrefab,
  pasted,
  startWord,
  withGate,
  withLine,
  withLineSet,
  withoutLine,
  withoutNodes,
  type BoardDraft,
} from './prefab-board';

const member = (id: string, role: string | null, fields: Partial<PrefabMember> = {}): PrefabMember => ({
  id,
  role,
  name: null,
  harness: 'claude',
  model: null,
  effort: null,
  template: null,
  starts: 'handoff',
  subagents: [],
  ...fields,
});

const pair: CrewPrefab = {
  name: 'Pair',
  icon: 'crew',
  purpose: 'One builds, one reviews',
  roundLimit: 2,
  onBoard: 'card',
  members: [member('builder', 'implementer', { name: 'Builder', starts: 'prompt' }), member('review', 'reviewer', { name: 'Review' })],
};

/** Pair's graph, as the library has it. */
const pairGraph: Pick<CrewPrefab, 'inputs' | 'gates' | 'lines'> = {
  inputs: [
    { id: 'prompt', kind: 'prompt' },
    { id: 'end', kind: 'end', as: 'ready' },
  ],
  gates: [{ id: 'loop', rule: 'done', cap: 2, atCap: 'ask', timeout: null }],
  lines: [
    { from: 'prompt', to: 'builder' },
    { from: 'builder', to: 'review', carries: 'handoff' },
    { from: 'review', to: 'loop', carries: 'review' },
    { from: 'loop', to: 'builder', way: 'again' },
    { from: 'loop', to: 'end', way: 'done' },
  ],
};

const text = (draft: BoardDraft) =>
  boardSentence(draft)
    .map((words) => words.text)
    .join('');
const into = (draft: BoardDraft, id: string) => draft.lines.filter((line) => line.to === id);

describe('a prefab as its own board', () => {
  it('draws the graph: its inputs, its loop gate and each line, from the members’ starts when it was saved without', () => {
    const draft = boardDraft(pair);
    expect(draft.inputs.map((each) => each.input)).toEqual(pairGraph.inputs);
    expect(draft.gates.map((each) => each.gate)).toEqual(pairGraph.gates);
    expect(draft.lines).toEqual(pairGraph.lines);
    expect(draft.lines.map((line) => lineKind(line))).toEqual(['plain', 'plain', 'plain', 'again', 'done']);
    expect(draft.agents.map((agent) => startWord(draft, agent.member.id))).toEqual([{ text: 'Starts on your prompt' }, { text: 'At Builder’s hand-off' }]);
  });

  it('puts each thing where it was saved, an older save’s prompt too, and lays out the rest left to right', () => {
    const saved = boardDraft({ ...pair, ...pairGraph, places: { [PROMPT_PLACE]: { x: -300, y: 0 }, builder: { x: 10, y: 20 }, review: { x: 400, y: 20 }, loop: { x: 700, y: 50 } } });
    expect(saved.inputs[0]!.place).toEqual({ x: -300, y: 0 });
    expect(saved.agents.map((agent) => agent.place)).toEqual([
      { x: 10, y: 20 },
      { x: 400, y: 20 },
    ]);
    expect(saved.gates[0]!.place).toEqual({ x: 700, y: 50 });
    // The end, never placed, goes after the loop gate, laid out beside the builder where it was saved.
    expect(saved.inputs[1]!.place.x).toBeGreaterThan(400);
    const laid = boardDraft(pair);
    const x = (id: string) => [...laid.agents.map((each) => [each.member.id, each.place] as const), ...laid.inputs.map((each) => [each.input.id, each.place] as const), ...laid.gates.map((each) => [each.gate.id, each.place] as const)].find(([each]) => each === id)![1].x;
    expect(x('prompt')).toBeLessThan(x('builder'));
    expect(x('builder')).toBeLessThan(x('review'));
    expect(x('review')).toBeLessThan(x('loop'));
    expect(x('loop')).toBeLessThan(x('end'));
    expect(boardPlaces(laid)).toMatchObject({ [PROMPT_PLACE]: laid.inputs[0]!.place, prompt: laid.inputs[0]!.place, loop: laid.gates[0]!.place, end: laid.inputs[1]!.place });
  });

  it('gives each line what it is by where it runs: a hand-off, a review, a lead line, or a gate’s again and done', () => {
    const base = boardDraft({ ...pair, members: [pair.members[0]!], roundLimit: 2 });
    const one = addAgent(base, 'reviewer', { x: 0, y: 0 });
    const reviewer = one.id;
    const gated = addGate(one.draft, { x: 0, y: 0 });
    let draft = withLine(gated.draft, 'builder', reviewer);
    draft = withLine(draft, reviewer, gated.id);
    draft = withLine(draft, gated.id, 'builder');
    draft = withLine(draft, gated.id, 'end');
    expect(draft.lines.slice(-4)).toEqual([
      { from: 'builder', to: reviewer, carries: 'handoff' },
      { from: reviewer, to: gated.id, carries: 'review' },
      { from: gated.id, to: 'builder', way: 'again' },
      { from: gated.id, to: 'end', way: 'done' },
    ]);
    // A second line from the gate to a member is a done line: the gate has its one again line.
    const second = addAgent(draft, 'builder', { x: 0, y: 0 });
    expect(withLine(second.draft, gated.id, second.id).lines.at(-1)).toEqual({ from: gated.id, to: second.id, way: 'done' });
    // A lead's line starts the member.
    const led = addAgent(boardDraft({ ...pair, members: [member('lead', 'orchestrator', { name: 'Lead', starts: 'prompt' })] }), 'builder', { x: 0, y: 0 });
    const leadLine = withLine(led.draft, 'lead', led.id);
    expect(leadLine.lines.at(-1)).toEqual({ from: 'lead', to: led.id, lead: true });
    expect(lineKind(leadLine.lines.at(-1)!)).toBe('lead');
    expect(startWord(leadLine, led.id)).toEqual({ text: 'Started by Lead' });
  });

  it('lets more than one line into a member, a join, but refuses a line no graph holds', () => {
    const draft = boardDraft(pair);
    const extra = addAgent(draft, 'builder', { x: 0, y: 0 });
    const joined = withLine(withLine(extra.draft, 'prompt', extra.id), 'builder', extra.id);
    expect(into(joined, extra.id)).toHaveLength(2);
    // Into a source, out of an end, to itself, twice, or to nothing on the board: the board as it was.
    expect(withLine(joined, 'builder', 'prompt')).toBe(joined);
    expect(withLine(joined, 'end', 'builder')).toBe(joined);
    expect(withLine(joined, 'builder', 'builder')).toBe(joined);
    expect(withLine(joined, 'builder', extra.id)).toBe(joined);
    expect(withLine(joined, 'builder', 'nowhere')).toBe(joined);
  });

  it('changes a line’s way, the gate’s old again line becoming a done line, and what it carries', () => {
    const draft = boardDraft(pair);
    const again: PrefabLine = { from: 'loop', to: 'builder', way: 'again' };
    const done = withLineSet(draft, again, { way: 'done' });
    expect(done.lines.filter((line) => line.from === 'loop').map((line) => line.way)).toEqual(['done', 'done']);
    const back = withLineSet(withLine(addAgent(draft, 'builder', { x: 0, y: 0 }).draft, 'loop', 'member-3'), { from: 'loop', to: 'member-3' }, { way: 'again' });
    expect(back.lines.filter((line) => line.from === 'loop')).toEqual([
      { from: 'loop', to: 'builder', way: 'done' },
      { from: 'loop', to: 'end', way: 'done' },
      { from: 'loop', to: 'member-3', way: 'again' },
    ]);
    const plain = withLineSet(draft, { from: 'builder', to: 'review' }, { carries: undefined });
    expect(plain.lines[1]).toEqual({ from: 'builder', to: 'review' });
    expect(withoutLine(draft, again).lines).toHaveLength(4);
  });

  it('adds inputs and loop gates with their defaults, each under an id no other thing has', () => {
    const draft = boardDraft(pair);
    const clock = addInput(draft, 'clock', { x: 5, y: 6 });
    expect(clock.draft.inputs.at(-1)).toEqual({ input: { id: 'clock', kind: 'clock', schedule: '0 9 * * 1-5', line: 'Look for new work' }, place: { x: 5, y: 6 } });
    expect(addInput(draft, 'end', { x: 0, y: 0 }).id).toBe('end-2');
    expect(addInput(draft, 'user', { x: 0, y: 0 }).draft.inputs.at(-1)!.input).toEqual({ id: 'ok', kind: 'user' });
    const gate = addGate(draft, { x: 1, y: 2 });
    expect(gate.id).toBe('loop-2');
    expect(gate.draft.gates.at(-1)).toEqual({ gate: { id: 'loop-2', rule: 'done', cap: 5, atCap: 'ask', timeout: 30 }, place: { x: 1, y: 2 } });
    const gone = withoutNodes(gate.draft, ['loop', 'review']);
    expect(gone.gates.map((each) => each.gate.id)).toEqual(['loop-2']);
    expect(gone.lines).toEqual([{ from: 'prompt', to: 'builder' }]);
  });

  it('turns a pill that brings work in to another kind in place, its id, place and lines kept', () => {
    const draft = boardDraft(pair);
    const before = draft.inputs.find((each) => each.input.id === 'prompt')!;
    const clock = withInputKind(draft, 'prompt', 'clock');
    expect(clock.inputs.find((each) => each.input.id === 'prompt')).toEqual({ input: { id: 'prompt', kind: 'clock', schedule: '0 9 * * 1-5', line: 'Look for new work' }, place: before.place });
    expect(clock.lines).toEqual(draft.lines);
    expect(withInputKind(clock, 'prompt', 'queue').inputs.find((each) => each.input.id === 'prompt')!.input).toEqual({ id: 'prompt', kind: 'queue' });
    expect(withInputKind(draft, 'prompt', 'prompt')).toBe(draft);
    expect(withInputKind(draft, 'end', 'queue')).toBe(draft);
    expect(withInputKind(draft, 'nobody', 'queue')).toBe(draft);
  });

  it('keeps the Kind control’s list to the kinds the sentence names as sources', () => {
    expect([...SOURCE_KINDS].sort()).toEqual(Object.keys(SOURCE_NAMES).sort());
  });

  it('saves each member’s start and the round limit from the graph, with the graph and nothing to fix', () => {
    expect(boardPrefab(boardDraft(pair))).toEqual({ prefab: { ...pair, ...pairGraph }, problems: [] });
    const looser = withGate(boardDraft(pair), { id: 'loop', rule: 'done', cap: null, atCap: 'on', timeout: 60 });
    expect(boardPrefab(looser).prefab).toMatchObject({ roundLimit: 10, gates: [{ cap: null }] });
  });

  it('lists what keeps the library from taking it, each problem on the thing it is about, in names not ids', () => {
    const loose = addAgent(boardDraft({ ...pair, name: ' ' }), 'designer', { x: 0, y: 0 });
    expect(boardPrefab(loose.draft).problems).toEqual([
      { text: 'Name the prefab.', about: null },
      { text: 'Designer is reached from no input: draw a line to it from Your prompt, or from a member before it.', about: loose.id },
    ]);
    const open = withoutLine(boardDraft(pair), { from: 'loop', to: 'end' });
    expect(boardPrefab(open).problems).toEqual([{ text: 'The loop gate has at least one done line, where work goes on.', about: 'loop' }]);
    expect(boardPrefab({ ...boardDraft(pair), agents: [], lines: [] }).problems).toEqual([{ text: 'Add an agent.', about: null }]);
  });

  it('names a member whose id is also a word only where the problem names it, and pills by their words', () => {
    const led = boardDraft({
      ...pair,
      members: [member('lead', 'orchestrator', { name: 'Lead', starts: 'prompt' }), member('review', 'reviewer', { name: 'Checks', starts: 'lead' })],
    });
    const carried = { ...led, lines: led.lines.map((line) => (line.lead === true ? { ...line, carries: 'review' as const } : line)) };
    expect(boardPrefab(carried).problems[0]?.text).toBe('The line Lead → Checks is a lead line, which starts a member and carries nothing.');
    const looped = boardDraft({ ...pair, ...pairGraph });
    const fromEnd = { ...looped, lines: [...looped.lines, { from: 'end', to: 'review' }] };
    expect(boardPrefab(fromEnd).problems[0]?.text).toBe('The line Ready to merge → Review: Ready to merge is an end, which no line leaves.');
  });

  it('lists an own prompt on an agent your prompt no longer starts, rather than dropping it at Save', () => {
    const own = { ...pair, members: [member('builder', 'designer', { name: 'Builder', starts: 'prompt', template: 'Draw it' }), member('review', 'reviewer', { name: 'Review' })] };
    const moved = withoutLine(withLine(boardDraft(own), 'prompt', 'review'), { from: 'prompt', to: 'builder' });
    expect(boardPrefab(moved).problems).toContainEqual({ text: 'Builder has a prompt of its own, which only the agent your prompt starts keeps: clear it, or draw Your prompt to it.', about: 'builder' });
  });

  it('says the board in a sentence under it', () => {
    expect(text(boardDraft(pair))).toBe('Your prompt goes to Builder. Its work goes to Review; the loop gate sends it back until Review says done, at most 2 rounds. Then it stops, ready to merge.');
    expect(text(boardDraft(newPrefab()))).toBe('Your prompt goes to Builder. Then it stops, ready to merge.');
    expect(text({ ...boardDraft(pair), lines: [] })).toBe('Draw a line from Your prompt to the agent that starts.');
  });

  it('pastes copies 32px on, with new ids and the lines between them', () => {
    const draft = boardDraft(pair);
    const copy = pasted(draft, draft.agents, draft.lines);
    expect(copy.draft.agents.slice(2).map((agent) => [agent.member.id, agent.place.x - draft.agents.find((each) => each.member.name === agent.member.name)!.place.x])).toEqual([
      ['builder-2', 32],
      ['review-2', 32],
    ]);
    expect(copy.draft.lines.slice(5)).toEqual([{ from: 'builder-2', to: 'review-2', carries: 'handoff' }]);
    expect(copy.ids).toEqual(['builder-2', 'review-2']);
  });

  it('opens a new prefab as Your prompt and one Builder, and a built-in as a copy saved as new', () => {
    expect(boardPrefab(boardDraft(newPrefab())).problems).toEqual([{ text: 'Name the prefab.', about: null }]);
    expect(copyName('Pair')).toBe('Pair (copy)');
    expect(copyName('x'.repeat(48))).toHaveLength(48);
    const built = { ...pair, builtIn: true, editedAt: null };
    expect(libraryBoard(built)).toMatchObject({ prefab: { name: 'Pair (copy)' }, replaces: null });
    expect(libraryBoard({ ...built, builtIn: false })).toEqual({ prefab: pair, replaces: 'Pair' });
    expect(libraryBoard({ ...built, builtIn: false }, true).replaces).toBeNull();
    expect(boardPrefab({ ...boardDraft(libraryBoard({ ...pair, ...pairGraph, builtIn: false, editedAt: null }).prefab), name: 'Renamed' }).prefab).toMatchObject({ ...pairGraph, name: 'Renamed' });
  });

  it('tags each agent’s branch only where the crew has more than one that writes, never a reviewer’s', () => {
    expect(boardDraft(pair).agents.map((agent) => branchTag(boardDraft(pair), agent.member.id))).toEqual([null, null]);
    const two = addAgent(boardDraft(pair), 'designer', { x: 0, y: 0 });
    expect([...two.draft.agents.map((agent) => branchTag(two.draft, agent.member.id))]).toEqual(['own branch', null, 'crew branch']);
    const shared = { ...two.draft, agents: two.draft.agents.map((agent) => (agent.member.id === 'builder' ? { ...agent, member: { ...agent.member, works: 'crew' as const } } : agent)) };
    expect(branchTag(shared, 'builder')).toBe('crew branch');
  });

  it('counts the lines an agent waits for: not its again line, and the prompt and the ticket as one, as they come together', () => {
    const draft = boardDraft({ ...pair, ...pairGraph });
    expect(joinCount(draft, 'builder')).toBe(1);
    const ticketed = boardDraft({ ...pair, ...pairGraph, inputs: [...pairGraph.inputs!, { id: 'ticket', kind: 'ticket' }], lines: [...pairGraph.lines!, { from: 'ticket', to: 'builder' }] });
    expect(joinCount(ticketed, 'builder')).toBe(1);
    const asked = boardDraft({ ...pair, ...pairGraph, inputs: [...pairGraph.inputs!, { id: 'ok', kind: 'user' }], lines: [...pairGraph.lines!, { from: 'ok', to: 'builder' }] });
    expect(joinCount(asked, 'builder')).toBe(2);
    expect(joinCount(draft, 'review')).toBe(1);
  });

  it('leaves room for the bar at the top and the dock and sentence at the foot, in screen px', () => {
    expect(fitPadding({ inset: 14, bar: 46, foot: 96, margin: 24 })).toEqual({ top: 84, bottom: 134, left: 24, right: 24 });
  });

  it('measures how far the deepest again line and its chip dip below the lowest node, the wider the loop the deeper', () => {
    const draft = boardDraft({ ...pair, ...pairGraph });
    expect(loopSag({ ...draft, lines: draft.lines.filter((line) => line.way !== 'again') })).toBe(0);
    const sag = loopSag(draft);
    expect(sag).toBeGreaterThan(0);
    const wider = { ...draft, gates: draft.gates.map((each) => ({ ...each, place: { ...each.place, x: each.place.x + 400 } })) };
    expect(loopSag(wider)).toBeCloseTo(sag + 0.75 * 0.15 * 400);
  });

  it('needs no more room under a fan of two reviewers than under one, as only the deepest loop counts, and below the graph’s lowest node', () => {
    const one = loopSag(boardDraft({ ...pair, ...pairGraph }));
    const trio: CrewPrefab = { ...pair, members: [...pair.members, member('design', 'reviewer', { name: 'Design' })] };
    const fan = boardDraft({
      ...trio,
      ...pairGraph,
      lines: [...pairGraph.lines!, { from: 'builder', to: 'design', carries: 'handoff' }, { from: 'design', to: 'loop', carries: 'review' }],
    });
    expect(loopSag(fan)).toBeLessThanOrEqual(one);
  });

  it('dips an again line under every node between its ends, clear of each', () => {
    const trio: CrewPrefab = { ...pair, members: [...pair.members, member('design', 'reviewer', { name: 'Design' })] };
    const fan = boardDraft({
      ...trio,
      ...pairGraph,
      lines: [...pairGraph.lines!, { from: 'builder', to: 'design', carries: 'handoff' }, { from: 'design', to: 'loop', carries: 'review' }],
    });
    const again = fan.lines.find((line) => line.way === 'again')!;
    const gate = fan.gates[0]!.place;
    const builder = fan.agents.find((agent) => agent.member.id === 'builder')!.place;
    const design = fan.agents.find((agent) => agent.member.id === 'design')!.place;
    const depth = againDip(fan, again);
    // The curve at the lower reviewer's edge nearest the middle, by the same cubic the board draws.
    const from = { x: gate.x + GATE_SIZE.width / 2, y: gate.y + GATE_SIZE.height };
    const to = { x: builder.x + AGENT_TILE.width / 2, y: builder.y + AGENT_TILE.height };
    const handle = Math.max(from.y, to.y) + depth;
    const lowestAt = (x: number) => {
      let best = -Infinity;
      for (let step = 0; step <= 2000; step++) {
        const t = step / 2000;
        const cx = (1 - t) ** 3 * from.x + 3 * (1 - t) ** 2 * t * from.x + 3 * (1 - t) * t * t * to.x + t ** 3 * to.x;
        const cy = (1 - t) ** 3 * from.y + 3 * (1 - t) * t * handle + t ** 3 * to.y;
        if (Math.abs(cx - x) < 1) best = Math.max(best, cy);
      }
      return best;
    };
    const bottom = design.y + AGENT_TILE.height;
    expect(lowestAt(design.x + AGENT_TILE.width)).toBeGreaterThanOrEqual(bottom + 15);
    expect(lowestAt(design.x)).toBeGreaterThanOrEqual(bottom + 15);
    // With nothing in the way it keeps its depth for its span.
    expect(againDip(boardDraft({ ...pair, ...pairGraph }), again)).toBeCloseTo(56 + 0.15 * Math.abs(to.x - from.x), 0);
  });

  it('gives an End pill room for Ready to merge, in the layout too', () => {
    const draft = boardDraft({ ...pair, ...pairGraph });
    const end = draft.inputs.find(({ input }) => input.kind === 'end')!;
    const loop = draft.gates[0]!.place;
    expect(END_PILL.width).toBeGreaterThan(PROMPT_PILL.width);
    expect(end.place.x).toBeGreaterThan(loop.x);
    expect(graphBounds(draft)!.x + graphBounds(draft)!.width).toBeGreaterThanOrEqual(end.place.x + END_PILL.width);
  });

  it('bounds the graph by its nodes, the gates’ rule chips and the again lines’ dip', () => {
    const draft = boardDraft({ ...pair, ...pairGraph });
    const bounds = graphBounds(draft)!;
    const lowest = Math.max(...draft.agents.map(({ place }) => place.y + AGENT_TILE.height), ...draft.inputs.map(({ place }) => place.y + PROMPT_PILL.height));
    expect(bounds.y + bounds.height).toBeCloseTo(Math.max(lowest, ...draft.gates.map(({ place }) => place.y + GATE_SIZE.height)) + loopSag(draft));
    expect(graphBounds({ ...draft, agents: [], inputs: [], gates: [], lines: [] })).toBeNull();
  });

  it('fits a box whole and centred between the room at each side, zoomed no more than its own size', () => {
    const room = { top: 80, bottom: 120, left: 20, right: 20 };
    const small = fitViewport({ x: 0, y: 0, width: 100, height: 100 }, { width: 1040, height: 800 }, room, { min: 0.1, max: 1 });
    expect(small).toEqual({ x: 20 + (1000 - 100) / 2, y: 80 + (600 - 100) / 2, zoom: 1 });
    const big = fitViewport({ x: 100, y: 50, width: 2000, height: 600 }, { width: 1040, height: 800 }, room, { min: 0.1, max: 1 });
    expect(big.zoom).toBe(0.5);
    expect(big.x + 100 * big.zoom).toBe(20);
    expect(big.y + 50 * big.zoom + 600 * big.zoom).toBe(800 - 120 - (600 - 300) / 2);
    // Too big at fit's floor, it starts at its top left, the rest a pan away; what fits is still centred.
    const wide = fitViewport({ x: 100, y: 50, width: 4000, height: 300 }, { width: 1040, height: 800 }, room, { min: 0.6, max: 1 });
    expect(wide.zoom).toBe(0.6);
    expect(wide.x + 100 * wide.zoom).toBe(20);
    expect(wide.y + 50 * wide.zoom).toBeCloseTo(80 + (600 - 300 * 0.6) / 2);
  });

  it('saves an agent as a prefab of one, with its role’s prompt only for a role of its own', () => {
    const agent = { name: 'Tidy', role: 'custom' as const, roleName: 'designer', harness: 'codex' as const, model: 'gpt-5', effort: 'high' as const };
    expect(agentPrefab(agent, { name: 'Tidy', icon: 'palette', template: 'Draw it' }).members).toEqual([
      { id: 'agent', role: 'designer', name: 'Tidy', harness: 'codex', model: 'gpt-5', effort: 'high', template: 'Draw it', starts: 'prompt', subagents: [] },
    ]);
    expect(agentPrefab({ ...agent, role: 'implementer', roleName: null }, { name: 'B', icon: 'crew', template: 'Draw it' }).members[0]).toMatchObject({ role: 'implementer', template: null });
    // A reviewer saved on its own opens on its board as the file has it, and saves again with nothing to fix.
    const reviewer = agentPrefab({ ...agent, role: 'reviewer', roleName: null }, { name: 'Second look', icon: 'crew', template: null });
    expect(boardPrefab(boardDraft(reviewer)).problems).toEqual([]);
    expect(boardPrefab(boardDraft(reviewer)).prefab.members).toEqual(reviewer.members);
  });
});
