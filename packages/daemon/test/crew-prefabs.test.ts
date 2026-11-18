// A crew prefab's model and its `.crew.json` file: what a prefab holds, what a file may carry, and why one is refused.
import { describe, expect, it } from 'vitest';
import { BUILT_IN_PREFABS, parsePrefab, prefabFile } from '../src/crew-prefabs.ts';
import { checkGraph } from '../src/prefab-checks.ts';
import { graphFromStarts, graphOf, roundLimitOf, unrunnable } from '../src/prefab-graph.ts';
import { normaliseWritesPath } from '../src/prefab-paths.ts';
import { withTicketChat } from '../src/ticket-tiles.ts';

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

/** The same pair as a version 2 file: lines in place of `starts`, and a loop gate in place of `roundLimit`. */
const pairGraph = () => ({
  agentBoardCrewPrefab: 2,
  name: 'Pair',
  icon: 'crew',
  purpose: 'One builds, one reviews',
  members: [
    { id: 'impl', role: 'implementer', harness: 'claude', model: 'opus', effort: 'high' },
    { id: 'review', role: 'reviewer', harness: 'codex' },
  ] as object[],
  inputs: [
    { id: 'prompt', kind: 'prompt' },
    { id: 'end', kind: 'end', as: 'ready' },
  ] as object[],
  gates: [{ id: 'loop', rule: 'done', cap: 3, atCap: 'ask', timeout: null }] as object[],
  lines: [
    { from: 'prompt', to: 'impl' },
    { from: 'impl', to: 'review', carries: 'handoff' },
    { from: 'review', to: 'loop', carries: 'review' },
    { from: 'loop', to: 'impl', way: 'again' },
    { from: 'loop', to: 'end', way: 'done' },
  ] as object[],
});

