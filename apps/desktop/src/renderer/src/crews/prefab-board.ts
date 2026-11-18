// A crew prefab as its own mini board: its graph drawn out, an agent tile for each member, a pill for each input, a
// loop gate for each of its gates, the lines between them, and where each sits. What the library would refuse is
// listed as a problem at Save, on the thing it is about; only a line no graph holds is refused while drawing. Pure,
// so the board and its tests share it.
import {
  DEFAULT_GATE_AT_CAP,
  DEFAULT_GATE_CAP,
  DEFAULT_GATE_TIMEOUT,
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
  type PrefabGate,
  type PrefabInput,
  type PrefabInputKind,
  type PrefabLine,
  type PrefabMember,
  type PrefabPlaces,
} from '@agent-board/daemon/protocol';
import { graphOf, roundLimitOf, startsOf } from '@agent-board/daemon/prefab-graph';
import { graphProblem } from '@agent-board/daemon/prefab-graph-checks';
import { gateWait, graphLayout, graphSentence, MAX_PREFAB_NAME, memberBranch, memberLabel, SOURCE_NAMES, type GraphPrefab, type Size, type Words } from './prefab-flow';

/** An agent tile's size on the board, an input's pill, and a loop gate's diamond. */
export const AGENT_TILE = { width: 240, height: 150 } as const;
export const PROMPT_PILL = { width: 132, height: 40 } as const;
/** An End pill: wider, for `Ready to merge` with its icon and its in-dot clear, in the widest type. */
export const END_PILL = { width: 160, height: 40 } as const;

/** A pill's size, by its kind. */
export const pillSize = (kind: PrefabInputKind): { width: number; height: number } => (kind === 'end' ? END_PILL : PROMPT_PILL);
export const GATE_SIZE = { width: 62, height: 62 } as const;
/** How far a paste, or a duplicate, lands from what it copies. */
const PASTE_OFFSET = 32;
const COLUMN_GAP = 64;
const ROW_GAP = 32;

type Point = { x: number; y: number };

export interface BoardAgent {
  /** The member it saves as; its `starts` is read from the lines at Save. */
  member: PrefabMember;
  /** Its top-left corner. */
  place: Point;
}

export interface BoardInput {
  input: PrefabInput;
  place: Point;
}

export interface BoardGate {
  gate: PrefabGate;
  place: Point;
}

/** The board: the prefab's fields, and its members, inputs and loop gates each where it sits, and its lines. */
export type BoardDraft = Omit<CrewPrefab, 'members' | 'inputs' | 'gates' | 'lines'> & { agents: BoardAgent[]; inputs: BoardInput[]; gates: BoardGate[]; lines: PrefabLine[] };

/** A problem that keeps the library from taking the board, and the id of what it is about (a line's `lineKey`), or null. */
export interface BoardProblem {
  text: string;
  about: string | null;
}

/** How the board draws a line: a loop gate's again or done way, a lead starting a member, or a plain line. */
export type LineKind = 'again' | 'done' | 'lead' | 'plain';

/** The kinds of agent the board's + Agent adds. */
export const AGENT_KINDS = {
  builder: { role: 'implementer', name: 'Builder' },
  reviewer: { role: 'reviewer', name: 'Reviewer' },
  designer: { role: 'designer', name: 'Designer' },
  lead: { role: ORCHESTRATOR_ROLE, name: 'Lead' },
} as const;
export type AgentKind = keyof typeof AGENT_KINDS;

/** The schedules a clock offers, in words, by its cron. */
export const CLOCK_SCHEDULES = [
  { value: '0 * * * *', label: 'Every hour' },
  { value: '0 9 * * 1-5', label: 'Weekdays at 9:00' },
  { value: '0 9 * * *', label: 'Every day at 9:00' },
  { value: '0 9 * * 1', label: 'Mondays at 9:00' },
] as const;

