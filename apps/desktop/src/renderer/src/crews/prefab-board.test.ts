import { describe, expect, it } from 'vitest';
import { PROMPT_PLACE, type CrewPrefab, type PrefabMember } from '@agent-board/daemon/protocol';
import { addAgent, agentPrefab, boardDraft, boardPrefab, boardSentence, copyName, libraryBoard, lineMeaning, newPrefab, pasted, startWord, withLine, withoutAgents, type BoardDraft } from './prefab-board';

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

const text = (draft: BoardDraft) =>
  boardSentence(draft)
    .map((words) => words.text)
    .join('');

describe('a prefab as its mini board', () => {
  it('draws a line for each start: the prompt to its first agent, and that agent to each it starts', () => {
    const draft = boardDraft(pair);
    expect(draft.lines).toEqual([
      { from: PROMPT_PLACE, to: 'builder' },
      { from: 'builder', to: 'review' },
    ]);
    expect(draft.lines.map((line) => lineMeaning(draft, line))).toEqual(['prompt', 'handoff']);
    expect(draft.agents.map((agent) => startWord(draft, agent.member.id))).toEqual([{ text: 'Starts on your prompt' }, { text: 'At Builder’s hand-off' }]);
  });

  it('puts each agent where it was saved, and lays out one saved without from its lines, left to right', () => {
    const saved = boardDraft({ ...pair, places: { [PROMPT_PLACE]: { x: -300, y: 0 }, builder: { x: 10, y: 20 }, review: { x: 400, y: 20 } } });
    expect(saved.prompt).toEqual({ x: -300, y: 0 });
    expect(saved.agents.map((agent) => agent.place)).toEqual([
      { x: 10, y: 20 },
      { x: 400, y: 20 },
    ]);
    const laid = boardDraft(pair);
    const [builder, review] = laid.agents.map((agent) => agent.place);
    expect(laid.prompt.x).toBeLessThan(builder!.x);
    expect(builder!.x).toBeLessThan(review!.x);
  });

  it('gives an agent one line in: a new one replaces the old, and the prompt has one line out', () => {
    const three = addAgent(boardDraft(pair), 'reviewer', { x: 0, y: 0 });
    const added = three.draft.agents.at(-1)!.member.id;
    expect(startWord(three.draft, added)).toEqual({ text: 'No line in yet', warn: true });
    const joined = withLine(three.draft, 'review', added);
    const again = withLine(joined, 'builder', added);
    expect(again.lines.filter((line) => line.to === added)).toEqual([{ from: 'builder', to: added }]);
    const moved = withLine(again, PROMPT_PLACE, 'review');
    expect(moved.lines.filter((line) => line.from === PROMPT_PLACE)).toEqual([{ from: PROMPT_PLACE, to: 'review' }]);
    // Nothing goes into the prompt, nor from an agent to itself.
    expect(withLine(again, 'builder', PROMPT_PLACE)).toBe(again);
    expect(withLine(again, 'builder', 'builder')).toBe(again);
  });

  it('saves the lines as starts, and lists what the data can’t hold as problems, never refusing a line', () => {
    expect(boardPrefab(boardDraft(pair))).toEqual({ prefab: pair, problems: [] });

    const loose = addAgent(boardDraft({ ...pair, name: ' ' }), 'builder', { x: 0, y: 0 });
    const extra = loose.draft.agents.at(-1)!.member;
    const drawn = withLine(withLine(loose.draft, 'builder', extra.id), PROMPT_PLACE, 'review');
    expect(boardPrefab(drawn).problems).toEqual([
      'Name the prefab.',
      'Builder has no line in.',
      `${extra.name}’s line comes from Builder: draw it from the agent your prompt starts.`,
    ]);
    // A builder at a hand-off: only a reviewer starts there, unless the first agent is a lead.
    const built = withLine(addAgent(boardDraft(pair), 'builder', { x: 0, y: 0 }).draft, 'builder', 'member-3');
    expect(boardPrefab(built).problems).toEqual(['Only a reviewer starts at a hand-off: make Builder 2 a reviewer, or Builder a lead.']);
    expect(boardPrefab({ ...boardDraft(pair), agents: [], lines: [] }).problems).toEqual(['Add an agent.', 'Draw a line from Your prompt to the agent it starts.']);
  });

  it('makes a lead’s lines “starts it”, and saves them as the lead’s starts', () => {
    const led = addAgent(addAgent({ ...boardDraft(pair), agents: [], lines: [] }, 'lead', { x: 0, y: 0 }).draft, 'builder', { x: 300, y: 0 });
    const [lead, helper] = led.draft.agents.map((agent) => agent.member.id) as [string, string];
    const drawn = withLine(withLine(led.draft, PROMPT_PLACE, lead), lead, helper);
    expect(lineMeaning(drawn, { from: lead, to: helper })).toBe('starts');
    expect(startWord(drawn, helper)).toEqual({ text: 'Started by Lead' });
    expect(boardPrefab(drawn).prefab.members.map((each) => [each.role, each.starts])).toEqual([
      ['orchestrator', 'prompt'],
      ['implementer', 'lead'],
    ]);
    expect(text(drawn)).toBe('Your prompt goes to Lead, who starts Builder when its work is ready. It stops after 2 rounds.');
  });

  it('says the board in a sentence under it', () => {
    expect(text(boardDraft(pair))).toBe('Your prompt goes to Builder. When it hands off, Review starts and must approve. It stops after 2 rounds.');
    const two = withLine(addAgent(boardDraft(pair), 'reviewer', { x: 0, y: 0 }).draft, 'builder', 'member-3');
    expect(text(two)).toBe('Your prompt goes to Builder. When it hands off, Review and Reviewer start; every one must approve. It stops after 2 rounds.');
    expect(text({ ...boardDraft(pair), lines: [] })).toBe('Draw a line from Your prompt to the agent it starts.');
    expect(text(withoutAgents(boardDraft(pair), ['review']))).toBe('Your prompt goes to Builder, on its own.');
  });

  it('pastes copies 32px on, with new ids and the lines between them', () => {
    const draft = boardDraft(pair);
    const copy = pasted(draft, draft.agents, draft.lines);
    expect(copy.draft.agents.slice(2).map((agent) => [agent.member.id, agent.place.x - draft.agents.find((each) => each.member.name === agent.member.name)!.place.x])).toEqual([
      ['builder-2', 32],
      ['review-2', 32],
    ]);
    expect(copy.draft.lines.slice(2)).toEqual([{ from: 'builder-2', to: 'review-2' }]);
    expect(copy.ids).toEqual(['builder-2', 'review-2']);
  });

  it('opens a new prefab as Your prompt and one Builder, and a built-in as a copy saved as new', () => {
    expect(boardPrefab(boardDraft(newPrefab())).problems).toEqual(['Name the prefab.']);
    expect(text(boardDraft(newPrefab()))).toBe('Your prompt goes to Builder, on its own.');
    expect(copyName('Pair')).toBe('Pair (copy)');
    expect(copyName('x'.repeat(48))).toHaveLength(48);
    const built = { ...pair, builtIn: true, editedAt: null };
    expect(libraryBoard(built)).toMatchObject({ prefab: { name: 'Pair (copy)' }, replaces: null });
    expect(libraryBoard({ ...built, builtIn: false })).toEqual({ prefab: pair, replaces: 'Pair' });
    expect(libraryBoard({ ...built, builtIn: false }, true).replaces).toBeNull();
  });

  it('saves an agent as a prefab of one, with its role’s prompt only for a role of its own', () => {
    const agent = { name: 'Tidy', role: 'custom' as const, roleName: 'designer', harness: 'codex' as const, model: 'gpt-5', effort: 'high' as const };
    expect(agentPrefab(agent, { name: 'Tidy', icon: 'palette', template: 'Draw it' }).members).toEqual([
      { id: 'agent', role: 'designer', name: 'Tidy', harness: 'codex', model: 'gpt-5', effort: 'high', template: 'Draw it', starts: 'prompt', subagents: [] },
    ]);
    expect(agentPrefab({ ...agent, role: 'implementer', roleName: null }, { name: 'B', icon: 'crew', template: 'Draw it' }).members[0]).toMatchObject({ role: 'implementer', template: null });
    // A reviewer saved on its own opens on its board as the file has it, and saves again with nothing to fix.
    const reviewer = agentPrefab({ ...agent, role: 'reviewer', roleName: null }, { name: 'Second look', icon: 'crew', template: null });
    expect(boardPrefab(boardDraft(reviewer))).toEqual({ prefab: reviewer, problems: [] });
  });

  it('lists an own prompt on an agent your prompt no longer starts, rather than dropping it at Save', () => {
    const own = { ...pair, members: [member('builder', 'designer', { name: 'Builder', starts: 'prompt', template: 'Draw it' }), member('review', 'reviewer', { name: 'Review' })] };
    const moved = withLine(boardDraft(own), PROMPT_PLACE, 'review');
    expect(boardPrefab(moved).problems).toContain('Builder has a prompt of its own, which only the agent your prompt starts keeps: clear it, or draw Your prompt to it.');
  });
});
