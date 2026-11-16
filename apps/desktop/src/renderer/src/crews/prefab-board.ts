// A crew prefab as its own mini board: Your prompt and an agent tile for each member, where each sits, and a line for
// each start. Any line may be drawn; what the prefab's file can't hold is listed as a problem at Save, never refused
// while drawing. Pure, so the board and its tests share it.
import {
  DEFAULT_PREFAB_ROUND_LIMIT,
  isOrchestratorRole,
  MAX_NAME_LENGTH,
  MAX_PREFAB_MEMBERS,
  ORCHESTRATOR_ROLE,
  PROMPT_PLACE,
  REVIEWER_ROLES,
  type Agent,
  type CrewPrefab,
  type LibraryPrefab,
  type PrefabMember,
  type PrefabPlaces,
} from '@agent-board/daemon/protocol';
import { MAX_PREFAB_NAME, memberLabel, type Words } from './prefab-flow';

/** An agent tile's size on the board, and Your prompt's pill. */
export const AGENT_TILE = { width: 240, height: 150 } as const;
export const PROMPT_PILL = { width: 132, height: 40 } as const;
/** How far a paste, or a duplicate, lands from what it copies. */
const PASTE_OFFSET = 32;
const COLUMN_GAP = 96;
const ROW_GAP = 32;

type Point = { x: number; y: number };

export interface BoardAgent {
  /** The member it saves as; its `starts` is read from the lines at Save. */
  member: PrefabMember;
  /** Its top-left corner. */
  place: Point;
}

/** A line from Your prompt (`PROMPT_PLACE`) or an agent, to the agent it starts. */
export interface BoardLine {
  from: string;
  to: string;
}

export type BoardDraft = Omit<CrewPrefab, 'members'> & { prompt: Point; agents: BoardAgent[]; lines: BoardLine[] };

/** What a line means: the prompt starting its agent, a hand-off to a reviewer, or a lead starting a helper. */
export type LineMeaning = 'prompt' | 'handoff' | 'starts';

/** The kinds of agent the board's + Agent adds. */
export const AGENT_KINDS = {
  builder: { role: 'implementer', name: 'Builder' },
  reviewer: { role: 'reviewer', name: 'Reviewer' },
  designer: { role: 'designer', name: 'Designer' },
  lead: { role: ORCHESTRATOR_ROLE, name: 'Lead' },
} as const;
export type AgentKind = keyof typeof AGENT_KINDS;

const isReviewer = (member: PrefabMember) => REVIEWER_ROLES.includes(member.role as never);
const agentNamed = (draft: BoardDraft, id: string) => draft.agents.find((agent) => agent.member.id === id);
const lineInto = (draft: BoardDraft, id: string) => draft.lines.find((line) => line.to === id);

/** The agent Your prompt starts, if a line goes from it to one. */
export function firstAgent(draft: BoardDraft): BoardAgent | undefined {
  const line = draft.lines.find((each) => each.from === PROMPT_PLACE);
  return line === undefined ? undefined : agentNamed(draft, line.to);
}

/** Whether the lines from the first agent start helpers (a lead's, or a ticket's chat's) rather than hand off to reviewers. */
const led = (draft: BoardDraft) => draft.onBoard === 'ticket' || isOrchestratorRole(firstAgent(draft)?.member.role ?? null);

export function lineMeaning(draft: BoardDraft, line: BoardLine): LineMeaning {
  if (line.from === PROMPT_PLACE) return 'prompt';
  return led(draft) ? 'starts' : 'handoff';
}

/** What an agent's tile says starts it. */
export function startWord(draft: BoardDraft, id: string): { text: string; warn?: true } {
  const line = lineInto(draft, id);
  const from = line === undefined || line.from === PROMPT_PLACE ? undefined : agentNamed(draft, line.from);
  if (line === undefined || (line.from !== PROMPT_PLACE && from === undefined)) return { text: 'No line in yet', warn: true };
  if (from === undefined) return { text: 'Starts on your prompt' };
  return { text: lineMeaning(draft, line) === 'handoff' ? `At ${memberLabel(from.member)}’s hand-off` : `Started by ${memberLabel(from.member)}` };
}

/**
 * Lays out a prefab saved without places from its starts: Your prompt, its agent, then a column of those that agent
 * starts, and any other agent under them.
 */