/** A new input of each kind, its id the stem before any number. */
const NEW_INPUTS: Record<PrefabInputKind, (id: string) => PrefabInput> = {
  prompt: (id) => ({ id, kind: 'prompt' }),
  user: (id) => ({ id, kind: 'user' }),
  queue: (id) => ({ id, kind: 'queue' }),
  ticket: (id) => ({ id, kind: 'ticket' }),
  clock: (id) => ({ id, kind: 'clock', schedule: CLOCK_SCHEDULES[1].value, line: 'Look for new work' }),
  end: (id) => ({ id, kind: 'end', as: 'ready' }),
};
const INPUT_STEMS: Record<PrefabInputKind, string> = { prompt: 'prompt', user: 'ok', queue: 'queue', ticket: 'ticket', clock: 'clock', end: 'end' };

const agentNamed = (draft: BoardDraft, id: string) => draft.agents.find((agent) => agent.member.id === id);
const inputNamed = (draft: BoardDraft, id: string) => draft.inputs.find((each) => each.input.id === id)?.input;
const isGate = (draft: BoardDraft, id: string) => draft.gates.some((each) => each.gate.id === id);
const sameLine = (a: Pick<PrefabLine, 'from' | 'to'>, b: Pick<PrefabLine, 'from' | 'to'>) => a.from === b.from && a.to === b.to;

/** The board's graph, as the prefab's file holds it. */
const boardGraph = (draft: BoardDraft): GraphPrefab => ({
  members: draft.agents.map((agent) => agent.member),
  inputs: draft.inputs.map((each) => each.input),
  gates: draft.gates.map((each) => each.gate),
  lines: draft.lines,
});

/** Whether `id` leads as an orchestrator does: an orchestrator, or a ticket's chat (the member its prompt goes to). */
function leads(draft: BoardDraft, id: string): boolean {
  const agent = agentNamed(draft, id);
  if (agent === undefined) return false;
  if (isOrchestratorRole(agent.member.role)) return true;
  return draft.onBoard === 'ticket' && draft.lines.some((line) => line.to === id && inputNamed(draft, line.from)?.kind === 'prompt');
}

export function lineKind(line: PrefabLine): LineKind {
  if (line.way !== undefined) return line.way;
  return line.lead === true ? 'lead' : 'plain';
}

/** What an agent's tile says starts it: its first line in, other than a loop gate's again line. */
export function startWord(draft: BoardDraft, id: string): { text: string; warn?: true } {
  const line = draft.lines.find((each) => each.to === id && each.way !== 'again');
  if (line === undefined) return { text: 'No line in yet', warn: true };
  const input = inputNamed(draft, line.from);
  if (input !== undefined) {
    if (input.kind === 'prompt') return { text: 'Starts on your prompt' };
    if (input.kind === 'user') return { text: 'After your OK' };
    if (input.kind === 'ticket') return { text: 'Starts on the ticket' };
    if (input.kind === 'queue') return { text: 'Takes work from the queue' };
    if (input.kind === 'clock') return { text: 'Starts on the clock' };
  }
  if (isGate(draft, line.from)) return { text: 'After the loop' };
  const from = agentNamed(draft, line.from);
  if (from === undefined) return { text: 'No line in yet', warn: true };
  return { text: line.lead === true ? `Started by ${memberLabel(from.member)}` : `At ${memberLabel(from.member)}’s hand-off` };
}

/**
 * The branch an agent's tile says it works on: only where more than one member of the crew writes, so where each works
 * matters; never a reviewer's, which writes only its review.
 */
export function branchTag(draft: BoardDraft, id: string): 'own branch' | 'crew branch' | null {
  const branch = memberBranch(draft.agents.map((agent) => agent.member), id);
  return branch === null ? null : branch === 'own' ? 'own branch' : 'crew branch';
}

/**
 * The prefab as its board: its graph (from its members' starts, if it was saved without), each thing where it was saved
 * (an older save's prompt under `PROMPT_PLACE`), and the rest laid out left to right, beside what was placed.
 */