describe('a crew prefab file', () => {
  it('reads a hand-written file, filling in what it leaves out', () => {
    expect(parsePrefab(JSON.stringify(pairFile()))).toMatchObject({
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

  it('writes a version 2 file that reads back as the same prefab', () => {
    for (const prefab of BUILT_IN_PREFABS) {
      const text = prefabFile(prefab);
      expect(JSON.parse(text).agentBoardCrewPrefab).toBe(2);
      expect(JSON.parse(text)).not.toHaveProperty('roundLimit');
      expect(JSON.parse(text).members[0]).not.toHaveProperty('starts');
      expect(parsePrefab(text)).toEqual(prefab);
      expect(prefabFile(parsePrefab(text))).toBe(text);
    }
  });

  it('ships the eight built-ins, Solo agent with one member, Lead and crew with member tiles, and the tickets as ticket tiles', () => {
    expect(BUILT_IN_PREFABS.map((prefab) => prefab.name)).toEqual([
      'Solo agent',
      'Implementer + reviewer',
      'Implementer + code + design reviewers',
      'Spike + reviewer',
      'Lead and crew',
      'Ticket',
      'Design, build, review',
      'Just the chat',
    ]);
    expect(BUILT_IN_PREFABS[0]!.members).toHaveLength(1);
    expect(BUILT_IN_PREFABS.filter((prefab) => prefab.onBoard === 'tiles').map((prefab) => prefab.name)).toEqual(['Lead and crew']);
    expect(BUILT_IN_PREFABS.filter((prefab) => prefab.onBoard === 'ticket').map((prefab) => [prefab.name, prefab.ticketChat])).toEqual([
      ['Ticket', 'implementer'],
      ['Design, build, review', 'lead'],
      ['Just the chat', 'implementer'],
    ]);
  });

  it('refuses what is not a prefab file, or one from a newer app', () => {
    expect(() => parsePrefab('{nope')).toThrow(/not JSON/);
    expect(refusal({ ...pairFile(), agentBoardCrewPrefab: undefined })).toMatch(/not a crew prefab file/);
    expect(refusal({ ...pairGraph(), agentBoardCrewPrefab: 3 })).toMatch(/newer version of agent-board \(file version 3\)/);
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

describe("a ticket prefab's chat", () => {
  const named = (name: string) => BUILT_IN_PREFABS.find((prefab) => prefab.name === name)!;
  const shape = (prefab: ReturnType<typeof named>) => prefab.members.map((member) => [member.id, member.role, member.starts]);

  it('is written in its file, the implementer when unset, and only a ticket prefab has one', () => {
    const ticket = named('Ticket');
    expect(JSON.parse(prefabFile({ ...ticket, ticketChat: undefined })).ticketChat).toBe('implementer');
    expect(parsePrefab(prefabFile(named('Design, build, review'))).ticketChat).toBe('lead');
    expect(JSON.parse(prefabFile(named('Lead and crew')))).not.toHaveProperty('ticketChat');
    expect(refusal({ ...pairFile(), ticketChat: 'lead' })).toMatch(/only a prefab that starts inside a ticket tile has a ticket chat/);
    expect(() => parsePrefab(prefabFile({ ...ticket, ticketChat: 'boss' as never }))).toThrow(/ticketChat is implementer or lead/);
  });

  it('as the implementer builds: a builder the chat would start goes, and a leading chat builds instead', () => {
    expect(shape(withTicketChat(named('Design, build, review'), 'implementer'))).toEqual([
      ['chat', 'implementer', 'prompt'],
      ['design', 'designer', 'lead'],
      ['review', 'reviewer', 'lead'],
    ]);
    expect(withTicketChat(named('Ticket'), 'implementer')).toEqual(named('Ticket'));
    // Its first builder's place, and only that one: a second builder stays a helper.
    const two = named('Design, build, review');
    const second = { ...two.members.find((each) => each.id === 'build')!, id: 'build-2', name: 'second builder' };
    expect(shape(withTicketChat({ ...two, members: [...two.members, second] }, 'implementer'))).toEqual([
      ['chat', 'implementer', 'prompt'],
      ['design', 'designer', 'lead'],
      ['review', 'reviewer', 'lead'],
      ['build-2', 'implementer', 'lead'],
    ]);
  });

  it('as its own lead leads, and starts a builder before its reviewers when the prefab has none', () => {
    const lead = withTicketChat(named('Ticket'), 'lead');
    expect(lead.ticketChat).toBe('lead');
    expect(shape(lead)).toEqual([
      ['chat', 'orchestrator', 'prompt'],
      ['build', 'implementer', 'lead'],
      ['review', 'reviewer', 'lead'],
    ]);
    expect(withTicketChat(named('Design, build, review'), 'lead')).toEqual(named('Design, build, review'));
    expect(parsePrefab(prefabFile(lead))).toEqual(lead);
  });
});

describe('a version 1 file, converted on read', () => {
  const graph = (file: object) => {
    const { inputs, gates, lines } = parsePrefab(JSON.stringify(file));
    return { inputs: inputs!, gates: gates!, lines: lines! };
  };
  const v1 = (members: object[], more: object = {}) => ({ ...pairFile(), members, ...more });

  it('gives its reviewers at the hand-off one loop gate, capped at the round limit, with no timeout', () => {
    expect(graph({ ...pairFile(), roundLimit: 7 })).toEqual({
      inputs: [
        { id: 'prompt', kind: 'prompt' },
        { id: 'end', kind: 'end', as: 'ready' },
      ],
      gates: [{ id: 'loop', rule: 'done', cap: 7, atCap: 'ask', timeout: null }],
      lines: [
        { from: 'prompt', to: 'impl' },
        { from: 'impl', to: 'review', carries: 'handoff' },
        { from: 'review', to: 'loop', carries: 'review' },
        { from: 'loop', to: 'impl', way: 'again' },
        { from: 'loop', to: 'end', way: 'done' },
      ],
    });
    const two = graph(v1([{ id: 'a', role: 'implementer' }, { id: 'b', role: 'reviewer', starts: 'handoff' }, { id: 'c', role: 'follow-up-reviewer', starts: 'handoff' }]));
    expect(two.gates).toHaveLength(1);
    expect(two.lines.filter((line) => line.to === 'loop').map((line) => line.from)).toEqual(['b', 'c']);
  });

  it('reads its hand-off reviewers as fresh, waiting for all, with no timeout', () => {
    const text = prefabFile(parsePrefab(JSON.stringify(pairFile())));
    expect(JSON.parse(text).members[1]).toMatchObject({ join: 'all', timeout: null, fresh: true, works: 'crew', writes: null });
    expect(JSON.parse(text).members[0]).toMatchObject({ join: 'all', timeout: null, fresh: false, works: 'own', brief: null });
  });

  it('draws a lead line from the prompt member to each it starts, and ends a crew without reviewers at Ready', () => {
    expect(graph(v1([{ id: 'boss', role: 'orchestrator' }, { id: 'do', role: 'implementer', starts: 'lead' }], { onBoard: 'tiles' }))).toEqual({
      inputs: [
        { id: 'prompt', kind: 'prompt' },
        { id: 'end', kind: 'end', as: 'ready' },
      ],
      gates: [],
      lines: [
        { from: 'prompt', to: 'boss' },
        { from: 'boss', to: 'do', lead: true },
        { from: 'boss', to: 'end' },
      ],
    });
    expect(graph(v1([{ id: 'solo', role: null }])).lines).toEqual([
      { from: 'prompt', to: 'solo' },
      { from: 'solo', to: 'end' },
    ]);
  });

  it('gives a ticket prefab a ticket input into its chat', () => {
    const ticket = graph(v1([{ id: 'chat', role: 'implementer' }, { id: 'rev', role: 'reviewer', starts: 'lead' }], { onBoard: 'ticket', ticketChat: 'implementer' }));
    expect(ticket.inputs.map((input) => input.kind)).toEqual(['prompt', 'ticket', 'end']);
    expect(ticket.lines).toContainEqual({ from: 'ticket', to: 'chat' });
    expect(ticket.lines).toContainEqual({ from: 'chat', to: 'rev', lead: true });
  });

  it('picks ids for its inputs and loop gate that no member has', () => {
    const clash = graph(v1([{ id: 'prompt', role: 'implementer' }, { id: 'loop', role: 'reviewer', starts: 'handoff' }, { id: 'end', role: 'reviewer', starts: 'handoff' }]));
    expect(clash.inputs.map((input) => input.id)).toEqual(['prompt-2', 'end-2']);
    expect(clash.gates.map((gate) => gate.id)).toEqual(['loop-2']);
  });

  it('keeps the round limit between 1 and 10, and saves as version 2', () => {
    expect(refusal({ ...pairFile(), roundLimit: 11 })).toMatch(/round limit is a whole number from 1 to 10/);
    const saved = JSON.parse(prefabFile(parsePrefab(JSON.stringify({ ...pairFile(), roundLimit: 4 }))));
    expect(saved.agentBoardCrewPrefab).toBe(2);
    expect(saved.gates[0].cap).toBe(4);
  });

  it('holds no version 2 field, and version 2 no version 1 one', () => {
    expect(refusal({ ...pairFile(), lines: [] })).toMatch(/holds no lines/);
    expect(refusal({ ...pairFile(), members: [{ ...pairFile().members[0], brief: 'Be brief.' }] })).toMatch(/holds no brief/);
    expect(refusal({ ...pairGraph(), roundLimit: 3 })).toMatch(/holds no roundLimit/);
    expect(refusal({ ...pairGraph(), members: [{ ...pairGraph().members[0], starts: 'prompt' }, pairGraph().members[1]] })).toMatch(/holds no starts/);
  });
});

describe('the built-in prefabs', () => {
  it('are each the graph their members’ starts make, so each runs as it did', () => {
    for (const prefab of BUILT_IN_PREFABS) {
      const { inputs, gates, lines } = prefab;
      expect({ name: prefab.name, inputs, gates, lines }).toEqual({ name: prefab.name, ...graphFromStarts(prefab) });
    }
  });

  it('pass the checks a prefab’s graph passes as its file is read', () => {
    for (const prefab of BUILT_IN_PREFABS) expect(() => checkGraph(prefab.members, graphOf(prefab), prefab.onBoard)).not.toThrow();
  });

  it('loop on Implementer + reviewer and the code and design reviewers 3 rounds, and the spike 1', () => {
    const caps = BUILT_IN_PREFABS.filter((prefab) => prefab.gates!.length > 0).map((prefab) => [prefab.name, prefab.gates!.map((gate) => (gate.rule === 'done' ? gate.cap : null))]);
    expect(caps).toEqual([
      ['Implementer + reviewer', [3]],
      ['Implementer + code + design reviewers', [3]],
      ['Spike + reviewer', [1]],
    ]);
  });
});

describe('a version 2 file', () => {
  type File = ReturnType<typeof pairGraph>;
  const edit = (change: (file: File) => void) => {
    const file = pairGraph();
    change(file);
    return file;
  };
  /** A member's fields in a pair whose builder is `fields`. */
  const builder = (fields: object) => edit((file) => (file.members[0] = { ...file.members[0], ...fields }));

  it('reads the starts and round limit the board runs it by from its lines and loop gate', () => {
    const pair = parsePrefab(JSON.stringify(pairGraph()));
    expect(pair.members.map((member) => member.starts)).toEqual(['prompt', 'handoff']);
    expect(pair.roundLimit).toBe(3);
    expect(parsePrefab(JSON.stringify(edit((file) => (file.gates[0] = { id: 'loop', rule: 'done', cap: null }))))).toMatchObject({ roundLimit: 10 });
    expect(parsePrefab(JSON.stringify(edit((file) => (file.gates[0] = { id: 'loop', rule: 'rounds', rounds: 2 }))))).toMatchObject({ roundLimit: 2 });
  });

  it('gives a new loop gate a cap of 5, asking there, and a 30 minute timeout', () => {
    expect(parsePrefab(JSON.stringify(edit((file) => (file.gates[0] = { id: 'loop', rule: 'done' })))).gates).toEqual([
      { id: 'loop', rule: 'done', cap: 5, atCap: 'ask', timeout: 30 },
    ]);
    expect(parsePrefab(JSON.stringify(edit((file) => (file.gates[0] = { id: 'loop', rule: 'rounds', rounds: 4 })))).gates).toEqual([
      { id: 'loop', rule: 'rounds', rounds: 4, timeout: 30 },
    ]);
  });

  it('checks a loop gate’s cap, rounds and timeout', () => {
    const gate = (fields: object) => edit((file) => (file.gates[0] = { id: 'loop', rule: 'done', ...fields }));
    expect(parsePrefab(JSON.stringify(gate({ cap: 40, atCap: 'on', timeout: 480 }))).gates![0]).toMatchObject({ cap: 40, atCap: 'on', timeout: 480 });
    expect(refusal(gate({ cap: 0 }))).toMatch(/cap is a whole number from 1, or null for none/);
    expect(refusal(gate({ cap: 1.5 }))).toMatch(/cap is a whole number/);
    expect(refusal(gate({ timeout: 4 }))).toMatch(/timeout is a whole number from 5 to 480, or null/);
    expect(refusal(gate({ timeout: 481 }))).toMatch(/timeout is a whole number from 5 to 480/);
    expect(refusal(gate({ atCap: 'stop' }))).toMatch(/does at its cap is ask or on/);
    expect(refusal(gate({ rule: 'rounds', rounds: 21 }))).toMatch(/rounds is a whole number from 1 to 20/);
    expect(refusal(gate({ rule: 'rounds', rounds: 0 }))).toMatch(/rounds is a whole number from 1 to 20/);
    expect(refusal(gate({ rule: 'rounds', rounds: 2, cap: 3 }))).toMatch(/loop gate loop holds no cap/);
    expect(refusal(gate({ rule: 'maybe' }))).toMatch(/rule is done or rounds/);
  });

  it('keeps every id unique across members, inputs and loop gates', () => {
    expect(refusal(edit((file) => file.inputs.push({ id: 'impl', kind: 'user' })))).toMatch(/two of the prefab's members, inputs and loop gates are impl/);
    expect(refusal(edit((file) => file.gates.push({ id: 'end', rule: 'done' })))).toMatch(/are end/);
  });

  it('refuses a line whose ends don’t exist, or that a line can’t join', () => {
    const line = (fields: object) => edit((file) => file.lines.push(fields));
    expect(refusal(line({ from: 'impl', to: 'nobody' }))).toMatch(/impl → nobody: the prefab has no nobody/);
    expect(refusal(line({ from: 'prompt', to: 'loop' }))).toMatch(/every line into a loop gate comes from a member/);
    expect(refusal(line({ from: 'impl', to: 'end', way: 'done' }))).toMatch(/only a line out of a loop gate has a way/);
    expect(refusal(edit((file) => (file.lines[3] = { from: 'loop', to: 'impl' })))).toMatch(/leaves a loop gate, so it is the gate's again or done way/);
    expect(refusal(line({ from: 'end', to: 'impl' }))).toMatch(/end is an end, which no line leaves/);
    expect(refusal(line({ from: 'review', to: 'prompt' }))).toMatch(/prompt is where work comes from/);
    expect(refusal(line({ from: 'impl', to: 'impl' }))).toMatch(/goes nowhere/);
    expect(refusal(line({ from: 'prompt', to: 'impl' }))).toMatch(/two lines go prompt → impl/);
    expect(refusal(line({ from: 'impl', to: 'end', lead: false }))).toMatch(/lead is true, or left out/);
    expect(refusal(line({ from: 'impl', to: 'end', colour: 'red' }))).toMatch(/line 6 holds no colour/);
  });

  it('gives a loop gate one again line, closing a loop back through its deciders, and a done line', () => {
    expect(refusal(edit((file) => file.lines.splice(3, 1)))).toMatch(/loop gate loop has one again line, back to the loop's head; it has 0/);
    expect(refusal(edit((file) => file.lines.push({ from: 'loop', to: 'review', way: 'again' })))).toMatch(/it has 2/);
    expect(refusal(edit((file) => file.lines.splice(4, 1)))).toMatch(/loop gate loop has at least one done line/);
    expect(refusal(edit((file) => file.lines.splice(3, 2, { from: 'loop', to: 'end', way: 'again' }, { from: 'loop', to: 'review', way: 'done' })))).toMatch(/again line goes back to a member/);
    // Again goes back to the reviewer, which isn't after itself: the builder is outside the loop.
    const outside = edit((file) => {
      file.members.push({ id: 'second', role: 'reviewer' });
      file.lines.push({ from: 'impl', to: 'second', carries: 'handoff' }, { from: 'second', to: 'loop', carries: 'review' });
      file.lines[3] = { from: 'loop', to: 'review', way: 'again' };
    });
    expect(refusal(outside)).toMatch(/again line goes to review, but second isn't after it/);
  });

  it('refuses a done line back into its own loop, which no work would ever leave', () => {
    const done = (to: string, change: (file: File) => void = () => {}) =>
      edit((file) => {
        change(file);
        file.lines.push({ from: 'loop', to, way: 'done' });
      });
    // Into a decider, by its tile's name if it has one, else its id; the crew's one gate is "the loop gate".
    expect(refusal(done('review'))).toMatch(/^the loop gate's done line goes back into review, inside its own loop, so approved work would go round forever/);
    expect(refusal(done('review', (file) => (file.members[1] = { ...file.members[1], name: 'Review' })))).toMatch(/the loop gate's done line goes back into Review/);
    // Into the loop's head, beside the again line already there.
    expect(refusal(done('impl'))).toMatch(/the loop gate's done line goes back into impl, the loop's head, so approved work would go round forever/);
    expect(refusal(edit((file) => file.lines.push({ from: 'loop', to: 'end', way: 'done' })))).toMatch(/two lines go loop → end/);
    // Whichever of the two the file lists first.
    expect(refusal(edit((file) => file.lines.splice(3, 0, { from: 'loop', to: 'impl', way: 'done' })))).toMatch(/done line goes back into impl, the loop's head/);
    // Into a member between the head and a decider.
    const middle = (file: File) => {
      file.members.push({ id: 'docs', role: 'reviewer' });
      file.lines.splice(1, 2, { from: 'impl', to: 'docs', carries: 'handoff' }, { from: 'docs', to: 'review', carries: 'handoff' }, { from: 'review', to: 'loop', carries: 'review' });
    };
    expect(refusal(done('docs', middle))).toMatch(/done line goes back into docs/);
  });

  it('refuses a done line that leads back into its loop through members after it, even beside a way out', () => {
    /** The pair, its done line to a docs writer that goes on along `lines`. */
    const after = (lines: object[], change: (file: File) => void = () => {}) =>
      edit((file) => {
        file.members.push({ id: 'docs', role: 'reviewer', name: 'Docs' });
        file.lines[4] = { from: 'loop', to: 'docs', way: 'done' };
        file.lines.push(...lines);
        change(file);
      });
    const message = /the loop gate's done line goes to Docs, which leads back into (review|impl), so approved work would go round forever/;
    expect(refusal(after([{ from: 'docs', to: 'review' }]))).toMatch(message);
    expect(refusal(after([{ from: 'docs', to: 'impl' }]))).toMatch(message);
    // A second done line to Ready, or a crew a queue runs, which needs no end: the docs writer still goes round.
    expect(refusal(after([{ from: 'docs', to: 'impl' }], (file) => file.lines.push({ from: 'loop', to: 'end', way: 'done' })))).toMatch(message);
    const queued = after([{ from: 'docs', to: 'review' }], (file) => {
      file.inputs.push({ id: 'work', kind: 'queue', queue: 'item:abcd' });
      file.lines.push({ from: 'work', to: 'impl' });
    });
    const members = queued.members.map((member) => ({ name: null, ...member })) as never;
    expect(() => checkGraph(members, { inputs: queued.inputs, gates: queued.gates, lines: queued.lines } as never, 'card')).toThrow(message);
  });

  describe('a done line in a crew of two loop gates', () => {
    const crew = [
      { id: 'impl', role: 'implementer', name: null },
      { id: 'review', role: 'reviewer', name: 'Review' },
      { id: 'b', role: 'reviewer', name: 'Docs' },
      { id: 'r2', role: 'reviewer', name: 'Docs review' },
    ];
    const inputs = [
      { id: 'prompt', kind: 'prompt' },
      { id: 'end', kind: 'end', as: 'ready' },
    ];
    const gates = [
      { id: 'g1', rule: 'done', cap: 3, atCap: 'ask', timeout: null },
      { id: 'g2', rule: 'done', cap: 3, atCap: 'ask', timeout: null },
    ];
    const pair = [
      { from: 'prompt', to: 'impl' },
      { from: 'impl', to: 'review', carries: 'handoff' },
      { from: 'review', to: 'g1', carries: 'review' },
      { from: 'g1', to: 'impl', way: 'again' },
    ];
    /** The pair and its gate g1, then `lines`, with the members those lines join. */
    const check = (lines: { from: string; to: string }[]) => () => {
      const all = [...pair, ...lines];
      const members = crew.filter((member) => all.some((line) => line.to === member.id)) as never;
      checkGraph(members, { inputs, gates, lines: all } as never, 'card');
    };

    it('passes gates in series, a gate inside another’s loop, and a done line into a later gate’s loop', () => {
      const series = [{ from: 'g1', to: 'b', way: 'done' }, { from: 'b', to: 'r2' }, { from: 'r2', to: 'g2' }, { from: 'g2', to: 'b', way: 'again' }, { from: 'g2', to: 'end', way: 'done' }];
      expect(check(series)).not.toThrow();
      const nested = [{ from: 'g1', to: 'r2', way: 'done' }, { from: 'r2', to: 'g2' }, { from: 'g2', to: 'impl', way: 'again' }, { from: 'g2', to: 'end', way: 'done' }];
      expect(check(nested)).not.toThrow();
      // An inner gate inside the first loop, its done line feeding the first loop's decider: work leaves by g1's done.
      const inner = [{ from: 'impl', to: 'r2' }, { from: 'r2', to: 'g2' }, { from: 'g2', to: 'impl', way: 'again' }, { from: 'g2', to: 'review', way: 'done' }, { from: 'g1', to: 'end', way: 'done' }];
      expect(check(inner)).not.toThrow();
      const later = [{ from: 'g1', to: 'r2', way: 'done' }, { from: 'b', to: 'r2' }, { from: 'impl', to: 'b' }, { from: 'r2', to: 'g2' }, { from: 'g2', to: 'b', way: 'again' }, { from: 'g2', to: 'end', way: 'done' }];
      expect(check(later)).not.toThrow();
    });

    it('refuses a done line that comes back round through a later gate’s done line, naming the gate by its deciders', () => {
      const back = [{ from: 'g1', to: 'b', way: 'done' }, { from: 'b', to: 'r2' }, { from: 'r2', to: 'g2' }, { from: 'g2', to: 'b', way: 'again' }, { from: 'g2', to: 'impl', way: 'done' }];
      expect(check(back)).toThrow(/^the loop gate after Review's done line goes to Docs, which leads back into impl,/);
    });
  });

  it('keeps a done line out of the loop: to an end, or to a member after it that goes on to one', () => {
    expect(() => parsePrefab(JSON.stringify(pairGraph()))).not.toThrow();
    const after = edit((file) => {
      file.members.push({ id: 'docs', role: 'reviewer' });
      file.lines[4] = { from: 'loop', to: 'docs', way: 'done' };
      file.lines.push({ from: 'docs', to: 'end' });
    });
    expect(() => parsePrefab(JSON.stringify(after))).not.toThrow();
  });

  it('reaches every member from an input, and an end unless a clock or a queue runs it', () => {
    expect(refusal(edit((file) => file.members.push({ id: 'lost', role: 'reviewer' })))).toMatch(/lost is reached from no input/);
    const endless = edit((file) => {
      file.members.push({ id: 'docs', role: 'reviewer' });
      file.lines[4] = { from: 'loop', to: 'docs', way: 'done' };
    });
    expect(refusal(endless)).toMatch(/no line reaches an end/);
    const solo = (inputs: object[], lines: object[]) => ({ ...pairGraph(), members: [{ id: 'a', role: 'implementer' }], gates: [], inputs, lines });
    expect(refusal(solo([{ id: 'prompt', kind: 'prompt' }], [{ from: 'prompt', to: 'a' }]))).toMatch(/no line reaches an end/);
    const clocked = solo(
      [
        { id: 'prompt', kind: 'prompt' },
        { id: 'tick', kind: 'clock', schedule: '0 8 * * 1-5', line: 'Go through the queue.' },
      ],
      [
        { from: 'prompt', to: 'a' },
        { from: 'tick', to: 'a' },
      ],
    );
    expect(parsePrefab(JSON.stringify(clocked)).inputs).toContainEqual({ id: 'tick', kind: 'clock', schedule: '0 8 * * 1-5', line: 'Go through the queue.' });
    const queued = solo([{ id: 'prompt', kind: 'prompt' }, { id: 'jobs', kind: 'queue' }], [{ from: 'prompt', to: 'a' }]);
    expect(parsePrefab(JSON.stringify(queued)).members[0]!.starts).toBe('prompt');
  });

  it('checks a clock’s schedule and line, and an input’s fields', () => {
    const clock = (fields: object) => edit((file) => file.inputs.push({ id: 'tick', kind: 'clock', schedule: '0 8 * * *', line: 'Go.', ...fields }));
    expect(refusal(clock({ schedule: 'every morning' }))).toMatch(/input tick's schedule: /);
    expect(refusal(clock({ line: '  ' }))).toMatch(/input tick's line is empty/);
    expect(refusal(clock({ line: '/clear and go' }))).toMatch(/input tick's line may not start an agent/);
    expect(refusal(clock({ line: 'x'.repeat(50_001) }))).toMatch(/at most 50000 characters/);
    expect(refusal(edit((file) => file.inputs.push({ id: 'ok', kind: 'user', line: 'Hi' })))).toMatch(/input ok holds no line/);
    expect(refusal(edit((file) => file.inputs.push({ id: 'x', kind: 'webhook' })))).toMatch(/kind is prompt, user, queue, ticket, clock or end/);
    expect(refusal(edit((file) => (file.inputs[1] = { id: 'end', kind: 'end', as: 'merged' })))).toMatch(/as is ready or done/);
    expect(refusal(edit((file) => file.inputs.push({ id: 'Bad Id', kind: 'user' })))).toMatch(/id is lowercase letters, digits and dashes/);
  });

  it('lets only an orchestrator or a ticket’s chat draw a lead line', () => {
    const led = (role: string, onBoard: string) => ({
      ...pairGraph(),
      onBoard,
      ...(onBoard === 'ticket' ? { ticketChat: 'implementer' } : {}),
      members: [{ id: 'chat', role }, { id: 'help', role: 'reviewer' }],
      gates: [],
      lines: [
        { from: 'prompt', to: 'chat' },
        { from: 'chat', to: 'help', lead: true },
        { from: 'chat', to: 'end' },
      ],
    });
    expect(parsePrefab(JSON.stringify(led('orchestrator', 'tiles'))).members.map((member) => member.starts)).toEqual(['prompt', 'lead']);
    expect(parsePrefab(JSON.stringify(led('implementer', 'ticket'))).members.map((member) => member.starts)).toEqual(['prompt', 'lead']);
    expect(refusal(led('implementer', 'card'))).toMatch(/chat → help is a lead line, so chat is an orchestrator or the ticket's chat/);
  });

  it('defaults each member’s branch by its role: a maker’s own, everyone else’s the crew’s', () => {
    const pair = JSON.parse(prefabFile(parsePrefab(JSON.stringify(pairGraph()))));
    expect(pair.members.map((member: { works: string }) => member.works)).toEqual(['own', 'crew']);
    expect(parsePrefab(JSON.stringify(builder({ works: 'own' }))).members[0]).not.toHaveProperty('works');
    expect(parsePrefab(JSON.stringify(builder({ works: 'crew' }))).members[0]).toMatchObject({ works: 'crew' });
    expect(refusal(builder({ role: 'designer', works: 'own' }))).toMatch(/impl works on a branch of its own, but only a maker/);
    expect(refusal(builder({ works: 'mine' }))).toMatch(/works on is own or crew/);
  });

  /** A designer and `second` beside it on the crew branch, from the prompt, both to Ready. */
  const sharing = (designer: object, second: object) => ({
    ...pairGraph(),
    members: [
      { id: 'design', role: 'designer', ...designer },
      { id: 'plan', role: 'planner', ...second },
    ],
    gates: [],
    lines: [
      { from: 'prompt', to: 'design' },
      { from: 'design', to: 'plan' },
      { from: 'plan', to: 'end' },
    ],
  });

  it('puts a maker on the crew branch only when no other member writes there', () => {
    const file = edit((each) => {
      each.members = [{ id: 'impl', role: 'implementer', works: 'crew' }, { id: 'notes', role: 'designer' }];
      each.gates = [];
      each.lines = [
        { from: 'prompt', to: 'impl' },
        { from: 'impl', to: 'notes' },
        { from: 'notes', to: 'end' },
      ];
    });
    expect(refusal(file)).toMatch(/impl works on the crew branch, but notes writes there too/);
    // A reviewer writes only its review, so a maker beside one is the crew branch's one writer.
    expect(parsePrefab(JSON.stringify(builder({ works: 'crew' }))).members[0]!.works).toBe('crew');
  });

  it('gives each non-maker in a shared crew worktree paths of its own, normalised, that overlap no one else’s', () => {
    // Each path is normalised; the file then passes every graph check, and stops only at what the board runs today.
    expect(normaliseWritesPath('./docs//specs/')).toEqual({ path: 'docs/specs/' });
    expect(normaliseWritesPath('Cafe\u0301/a.md')).toEqual({ path: 'Caf\u00e9/a.md' });
    expect(unrunnable(parsePrefab(JSON.stringify(sharing({ writes: ['./docs//specs/', 'docs/specs/'] }, { writes: ['docs/plans/'] }))))).toBeNull();
    const members = [
      { id: 'design', role: 'designer', writes: ['docs/specs/'] },
      { id: 'plan', role: 'planner', writes: ['docs/plans/'] },
    ] as unknown as Parameters<typeof checkGraph>[0];
    const { inputs, lines } = sharing({}, {});
    expect(() => checkGraph(members, { inputs, gates: [], lines } as never, 'card')).not.toThrow();
    expect(refusal(sharing({ writes: ['docs/'] }, { writes: ['Docs/plans/'] }))).toMatch(/design's docs\/ and plan's Docs\/plans\/ overlap/);
    expect(refusal(sharing({ writes: ['docs/a.md'] }, { writes: ['docs/a.md/'] }))).toMatch(/overlap/);
    expect(refusal(sharing({ writes: ['Café/'] }, { writes: ['café/'] }))).toMatch(/overlap/);
    expect(refusal(sharing({ writes: ['docs/specs/'] }, {}))).toMatch(/plan shares the crew worktree with design, so it writes to paths of its own/);
    // No paths is as none given (as a maker's `writes: []` in a hand-written file).
    expect(refusal(sharing({ writes: [] }, { writes: ['b/'] }))).toMatch(/design shares the crew worktree with plan, so it writes to paths of its own/);
    expect(parsePrefab(JSON.stringify(builder({ writes: [] }))).members[0]).not.toHaveProperty('writes');
    expect(refusal(sharing({ writes: ['../up/'] }, { writes: ['b/'] }))).toMatch(/stays inside the repo: no \.\./);
    expect(refusal(sharing({ writes: ['/etc/'] }, { writes: ['b/'] }))).toMatch(/not absolute/);
    expect(refusal(sharing({ writes: ['a\\b'] }, { writes: ['b/'] }))).toMatch(/uses \/, not \\/);
    expect(refusal(sharing({ writes: ['./'] }, { writes: ['b/'] }))).toMatch(/the repo's root is everyone's/);
    expect(refusal(builder({ writes: ['src/'] }))).toMatch(/impl has paths of its own, but shares no crew worktree/);
    expect(refusal(edit((file) => (file.members[1] = { ...file.members[1], writes: ['docs/'] })))).toMatch(/review has paths of its own/);
  });

  it('carries a member brief of any length a template may have, checked as a template is', () => {
    const long = 'Small commits; tests first. '.repeat(1500);
    expect(parsePrefab(JSON.stringify(builder({ brief: long }))).members[0]!.brief).toBe(long);
    expect(refusal(builder({ brief: 'x'.repeat(50_001) }))).toMatch(/brief is at most 50000 characters/);
    expect(refusal(builder({ brief: '/clear and go' }))).toMatch(/member impl's brief may not start an agent/);
    expect(refusal(builder({ brief: ' ' }))).toMatch(/brief is empty/);
    expect(refusal(builder({ brief: 3 }))).toMatch(/brief must be text/);
  });

  it('checks how a member takes its inputs, its timeout and whether it is fresh each round', () => {
    expect(parsePrefab(JSON.stringify(builder({ join: 'all', timeout: 30, fresh: true }))).members[0]).toMatchObject({ timeout: 30, fresh: true });
    expect(parsePrefab(JSON.stringify(builder({ join: 'each' }))).members[0]).toMatchObject({ join: 'each' });
    expect(refusal(builder({ join: 'each', timeout: 30 }))).toMatch(/takes each input as it comes, so it waits for none/);
    expect(refusal(builder({ timeout: 1 }))).toMatch(/timeout is a whole number from 5 to 480/);
    expect(refusal(builder({ join: 'some' }))).toMatch(/takes its inputs is all or each/);
    expect(refusal(builder({ fresh: 'yes' }))).toMatch(/fresh is true or false/);
    const file = JSON.parse(prefabFile(parsePrefab(JSON.stringify(builder({ join: 'each', fresh: true, brief: 'Be brief.' })))));
    expect(file.members[0]).toMatchObject({ join: 'each', timeout: null, fresh: true, brief: 'Be brief.' });
  });

  it('still starts one member on the prompt, as the board runs a crew today', () => {
    const two = edit((file) => {
      file.members.push({ id: 'other', role: 'implementer' });
      file.lines.push({ from: 'prompt', to: 'other' }, { from: 'other', to: 'end' });
    });
    expect(refusal(two)).toMatch(/one member on a line from Your prompt, its builder or its lead, for now; this one has 2/);
  });
});

describe('what the board runs of a graph today', () => {
  const read = (file: object) => parsePrefab(JSON.stringify(file));
  const edited = (change: (file: ReturnType<typeof pairGraph>) => void) => {
    const file = pairGraph();
    change(file);
    return read(file);
  };

  it('starts every built-in, and a version 2 file of the same shape with ids of its own', () => {
    for (const prefab of BUILT_IN_PREFABS) expect(unrunnable(prefab)).toBeNull();
    expect(unrunnable(read(pairGraph()))).toBeNull();
    const renamed = edited((file) => {
      file.inputs = [{ id: 'ask', kind: 'prompt' }, { id: 'ship', kind: 'end', as: 'ready' }];
      file.gates = [{ id: 'rounds', rule: 'done', cap: 4, atCap: 'ask', timeout: null }];
      file.lines = [
        { from: 'ask', to: 'impl' },
        { from: 'impl', to: 'review', carries: 'handoff' },
        { from: 'review', to: 'rounds', carries: 'review' },
        { from: 'rounds', to: 'impl', way: 'again' },
        { from: 'rounds', to: 'ship', way: 'done' },
      ];
    });
    expect(unrunnable(renamed)).toBeNull();
  });

  it('runs any graph of members, Your OKs, loop gates and ends, its members with briefs, joins, timeouts and fresh of their own', () => {
    const gate = (fields: object) => edited((file) => (file.gates = [{ ...(file.gates[0] as object), ...fields }]));
    for (const fields of [{ atCap: 'on' }, { timeout: 60 }, { cap: null }, { cap: 11 }]) expect(unrunnable(gate(fields))).toBeNull();
    expect(unrunnable(edited((file) => (file.gates = [{ id: 'loop', rule: 'rounds', rounds: 2, timeout: null }])))).toBeNull();
    expect(unrunnable(edited((file) => (file.members[1] = { ...file.members[1], fresh: false })))).toBeNull();
    expect(unrunnable(edited((file) => (file.members[0] = { ...file.members[0], brief: 'Be brief.' })))).toBeNull();
    expect(unrunnable(edited((file) => (file.members[1] = { ...file.members[1], join: 'each' })))).toBeNull();
    expect(unrunnable(edited((file) => ((file.inputs[1] as { as: string }).as = 'done')))).toBeNull();
    const ok = edited((file) => {
      file.inputs.push({ id: 'ok', kind: 'user' });
      file.lines = file.lines.map((line) => ((line as { to: string }).to === 'end' ? { ...line, to: 'ok' } : line));
      file.lines.push({ from: 'ok', to: 'end' });
    });
    expect(unrunnable(ok)).toBeNull();
  });

  it('refuses a member working where it says, and work from a queue, a clock or a ticket past the first member', () => {
    expect(unrunnable(edited((file) => (file.members[0] = { ...file.members[0], works: 'crew' })))).toMatch(/impl has a works of its own, which this version of agent-board does not run yet/);
    const fed = (kind: 'queue' | 'clock' | 'ticket', to: string) =>
      edited((file) => {
        file.inputs.push((kind === 'clock' ? { id: 'in', kind, schedule: '0 8 * * *', line: 'Go.' } : { id: 'in', kind }) as never);
        file.lines.push({ from: 'in', to });
      });
    expect(unrunnable(fed('queue', 'impl'))).toMatch(/work comes in from a queue \(in\)/);
    expect(unrunnable(fed('clock', 'impl'))).toMatch(/work comes in from a clock \(in\)/);
    expect(unrunnable(fed('ticket', 'review'))).toMatch(/a ticket to a member the prompt does not start/);
    expect(unrunnable(fed('ticket', 'impl'))).toBeNull();
  });

  it('runs two makers on branches of their own, and beside a non-maker sharing the crew worktree on paths of its own', () => {
    const makers = edited((file) => {
      file.members.push({ id: 'ui', role: 'implementer', harness: 'claude' });
      file.lines.push({ from: 'impl', to: 'ui', carries: 'handoff' }, { from: 'ui', to: 'end' });
    });
    expect(unrunnable(makers)).toBeNull();
    const beside = (writes: object) => (file: ReturnType<typeof pairGraph>) => {
      file.members.push({ id: 'ui', role: 'implementer', harness: 'claude' }, { id: 'design', role: 'designer', harness: 'claude', ...writes });
      file.lines.push({ from: 'impl', to: 'ui', carries: 'handoff' }, { from: 'ui', to: 'end' }, { from: 'impl', to: 'design', carries: 'handoff' }, { from: 'design', to: 'end' });
    };
    expect(unrunnable(edited(beside({ writes: ['docs/outline/'] })))).toBeNull();
    // Beside two makers, a lone non-maker on the crew branch shares the crew worktree with their merges: it needs paths.
    expect(() => edited(beside({}))).toThrow(/design shares the crew worktree with the makers' merges, so it writes to paths of its own/);
  });

  it('reads a cap past the round limit range as its top', () => {
    expect(roundLimitOf([{ id: 'loop', rule: 'done', cap: 1e6, atCap: 'ask', timeout: null }])).toBe(10);
    expect(roundLimitOf([{ id: 'loop', rule: 'rounds', rounds: 20, timeout: null }])).toBe(10);
  });
});

describe("a prefab's graph as it is saved", () => {
  const pair = () => parsePrefab(JSON.stringify(pairGraph()));

  it('keeps a graph whose members still start as its lines say', () => {
    const prefab = { ...pair(), gates: [{ id: 'loop', rule: 'done' as const, cap: 3, atCap: 'ask' as const, timeout: 45 }] };
    expect(graphOf(prefab).gates).toEqual(prefab.gates);
  });

  it('moves a changed round limit onto its first loop gate, keeping the rest of it', () => {
    const prefab = { ...pair(), gates: [{ id: 'loop', rule: 'done' as const, cap: 3, atCap: 'ask' as const, timeout: 45 }] };
    expect(graphOf({ ...prefab, roundLimit: 6 }).gates).toEqual([{ id: 'loop', rule: 'done', cap: 6, atCap: 'ask', timeout: 45 }]);
    const rounds = { ...prefab, gates: [{ id: 'loop', rule: 'rounds' as const, rounds: 3, timeout: null }] };
    expect(graphOf({ ...rounds, roundLimit: 2 }).gates).toEqual([{ id: 'loop', rule: 'rounds', rounds: 2, timeout: null }]);
  });

  it('rebuilds the graph from when its members start when a member is added or removed', () => {
    const prefab = pair();
    const added = { ...prefab, members: [...prefab.members, { ...prefab.members[1]!, id: 'second' }] };
    expect(graphOf(added)).toEqual(graphFromStarts(added));
    expect(graphOf(added).lines).toContainEqual({ from: 'second', to: 'loop', carries: 'review' });
    const removed = { ...prefab, members: [prefab.members[0]!] };
    expect(graphOf(removed)).toEqual(graphFromStarts(removed));
    expect(graphOf(removed).gates).toEqual([]);
  });
});

describe("a lead's round limit, on its lead", () => {
  const named = (name: string) => BUILT_IN_PREFABS.find((prefab) => prefab.name === name)!;
  const file = (name: string, roundLimit = 3) => JSON.parse(prefabFile({ ...named(name), name: 'Mine', roundLimit })) as { members: Record<string, unknown>[]; gates: object[] };
  const led = (fields: object) => ({
    ...pairFile(),
    members: [
      { id: 'lead', role: 'orchestrator', starts: 'prompt' },
      { id: 'impl', role: 'implementer', starts: 'lead' },
    ],
    ...fields,
  });

  it('converts a version 1 lead crew’s round limit to its lead’s rounds, and keeps it through a save', () => {
    const v1 = parsePrefab(JSON.stringify(led({ roundLimit: 6 })));
    expect(v1.roundLimit).toBe(6);
    const saved = JSON.parse(prefabFile(v1));
    expect(saved.members.map((member: { id: string; rounds?: number }) => [member.id, member.rounds])).toEqual([
      ['lead', 6],
      ['impl', undefined],
    ]);
    expect(parsePrefab(prefabFile(parsePrefab(prefabFile(v1)))).roundLimit).toBe(6);
  });

  it('writes the limit on the lead of a built-in lead crew and a ticket’s chat, and on no one in a crew with a loop gate', () => {
    expect(file('Lead and crew', 5).members[0]).toMatchObject({ role: 'orchestrator', rounds: 5 });
    expect(parsePrefab(JSON.stringify(file('Lead and crew', 5))).roundLimit).toBe(5);
    const ticket = BUILT_IN_PREFABS.find((prefab) => prefab.onBoard === 'ticket')!;
    const chat = JSON.parse(prefabFile({ ...ticket, roundLimit: 7 }));
    expect(chat.members.filter((member: { rounds?: number }) => member.rounds !== undefined)).toHaveLength(1);
    expect(parsePrefab(JSON.stringify(chat)).roundLimit).toBe(7);
    expect(file('Implementer + reviewer').members.some((member) => 'rounds' in member)).toBe(false);
    // A lead crew's file with no rounds runs 3.
    const bare = file('Lead and crew', 5);
    delete bare.members[0]!.rounds;
    expect(parsePrefab(JSON.stringify(bare)).roundLimit).toBe(3);
  });

  it('refuses rounds on any member but the lead, out of range, or beside a loop gate', () => {
    const lead = file('Lead and crew');
    lead.members[1] = { ...lead.members[1], rounds: 2 };
    expect(refusal(lead)).toMatch(/has rounds, which only a crew's lead has/);
    const range = file('Lead and crew');
    range.members[0] = { ...range.members[0], rounds: 11 };
    expect(refusal(range)).toMatch(/lead's rounds is a whole number from 1 to 10/);
    range.members[0] = { ...range.members[0], rounds: 0 };
    expect(refusal(range)).toMatch(/rounds is a whole number from 1 to 10/);
    const gated = file('Implementer + reviewer');
    gated.members[0] = { ...gated.members[0], rounds: 4 };
    expect(refusal(gated)).toMatch(/has rounds, but this crew's loop gates hold its limits/);
  });
});