function laidOut(prefab: CrewPrefab): { prompt: Point; places: Map<string, Point> } {
  const first = prefab.members.find((member) => member.starts === 'prompt');
  const later = prefab.members.filter((member) => member !== first);
  const step = AGENT_TILE.height + ROW_GAP;
  const places = new Map<string, Point>();
  if (first !== undefined) places.set(first.id, { x: 0, y: 0 });
  later.forEach((member, index) => places.set(member.id, { x: first === undefined ? 0 : AGENT_TILE.width + COLUMN_GAP, y: (index - (later.length - 1) / 2) * step }));
  return { prompt: { x: -(PROMPT_PILL.width + COLUMN_GAP), y: (AGENT_TILE.height - PROMPT_PILL.height) / 2 }, places };
}

/** The prefab as its board: each member where it was saved, else laid out, and a line for each start. */
export function boardDraft(prefab: CrewPrefab & { places?: PrefabPlaces }): BoardDraft {
  const { members, ...fields } = prefab;
  delete (fields as { places?: PrefabPlaces }).places;
  delete (fields as { builtIn?: boolean }).builtIn;
  delete (fields as { editedAt?: string | null }).editedAt;
  const laid = laidOut(prefab);
  const first = members.find((member) => member.starts === 'prompt');
  const lines: BoardLine[] = members.flatMap((member): BoardLine[] =>
    member.starts === 'prompt' ? [{ from: PROMPT_PLACE, to: member.id }] : first === undefined ? [] : [{ from: first.id, to: member.id }],
  );
  return {
    ...fields,
    prompt: prefab.places?.[PROMPT_PLACE] ?? laid.prompt,
    agents: members.map((member) => ({ member, place: prefab.places?.[member.id] ?? laid.places.get(member.id)! })),
    lines,
  };
}

/** Where each agent sits, and the prompt, as the library keeps it. */
export function boardPlaces(draft: BoardDraft): PrefabPlaces {
  return { [PROMPT_PLACE]: draft.prompt, ...Object.fromEntries(draft.agents.map((agent) => [agent.member.id, agent.place])) };
}

/**
 * The board with a line from `from` to `to`: it replaces the line into `to`, and from the prompt, the prompt's other
 * line. A line into the prompt, from an agent to itself or to no agent of the board, is no line: the board as it was.
 */
export function withLine(draft: BoardDraft, from: string, to: string): BoardDraft {
  if (to === PROMPT_PLACE || from === to || agentNamed(draft, to) === undefined) return draft;
  if (from !== PROMPT_PLACE && agentNamed(draft, from) === undefined) return draft;
  const kept = draft.lines.filter((line) => line.to !== to && !(from === PROMPT_PLACE && line.from === PROMPT_PLACE));
  return { ...draft, lines: [...kept, { from, to }] };
}

export const withoutLine = (draft: BoardDraft, line: BoardLine): BoardDraft => ({ ...draft, lines: draft.lines.filter((each) => each.from !== line.from || each.to !== line.to) });

/** The board without the agents `ids`, nor their lines. */
export function withoutAgents(draft: BoardDraft, ids: readonly string[]): BoardDraft {
  const gone = new Set(ids);
  return { ...draft, agents: draft.agents.filter((agent) => !gone.has(agent.member.id)), lines: draft.lines.filter((line) => !gone.has(line.from) && !gone.has(line.to)) };
}

/** The board with these agents, or the prompt (`PROMPT_PLACE`), moved. */
export function moved(draft: BoardDraft, places: ReadonlyMap<string, Point>): BoardDraft {
  return {
    ...draft,
    prompt: places.get(PROMPT_PLACE) ?? draft.prompt,
    agents: draft.agents.map((agent) => {
      const place = places.get(agent.member.id);
      return place === undefined ? agent : { ...agent, place };
    }),
  };
}