export function boardDraft(prefab: CrewPrefab & { places?: PrefabPlaces }): BoardDraft {
  const { members, ...fields } = prefab;
  for (const key of ['inputs', 'gates', 'lines', 'places'] as const) delete (fields as Partial<CrewPrefab & { places: PrefabPlaces }>)[key];
  delete (fields as { builtIn?: boolean }).builtIn;
  delete (fields as { editedAt?: string | null }).editedAt;
  const graph = graphOf(prefab);
  const places = prefab.places ?? {};
  const firstPrompt = graph.inputs.find((input) => input.kind === 'prompt')?.id;
  const saved = (id: string): Point | undefined => places[id] ?? (id === firstPrompt ? places[PROMPT_PLACE] : undefined);
  const laid = graphLayout({ members, ...graph }, { member: AGENT_TILE, input: PROMPT_PILL, end: END_PILL, gate: GATE_SIZE }, { gap: COLUMN_GAP, row: ROW_GAP });
  // What was never placed is laid out as if the first thing placed were where the layout puts it.
  const anchor = [...laid.keys()].find((id) => saved(id) !== undefined);
  const offset = anchor === undefined ? { x: 0, y: 0 } : { x: saved(anchor)!.x - laid.get(anchor)!.x, y: saved(anchor)!.y - laid.get(anchor)!.y };
  const place = (id: string): Point => saved(id) ?? { x: laid.get(id)!.x + offset.x, y: laid.get(id)!.y + offset.y };
  return {
    ...fields,
    agents: members.map((member) => ({ member, place: place(member.id) })),
    inputs: graph.inputs.map((input) => ({ input, place: place(input.id) })),
    gates: graph.gates.map((gate) => ({ gate, place: place(gate.id) })),
    lines: graph.lines,
  };
}

/** Where each thing sits, as the library keeps it; the first prompt under `PROMPT_PLACE` too, for an older app. */
export function boardPlaces(draft: BoardDraft): PrefabPlaces {
  const prompt = draft.inputs.find((each) => each.input.kind === 'prompt');
  return {
    ...(prompt === undefined ? {} : { [PROMPT_PLACE]: prompt.place }),
    ...Object.fromEntries(draft.agents.map((agent) => [agent.member.id, agent.place])),
    ...Object.fromEntries(draft.inputs.map((each) => [each.input.id, each.place])),
    ...Object.fromEntries(draft.gates.map((each) => [each.gate.id, each.place])),
  };
}

/**
 * The board with a line from `from` to `to`, made what it is by where it runs: out of a loop gate, its again line (to a
 * member, if it has none yet) or a done line; a member's into a loop gate, its review; a lead's to a member, a lead
 * line; one member's to another, its hand-off. A line into where work comes from, out of an end, to itself, twice, or
 * to or from nothing on the board, is no line: the board as it was.
 */
export function withLine(draft: BoardDraft, from: string, to: string): BoardDraft {
  const exists = (id: string) => agentNamed(draft, id) !== undefined || inputNamed(draft, id) !== undefined || isGate(draft, id);
  if (from === to || !exists(from) || !exists(to)) return draft;
  if (SOURCE_NAMES[inputNamed(draft, to)?.kind as PrefabInputKind] !== undefined) return draft;
  if (inputNamed(draft, from)?.kind === 'end') return draft;
  if (draft.lines.some((line) => sameLine(line, { from, to }))) return draft;
  const member = (id: string) => agentNamed(draft, id) !== undefined;
  let line: PrefabLine = { from, to };
  if (isGate(draft, from)) {
    const hasAgain = draft.lines.some((each) => each.from === from && each.way === 'again');
    line = { from, to, way: member(to) && !hasAgain ? 'again' : 'done' };
  } else if (member(from) && isGate(draft, to)) line = { from, to, carries: 'review' };
  else if (member(from) && member(to)) line = leads(draft, from) ? { from, to, lead: true } : { from, to, carries: 'handoff' };
  return { ...draft, lines: [...draft.lines, line] };
}

/**
 * The board with `line` changed: its way (a loop gate's one again line: making another the again line makes the old
 * one a done line), or what it carries (undefined for nothing).
 */
export function withLineSet(draft: BoardDraft, line: Pick<PrefabLine, 'from' | 'to'>, set: { way?: 'again' | 'done'; carries?: PrefabLine['carries'] }): BoardDraft {
  return {
    ...draft,
    lines: draft.lines.map((each) => {
      if (!sameLine(each, line)) return set.way === 'again' && each.from === line.from && each.way === 'again' ? { ...each, way: 'done' } : each;
      const next: PrefabLine = { ...each, ...set };
      if ('carries' in set && set.carries === undefined) delete next.carries;
      return next;
    }),
  };
}

export const withoutLine = (draft: BoardDraft, line: Pick<PrefabLine, 'from' | 'to'>): BoardDraft => ({ ...draft, lines: draft.lines.filter((each) => !sameLine(each, line)) });

/** The board without the members, inputs and loop gates `ids`, nor their lines. */
export function withoutNodes(draft: BoardDraft, ids: readonly string[]): BoardDraft {
  const gone = new Set(ids);
  return {
    ...draft,
    agents: draft.agents.filter((agent) => !gone.has(agent.member.id)),
    inputs: draft.inputs.filter((each) => !gone.has(each.input.id)),
    gates: draft.gates.filter((each) => !gone.has(each.gate.id)),
    lines: draft.lines.filter((line) => !gone.has(line.from) && !gone.has(line.to)),
  };
}

/** The board with these members, inputs or loop gates moved. */
export function moved(draft: BoardDraft, places: ReadonlyMap<string, Point>): BoardDraft {
  const at = <T extends { place: Point }>(each: T, id: string): T => {
    const place = places.get(id);
    return place === undefined ? each : { ...each, place };
  };
  return {
    ...draft,
    agents: draft.agents.map((agent) => at(agent, agent.member.id)),
    inputs: draft.inputs.map((each) => at(each, each.input.id)),
    gates: draft.gates.map((each) => at(each, each.gate.id)),
  };
}

/** The board's chrome over its canvas, in px: how far its islands float in, the bar's height, the foot's (the dock, hint and sentence, as measured), and a margin. */
export interface BoardChrome {
  inset: number;
  bar: number;
  foot: number;
  margin: number;
}