/** An id like `stem` that no agent of the board has, in the form the file takes. */
function freeId(draft: BoardDraft, stem: string, taken = new Set(draft.agents.map((agent) => agent.member.id))): string {
  const base = stem.slice(0, 20).replace(/-+$/, '') || 'member';
  let n = 2;
  while (taken.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

/** A name like `name` that no agent of the board has: `Builder`, then `Builder 2`. */
function freeName(draft: BoardDraft, name: string): string {
  const taken = new Set(draft.agents.map((agent) => memberLabel(agent.member)));
  if (!taken.has(name)) return name;
  let n = 2;
  while (taken.has(`${name} ${n}`)) n += 1;
  return `${name} ${n}`;
}

/** The board with a new agent of `kind` at `at`, and its id. */
export function addAgent(draft: BoardDraft, kind: AgentKind, at: Point): { draft: BoardDraft; id: string } {
  const taken = new Set(draft.agents.map((agent) => agent.member.id));
  let n = draft.agents.length + 1;
  while (taken.has(`member-${n}`)) n += 1;
  const id = `member-${n}`;
  const { role, name } = AGENT_KINDS[kind];
  const member: PrefabMember = { id, role, name: freeName(draft, name), harness: 'claude', model: null, effort: null, template: null, starts: 'handoff', subagents: [] };
  return { draft: { ...draft, agents: [...draft.agents, { member, place: at }] }, id };
}

/** The board with copies of `agents`, `PASTE_OFFSET` on, under new ids, and of the lines between them; and their ids. */
export function pasted(draft: BoardDraft, agents: readonly BoardAgent[], lines: readonly BoardLine[]): { draft: BoardDraft; ids: string[] } {
  const taken = new Set(draft.agents.map((agent) => agent.member.id));
  const ids = new Map<string, string>();
  for (const agent of agents) {
    const id = freeId(draft, agent.member.id, taken);
    taken.add(id);
    ids.set(agent.member.id, id);
  }
  const copies = agents.map((agent) => ({ member: { ...agent.member, id: ids.get(agent.member.id)! }, place: { x: agent.place.x + PASTE_OFFSET, y: agent.place.y + PASTE_OFFSET } }));
  const copiedLines = lines.flatMap((line) => (ids.has(line.from) && ids.has(line.to) ? [{ from: ids.get(line.from)!, to: ids.get(line.to)! }] : []));
  return { draft: { ...draft, agents: [...draft.agents, ...copies], lines: [...draft.lines, ...copiedLines] }, ids: [...ids.values()] };
}

/**
 * The prefab the board saves as, each member's start read from its line in, and what keeps the library from taking it,
 * in the order to fix it. Lines the file can't hold are listed here, never refused while drawing.
 */
export function boardPrefab(draft: BoardDraft): { prefab: CrewPrefab; problems: string[] } {
  const { agents, ...fields } = draft;
  // Where things sit is the library's, beside the file: never in it.
  delete (fields as { prompt?: Point }).prompt;
  delete (fields as { lines?: BoardLine[] }).lines;
  const first = firstAgent(draft);
  const leads = led(draft);
  const startOf = (id: string): PrefabMember['starts'] => {
    const line = lineInto(draft, id);
    if (line?.from === PROMPT_PLACE) return 'prompt';
    return leads ? 'lead' : 'handoff';
  };
  const members = agents.map(({ member }): PrefabMember => {
    const starts = startOf(member.id);
    return { ...member, starts, template: starts === 'prompt' ? member.template : null };
  });

  const problems: string[] = [];
  const name = draft.name.trim();
  if (name === '') problems.push('Name the prefab.');
  if (name.length > MAX_PREFAB_NAME) problems.push(`A prefab's name is at most ${MAX_PREFAB_NAME} characters.`);
  if (agents.length === 0) problems.push('Add an agent.');
  if (agents.length > MAX_PREFAB_MEMBERS) problems.push(`A prefab has at most ${MAX_PREFAB_MEMBERS} agents.`);
  if (first === undefined) problems.push('Draw a line from Your prompt to the agent it starts.');
  for (const { member } of agents) {
    if (lineInto(draft, member.id) === undefined) problems.push(`${memberLabel(member)} has no line in.`);
  }
  for (const { member } of agents) {
    const line = lineInto(draft, member.id);
    if (line === undefined || line.from === PROMPT_PLACE || first === undefined) continue;
    const from = agentNamed(draft, line.from)!;
    if (from !== first) problems.push(`${memberLabel(member)}’s line comes from ${memberLabel(from.member)}: draw it from the agent your prompt starts.`);
    else if (!leads && !isReviewer(member)) problems.push(`Only a reviewer starts at a hand-off: make ${memberLabel(member)} a reviewer, or ${memberLabel(first.member)} a lead.`);
  }
  for (const { member } of agents) {
    if (member.role !== null && member.role.trim() === '') problems.push(`${memberLabel(member)}'s role needs a name.`);
    if (member.template !== null && member.template.trim() === '' && startOf(member.id) === 'prompt') problems.push(`${memberLabel(member)}'s own prompt is empty: write it, or use the zone's.`);
    if (member.template !== null && member.template.trim() !== '' && startOf(member.id) !== 'prompt') {
      problems.push(`${memberLabel(member)} has a prompt of its own, which only the agent your prompt starts keeps: clear it, or draw Your prompt to it.`);
    }
  }
  return { prefab: { ...fields, name, members }, problems };
}

/** Names joined as prose, in bold: `A`, `A and B`, `A, B and C`. */
const listed = (names: string[]): Words[] =>
  names.flatMap((name, index): Words[] => [...(index === 0 ? [] : [{ text: index === names.length - 1 ? ' and ' : ', ' }]), { text: name, bold: true }]);

/** The board in words, as under it: who your prompt goes to, who starts after it, and when the crew stops. */
export function boardSentence(draft: BoardDraft): Words[] {
  const first = firstAgent(draft);
  if (first === undefined) return [{ text: 'Draw a line from Your prompt to the agent it starts.' }];
  const name = memberLabel(first.member);
  const later = draft.lines.filter((line) => line.from === first.member.id).flatMap((line) => {
    const agent = agentNamed(draft, line.to);
    return agent === undefined ? [] : [memberLabel(agent.member)];
  });
  const stops: Words[] = [{ text: ' It stops after ' }, { text: `${draft.roundLimit} ${draft.roundLimit === 1 ? 'round' : 'rounds'}`, bold: true }, { text: '.' }];
  if (later.length === 0) return [{ text: 'Your prompt goes to ' }, { text: name, bold: true }, { text: ', on its own.' }];
  if (led(draft)) {
    return [{ text: 'Your prompt goes to ' }, { text: name, bold: true }, { text: ', who starts ' }, ...listed(later), { text: ` when ${later.length === 1 ? 'its' : 'their'} work is ready.` }, ...stops];
  }
  return [
    { text: 'Your prompt goes to ' },
    { text: name, bold: true },
    { text: '. When it hands off, ' },
    ...listed(later),
    { text: later.length === 1 ? ' starts and must approve.' : ' start; every one must approve.' },
    ...stops,
  ];
}

/** A new prefab, as + New prefab opens it: Your prompt and one Builder it starts. */
export function newPrefab(): CrewPrefab {
  return {
    name: '',
    icon: 'crew',
    purpose: '',
    roundLimit: DEFAULT_PREFAB_ROUND_LIMIT,
    onBoard: 'card',
    members: [{ id: 'builder', role: 'implementer', name: 'Builder', harness: 'claude', model: null, effort: null, template: null, starts: 'prompt', subagents: [] }],
  };
}

/** A copy's name: `Name (copy)`, the name cut short to leave it room. */
export function copyName(name: string): string {
  const tail = ' (copy)';
  return `${name.slice(0, MAX_PREFAB_NAME - tail.length).trimEnd()}${tail}`;
}

/** What a library prefab opens on its board as: itself, saved over; or a copy of a built-in, or of one asked for, saved as new. */
export function libraryBoard(prefab: LibraryPrefab, copy = prefab.builtIn): { prefab: CrewPrefab & { places?: PrefabPlaces }; replaces: string | null } {
  const own: CrewPrefab & { places?: PrefabPlaces } = {
    name: copy ? copyName(prefab.name) : prefab.name,
    icon: prefab.icon,
    purpose: prefab.purpose,
    roundLimit: prefab.roundLimit,
    onBoard: prefab.onBoard,
    ...(prefab.ticketChat === undefined ? {} : { ticketChat: prefab.ticketChat }),
    members: prefab.members,
    ...(prefab.places === undefined ? {} : { places: prefab.places }),
  };
  return { prefab: own, replaces: copy ? null : prefab.name };
}

/** The role a member of a prefab takes from an agent: its built-in role, or its role of its own by name. */
export function agentRole(agent: Pick<Agent, 'role' | 'roleName'>): string | null {
  if (agent.role === 'custom') return agent.roleName;
  return agent.role;
}

/**
 * A prefab of one agent, as Save as prefab… makes it from its tile: its name, role, AI, model and reasoning, starting
 * on the prompt; for a role of its own, that role's prompt (`template`), as its zone has it. Never its chat, its first
 * message, its ticket, branch or repo.
 */
export function agentPrefab(agent: Pick<Agent, 'name' | 'role' | 'roleName' | 'harness' | 'model' | 'effort'>, fields: { name: string; icon: string; template: string | null }): CrewPrefab {
  const role = agentRole(agent);
  const named = role !== null && !(REVIEWER_ROLES as readonly string[]).includes(role) && role !== 'implementer' && !isOrchestratorRole(role);
  const template = named && fields.template !== null && fields.template.trim() !== '' ? fields.template : null;
  return {
    name: fields.name,
    icon: fields.icon,
    purpose: '',
    roundLimit: DEFAULT_PREFAB_ROUND_LIMIT,
    onBoard: 'card',
    members: [{ id: 'agent', role, name: agent.name.trim() === '' ? null : agent.name.slice(0, MAX_NAME_LENGTH), harness: agent.harness, model: agent.model, effort: agent.effort, template, starts: 'prompt', subagents: [] }],
  };
}