/** Room to leave at each side of the canvas, in screen px. */
export interface Sides {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** Fit's room at each side, in screen px: below the bar at the top, and above the foot's column at the bottom. */
export function fitPadding({ inset, bar, foot, margin }: BoardChrome): Sides {
  return { top: inset + bar + margin, bottom: inset + foot + margin, left: margin, right: margin };
}

/** How far below its ends a loop gate's again line dips, by how far apart they are. */
export const againDepth = (dx: number) => 56 + Math.abs(dx) * 0.15;

/** Half an again line's chip, which sits at the line's lowest. */
const AGAIN_CHIP_HALF = 12;
/** A loop gate's rule chip, over its diamond, with its gap. */
const GATE_RULE_ROOM = 28;
/** A loop gate's wait badge, under its diamond, with its gap: about as wide as `waits for both · 30 min`. */
const GATE_WAIT = { width: 150, height: 24 } as const;
/** How far right of the diamond's middle the wait badge starts, clear of the again line, which leaves from there. */
const GATE_WAIT_SHIFT = 8;
/** How far an again line keeps below the nodes it passes under. */
const AGAIN_CLEAR = 16;

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Each node's box, in graph px; a loop gate's grown up to take its rule chip, and its wait badge a box of its own under it. */
function nodeBoxes(draft: BoardDraft): (Bounds & { id: string })[] {
  const members = new Set(draft.agents.map((agent) => agent.member.id));
  const deciders = (id: string) => draft.lines.filter((line) => line.to === id && members.has(line.from)).length;
  return [
    ...draft.inputs.map(({ input, place }) => ({ id: input.id, ...place, ...pillSize(input.kind) })),
    ...draft.agents.map(({ member, place }) => ({ id: member.id, ...place, ...AGENT_TILE })),
    ...draft.gates.map(({ gate, place }) => ({ id: gate.id, x: place.x, y: place.y - GATE_RULE_ROOM, width: GATE_SIZE.width, height: GATE_SIZE.height + GATE_RULE_ROOM })),
    ...draft.gates
      .filter(({ gate }) => gateWait(gate, deciders(gate.id)) !== null)
      .map(({ gate, place }) => ({ id: `${gate.id}:wait`, x: place.x + GATE_SIZE.width / 2 + GATE_WAIT_SHIFT, y: place.y + GATE_SIZE.height, ...GATE_WAIT })),
  ];
}

/**
 * How far, in graph px, the deepest again line and its chip dip below the graph's lowest node: nothing when the dip
 * stays among the nodes, as under a fan of reviewers. Each runs from its gate's foot to the foot of the agent it goes
 * back to, and as a curve with both handles at its depth it bottoms out at three quarters of it.
 */
export function loopSag(draft: BoardDraft): number {
  const boxes = nodeBoxes(draft);
  if (boxes.length === 0) return 0;
  const lowest = Math.max(...boxes.map((box) => box.y + box.height));
  const foot = new Map(boxes.map((box) => [box.id, { x: box.x + box.width / 2, y: box.y + box.height }] as const));
  const dips = draft.lines
    .filter((line) => line.way === 'again')
    .map((line) => {
      const from = foot.get(line.from);
      const to = foot.get(line.to);
      return from === undefined || to === undefined ? lowest : Math.max(from.y, to.y) + 0.75 * againDip(draft, line) + AGAIN_CHIP_HALF;
    });
  return Math.max(0, ...dips.map((dip) => dip - lowest));
}

/**
 * How far below the lower of its ends an again line's handles go: `againDepth` for its span, or deeper, so the curve
 * passes at least `AGAIN_CLEAR` under every node between its gate's foot and its agent's. The curve, with both handles
 * at that depth and straight under its ends, is a cubic: for each node in the way, the depth that brings it low enough
 * at the node's edge farther from the middle, where it is highest. Not at the very ends, which no depth moves.
 */
export function againDip(draft: BoardDraft, line: PrefabLine): number {
  const boxes = nodeBoxes(draft);
  const foot = (id: string) => {
    const box = boxes.find((each) => each.id === id);
    return box === undefined ? undefined : { x: box.x + box.width / 2, y: box.y + box.height };
  };
  const from = foot(line.from);
  const to = foot(line.to);
  if (from === undefined || to === undefined) return againDepth(0);
  let depth = againDepth(to.x - from.x);
  const low = Math.max(from.y, to.y);
  const left = Math.min(from.x, to.x);
  const right = Math.max(from.x, to.x);
  const middle = (left + right) / 2;
  for (const box of boxes) {
    if ([line.from, line.to, `${line.from}:wait`, `${line.to}:wait`].includes(box.id)) continue;
    if (box.x + box.width <= left || box.x >= right) continue;
    // The curve rises towards its ends, so it is highest over the node at the node's edge farther from the middle.
    const x = Math.abs(box.x - middle) > Math.abs(box.x + box.width - middle) ? Math.max(box.x, left) : Math.min(box.x + box.width, right);
    // Where along the curve it is at x: its x runs 3t² - 2t³ of the way from end to end, so find t by halving.
    const share = (x - from.x) / (to.x - from.x || 1);
    let lo = 0;
    let hi = 1;
    for (let step = 0; step < 30; step++) {
      const t = (lo + hi) / 2;
      if (3 * t * t - 2 * t * t * t < share) lo = t;
      else hi = t;
    }
    const t = (lo + hi) / 2;
    const pull = 3 * t * (1 - t);
    if (pull < 0.05) continue;
    const need = box.y + box.height + AGAIN_CLEAR;
    const handle = (need - from.y * (1 - t) ** 3 - to.y * t ** 3) / pull;
    depth = Math.max(depth, handle - low);
  }
  return depth;
}

/** The box the board fits, in graph px: every node, the gates' rule chips, and the again lines' dips. Null with nothing on it. */
export function graphBounds(draft: BoardDraft): Bounds | null {
  const boxes = nodeBoxes(draft);
  if (boxes.length === 0) return null;
  const x = Math.min(...boxes.map((box) => box.x));
  const y = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.width));
  const bottom = Math.max(...boxes.map((box) => box.y + box.height)) + loopSag(draft);
  return { x, y, width: right - x, height: bottom - y };
}

/**
 * The viewport that shows `bounds` whole and centred in a canvas of `view`, clear of `room` at each side (screen px),
 * zoomed no further than `zoom` allows. A graph too big to show whole at `zoom.min` starts at its top left, where the
 * crew starts, and the rest is a pan away.
 */
export function fitViewport(bounds: Bounds, view: Size, room: Sides, zoom: { min: number; max: number }): { x: number; y: number; zoom: number } {
  const width = Math.max(1, view.width - room.left - room.right);
  const height = Math.max(1, view.height - room.top - room.bottom);
  const scale = Math.min(zoom.max, Math.max(zoom.min, Math.min(width / Math.max(1, bounds.width), height / Math.max(1, bounds.height))));
  const along = (space: number, size: number) => Math.max(0, (space - size * scale) / 2);
  return {
    x: room.left + along(width, bounds.width) - bounds.x * scale,
    y: room.top + along(height, bounds.height) - bounds.y * scale,
    zoom: scale,
  };
}

/**
 * How many lines an agent waits for, as its join badge counts them: not its again line, and Your prompt and the
 * ticket as one, as both are there when the crew starts.
 */
export function joinCount(draft: BoardDraft, id: string): number {
  const starts = new Set(draft.inputs.filter((each) => each.input.kind === 'prompt' || each.input.kind === 'ticket').map((each) => each.input.id));
  const lines = draft.lines.filter((line) => line.to === id && line.way !== 'again');
  const fromStart = lines.filter((line) => starts.has(line.from)).length;
  return lines.length - fromStart + (fromStart > 0 ? 1 : 0);
}

/** The board with one input changed, its id kept. */
export const withInput = (draft: BoardDraft, input: PrefabInput): BoardDraft => ({
  ...draft,
  inputs: draft.inputs.map((each) => (each.input.id === input.id ? { ...each, input } : each)),
});

/** The kinds a pill that brings work in can change between, in place. */
export const SOURCE_KINDS = ['prompt', 'queue', 'ticket', 'clock'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];
export const isSourceKind = (kind: PrefabInputKind): kind is SourceKind => (SOURCE_KINDS as readonly PrefabInputKind[]).includes(kind);

/** The board with one pill that brings work in turned to another such kind: its id, place and lines kept, the new kind's settings at their defaults. The id stays as it was (a prompt turned clock is still `prompt`): the lines name it, so re-stemming it would cut them. */
export function withInputKind(draft: BoardDraft, id: string, kind: SourceKind): BoardDraft {
  const input = inputNamed(draft, id);
  if (input === undefined || input.kind === kind || !isSourceKind(input.kind)) return draft;
  return withInput(draft, NEW_INPUTS[kind](id));
}

/** The board with one loop gate changed, its id kept. */
export const withGate = (draft: BoardDraft, gate: PrefabGate): BoardDraft => ({
  ...draft,
  gates: draft.gates.map((each) => (each.gate.id === gate.id ? { ...each, gate } : each)),
});

/** Every id on the board: its members', inputs' and loop gates'. */
const takenIds = (draft: BoardDraft) => new Set([...draft.agents.map((agent) => agent.member.id), ...draft.inputs.map((each) => each.input.id), ...draft.gates.map((each) => each.gate.id)]);

/** `stem`, or `stem-2` and on, whichever no thing on the board has. */
function freeStem(taken: ReadonlySet<string>, stem: string): string {
  if (!taken.has(stem)) return stem;
  let n = 2;
  while (taken.has(`${stem}-${n}`)) n += 1;
  return `${stem}-${n}`;
}

/** An id like `stem` that nothing on the board has, in the form the file takes. */
function freeId(taken: ReadonlySet<string>, stem: string): string {
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
  const taken = takenIds(draft);
  let n = draft.agents.length + 1;
  while (taken.has(`member-${n}`)) n += 1;
  const id = `member-${n}`;
  const { role, name } = AGENT_KINDS[kind];
  const member: PrefabMember = { id, role, name: freeName(draft, name), harness: 'claude', model: null, effort: null, template: null, starts: 'handoff', subagents: [] };
  return { draft: { ...draft, agents: [...draft.agents, { member, place: at }] }, id };
}

/** The board with a new input of `kind` at `at`, a clock's with a weekday schedule, an end's ready to merge; and its id. */
export function addInput(draft: BoardDraft, kind: PrefabInputKind, at: Point): { draft: BoardDraft; id: string } {
  const id = freeStem(takenIds(draft), INPUT_STEMS[kind]);
  return { draft: { ...draft, inputs: [...draft.inputs, { input: NEW_INPUTS[kind](id), place: at }] }, id };
}

/** The board with a new loop gate at `at`: until done, at most 5 rounds, then it asks; 30 minutes for a late word. */
export function addGate(draft: BoardDraft, at: Point): { draft: BoardDraft; id: string } {
  const id = freeStem(takenIds(draft), 'loop');
  const gate: PrefabGate = { id, rule: 'done', cap: DEFAULT_GATE_CAP, atCap: DEFAULT_GATE_AT_CAP, timeout: DEFAULT_GATE_TIMEOUT };
  return { draft: { ...draft, gates: [...draft.gates, { gate, place: at }] }, id };
}

/** The board with copies of `agents`, `PASTE_OFFSET` on, under new ids, and of the lines between them; and their ids. */
export function pasted(draft: BoardDraft, agents: readonly BoardAgent[], lines: readonly PrefabLine[]): { draft: BoardDraft; ids: string[] } {
  const taken = takenIds(draft);
  const ids = new Map<string, string>();
  for (const agent of agents) {
    const id = freeId(taken, agent.member.id);
    taken.add(id);
    ids.set(agent.member.id, id);
  }
  const copies = agents.map((agent) => ({ member: { ...agent.member, id: ids.get(agent.member.id)! }, place: { x: agent.place.x + PASTE_OFFSET, y: agent.place.y + PASTE_OFFSET } }));
  const copiedLines = lines.flatMap((line) => (ids.has(line.from) && ids.has(line.to) ? [{ ...line, from: ids.get(line.from)!, to: ids.get(line.to)! }] : []));
  return { draft: { ...draft, agents: [...draft.agents, ...copies], lines: [...draft.lines, ...copiedLines] }, ids: [...ids.values()] };
}

/** An input's words, as its pill says them. */
const inputName = (input: PrefabInput): string => (input.kind === 'end' ? (input.as === 'done' ? 'Done' : 'Ready to merge') : input.kind === 'user' ? 'Your OK' : SOURCE_NAMES[input.kind]!);

/** A member, input or loop gate by name, as a sentence says it: an agent's label, a pill's words, or the loop gate. */
export function nodeName(draft: Pick<BoardDraft, 'agents' | 'inputs'>, id: string): string {
  const member = draft.agents.find((agent) => agent.member.id === id)?.member;
  if (member !== undefined) return memberLabel(member);
  const input = draft.inputs.find((each) => each.input.id === id)?.input;
  return input === undefined ? 'the loop gate' : inputName(input);
}

/** Words before which a problem's word is a plain word, not an id: `a lead line`, `the crew branch`, `Your prompt`. */
const PLAIN_AFTER = /(?:^|\s)(?:a|an|the|your|ticket's)\s$/i;

/**
 * A graph problem in the board's words, as a sentence: its members, pills and loop gates by name, not id. A word that
 * is also an id (`lead`, `review`) stays a word where the problem uses it as one.
 */
function inNames(message: string, draft: BoardDraft): string {
  const escape = (id: string) => id.replace(/[-]/g, '\\-');
  let text = message;
  for (const { gate } of draft.gates) text = text.replace(new RegExp(`loop gate ${escape(gate.id)}(?![\\w-])`, 'g'), 'the loop gate');
  const ids = [...draft.agents.map((agent) => agent.member.id), ...draft.inputs.map((each) => each.input.id), ...draft.gates.map((each) => each.gate.id)];
  const pattern = new RegExp(`(?<![\\w-])(?:${[...ids].sort((a, b) => b.length - a.length).map(escape).join('|')})(?![\\w-])`, 'g');
  if (ids.length > 0) text = text.replace(pattern, (id, at: number) => (PLAIN_AFTER.test(text.slice(0, at)) ? id : nodeName(draft, id)));
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}${/[.!?]$/.test(text) ? '' : '.'}`;
}

/**
 * The prefab the board saves as, each member's start and the round limit read from the graph, and what keeps the
 * library from taking it, in the order to fix it, each on what it is about: the graph's first problem as the library
 * would refuse it.
 */
export function boardPrefab(draft: BoardDraft): { prefab: CrewPrefab; problems: BoardProblem[] } {
  const { agents, lines, ...rest } = draft;
  const fields: Omit<typeof rest, 'inputs' | 'gates'> & { inputs?: unknown; gates?: unknown } = { ...rest };
  delete fields.inputs;
  delete fields.gates;
  const graph = { inputs: draft.inputs.map((each) => each.input), gates: draft.gates.map((each) => each.gate), lines };
  const members = agents.map(({ member }): PrefabMember => {
    const starts = startsOf(member.id, graph);
    return { ...member, starts, template: starts === 'prompt' ? member.template : null };
  });
  const roundLimit = graph.gates.length > 0 ? roundLimitOf(graph.gates) : fields.roundLimit;

  const problems: BoardProblem[] = [];
  const whole = (text: string) => problems.push({ text, about: null });
  const name = draft.name.trim();
  if (name === '') whole('Name the prefab.');
  if (name.length > MAX_PREFAB_NAME) whole(`A prefab's name is at most ${MAX_PREFAB_NAME} characters.`);
  if (agents.length === 0) whole('Add an agent.');
  if (agents.length > MAX_PREFAB_MEMBERS) whole(`A prefab has at most ${MAX_PREFAB_MEMBERS} agents.`);
  for (const { member } of agents) {
    const about = (text: string) => problems.push({ text, about: member.id });
    const starts = startsOf(member.id, graph);
    if (member.role !== null && member.role.trim() === '') about(`${memberLabel(member)}'s role needs a name.`);
    if (member.template !== null && member.template.trim() === '' && starts === 'prompt') about(`${memberLabel(member)}'s own prompt is empty: write it, or use the zone's.`);
    if (member.template !== null && member.template.trim() !== '' && starts !== 'prompt') {
      about(`${memberLabel(member)} has a prompt of its own, which only the agent your prompt starts keeps: clear it, or draw Your prompt to it.`);
    }
  }
  const wrong = agents.length === 0 ? null : graphProblem(members, graph, draft.onBoard);
  if (wrong !== null) problems.push({ text: inNames(wrong.message, draft), about: wrong.about });
  return { prefab: { ...fields, roundLimit, name, members, ...graph }, problems };
}

/** The board in words, as under it: where work comes from, who gets it, how each loop goes round, where it stops. */
export const boardSentence = (draft: BoardDraft): Words[] => graphSentence(boardGraph(draft));

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

/** A prefab's graph (its inputs, loop gates and lines), kept as it is, so saving an edit rebuilds only what its members changed. */
export function graphFields(prefab: Pick<CrewPrefab, 'inputs' | 'gates' | 'lines'>): Pick<CrewPrefab, 'inputs' | 'gates' | 'lines'> {
  const { inputs, gates, lines } = prefab;
  return inputs === undefined || gates === undefined || lines === undefined ? {} : { inputs, gates, lines };
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
    ...graphFields(prefab),
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
