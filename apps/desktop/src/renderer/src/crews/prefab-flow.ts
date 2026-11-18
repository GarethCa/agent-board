// A crew prefab as its flow editor draws and words it: where each piece of its diagram goes, the sentence under it,
// and what a draft still lacks before the library would take it. Pure, so the editor and its tests share it.
import {
  defaultWorks,
  isOrchestratorRole,
  MAX_PREFAB_MEMBERS,
  REVIEWER_ROLES,
  type CrewPrefab,
  type Harness,
  type PrefabGate,
  type PrefabInput,
  type PrefabInputKind,
  type PrefabLine,
  type PrefabMember,
} from '@agent-board/daemon/protocol';

/** How heavy a prefab runs, on its card: `no loop`, `lead decides`, `3 rounds`. */
export function prefabWeight(prefab: Pick<CrewPrefab, 'members' | 'roundLimit'>): string {
  if (prefab.members.length <= 1) return 'no loop';
  if (ledCrew(prefab)) return 'lead decides';
  return `${prefab.roundLimit} ${prefab.roundLimit === 1 ? 'round' : 'rounds'}`;
}

/** What a member does and when, as the prompt box lists it. */
export function memberRun(member: PrefabMember, prefab: Pick<CrewPrefab, 'members'>, technical = true): { does: string; detail: string; when: string } {
  const first = promptMember(prefab);
  if (member.starts === 'prompt') {
    if (isOrchestratorRole(member.role)) return { does: 'runs the crew', detail: 'Gets your prompt, then starts its crew.', when: 'starts now' };
    const detail = technical ? 'Gets your prompt, on a new branch in its own worktree.' : 'Gets your prompt, and works on its own copy of the code.';
    return { does: member.role === 'implementer' ? 'builds it' : 'works on it', detail, when: 'starts now' };
  }
  if (member.starts === 'lead') return { does: 'works for the lead', detail: 'Starts when the lead has work ready for it.', when: 'by the lead' };
  const after = first === undefined ? 'the hand-off' : `${memberLabel(first)} hands off`;
  return { does: 'reviews it', detail: 'Changes nothing. Replies with a review.', when: `after ${after}` };
}

/** The AI and model picker's value for a harness and model (null for its default): `claude:opus`, `codex:`. */
export const modelChoice = (harness: Harness, model: string | null): string => `${harness}:${model ?? ''}`;

/** A picker value read back: the harness before the first `:`, the model after it, colons and all (`…-v1:0`). */
export function readModelChoice(value: string): { harness: Harness; model: string | null } {
  const at = value.indexOf(':');
  const model = value.slice(at + 1);
  return { harness: value.slice(0, at) as Harness, model: model === '' ? null : model };
}

/** The longest name the library takes for a prefab. */
export const MAX_PREFAB_NAME = 48;

/** A member's name as the editor shows it: its own, else its id in words (`code-review` → `Code review`). */
export function memberLabel(member: Pick<PrefabMember, 'id' | 'name'>): string {
  if (member.name !== null && member.name.trim() !== '') return member.name.trim();
  const words = member.id.replace(/-/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Its model and reasoning, as under its bubble, leaving out what is its default: `opus · high`, `high`, `Its defaults`. */
export function memberModel(member: Pick<PrefabMember, 'model' | 'effort'>): string {
  const set = [member.model, member.effort].filter((part) => part !== null);
  return set.length === 0 ? 'Its defaults' : set.join(' · ');
}

const isReviewer = (member: PrefabMember) => REVIEWER_ROLES.includes(member.role as never);

/** The member that starts with the prompt, if exactly one does. */
export function promptMember(prefab: Pick<CrewPrefab, 'members'>): PrefabMember | undefined {
  const starting = prefab.members.filter((member) => member.starts === 'prompt');
  return starting.length === 1 ? starting[0] : undefined;
}

/**
 * Whether the crew has a lead, as the library reads it: the member on the prompt is an orchestrator (in any case), who
 * starts the others itself.
 */
const ledCrew = (prefab: Pick<CrewPrefab, 'members'>): boolean => {
  const first = promptMember(prefab);
  return first !== undefined && isOrchestratorRole(first.role);
};

/** One piece of the diagram, placed by its top-left corner. `add` is the dashed bubble that adds a member. */
export interface FlowNode {
  kind: 'member' | 'start' | 'decision' | 'end' | 'add';
  /** The member's id, for a member. */
  id: string | null;
  x: number;
  y: number;
}

/** A "who gets its work" arrow, as an SVG path, and whether it is the loop back (dashed). */
export interface FlowWire {
  d: string;
  loop: boolean;
  /** Where its arrowhead points: to the right, or up into the member it loops back to. */
  head: { x: number; y: number; dir: 'right' | 'up' } | null;
}

export interface FlowLabel {
  text: string;
  x: number;
  y: number;
  loop: boolean;
}

export interface FlowLayout {
  width: number;
  height: number;
  nodes: FlowNode[];
  wires: FlowWire[];
  labels: FlowLabel[];
  /** What the end pill says: the crew is ready to merge, or just done. */
  end: 'Ready' | 'Done' | null;
}

/** A member's box: its width and height, name and model included, and where its bubble's middle is from its top. */
export const NODE = { width: 124, height: 88, bubble: 22 } as const;
/** The stop: a 56px square turned, so this wide and tall, its middle half that. */
export const DECISION = 80;
const PILL = { height: 30 } as const;
const ROW = 96;
const TOP = 24;
const START_X = 14;
const FIRST_X = 136;
const LATER_X = 296;
/** Where an arrow ends short of a bubble's middle, and where one leaves it. */
const INTO = NODE.width / 2 - 30;
const OUT = NODE.width / 2 + 26;

const curve = (x1: number, y1: number, x2: number, y2: number) => {
  const mid = (x1 + x2) / 2;
  return `M${x1} ${y1} C${mid} ${y1} ${mid} ${y2} ${x2} ${y2}`;
};
const right = (x: number, y: number) => ({ x, y, dir: 'right' as const });

/**
 * The diagram of `prefab`: your prompt, the member it starts, then the members that start at its hand-off (stacked)
 * meeting at the stop ("All approve?") with the dashed loop back under them all, or, in a crew with a lead, the
 * members it starts. A dashed bubble after the last member adds one. A prefab with no member on the prompt draws its
 * members in a row, unwired.
 */
export function flowLayout(prefab: Pick<CrewPrefab, 'members' | 'roundLimit'>): FlowLayout {
  const first = promptMember(prefab);
  if (first === undefined) {
    const nodes = [...prefab.members.map((member) => member.id), null].map(
      (id, index): FlowNode => ({ kind: id === null ? 'add' : 'member', id, x: 24 + index * (NODE.width + 16), y: TOP }),
    );
    return { width: Math.max(560, 24 + nodes.length * (NODE.width + 16)), height: TOP + NODE.height + 32, nodes, wires: [], labels: [], end: null };
  }
  const led = ledCrew(prefab);
  const later = prefab.members.filter((member) => member !== first);
  const bubbleY = (top: number) => top + NODE.bubble;
  // Level with the middle of the members after it, bubble to bubble.
  const firstTop = TOP + (Math.max(0, later.length - 1) * ROW) / 2;
  const level = bubbleY(firstTop);
  const nodes: FlowNode[] = [
    { kind: 'start', id: null, x: START_X, y: level - PILL.height / 2 },
    { kind: 'member', id: first.id, x: FIRST_X, y: firstTop },
  ];
  const wires: FlowWire[] = [{ d: `M112 ${level} H${FIRST_X + INTO}`, loop: false, head: right(FIRST_X + INTO, level) }];
  const labels: FlowLabel[] = [];
  const out = { x: FIRST_X + OUT, y: level };

  if (later.length === 0) {
    // On its own it goes straight to Done; the bubble that adds a reviewer sits under it.
    const endX = FIRST_X + NODE.width + 40;
    const addTop = firstTop + NODE.height + 12;
    // A lead with no crew yet: only the bubble that adds the first member it starts.
    if (led) {
      nodes.push({ kind: 'add', id: null, x: LATER_X, y: firstTop });
      return { width: LATER_X + NODE.width + 40, height: firstTop + NODE.height + 32, nodes, wires, labels, end: null };
    }
    nodes.push({ kind: 'end', id: null, x: endX, y: level - PILL.height / 2 });
    nodes.push({ kind: 'add', id: null, x: FIRST_X, y: addTop });
    wires.push({ d: `M${out.x} ${out.y} H${endX - 8}`, loop: false, head: right(endX - 8, level) });
    return { width: endX + 160, height: addTop + NODE.height + 16, nodes, wires, labels, end: 'Done' };
  }

  later.forEach((member, index) => {
    const top = TOP + index * ROW;
    nodes.push({ kind: 'member', id: member.id, x: LATER_X, y: top });
    wires.push({ d: curve(out.x, out.y, LATER_X + INTO, bubbleY(top)), loop: false, head: right(LATER_X + INTO, bubbleY(top)) });
  });
  const lastBottom = TOP + (later.length - 1) * ROW + NODE.height;
  // The dashed bubble that adds one more, under the last.
  const addTop = lastBottom + 16;
  nodes.push({ kind: 'add', id: null, x: LATER_X, y: addTop });
  // On the wire, as it leaves the member with the prompt.
  labels.push({ text: led ? 'starts' : 'handover', x: out.x + 6, y: level - 24, loop: false });

  if (led) {
    const below = addTop + NODE.height;
    labels.push({ text: `The lead runs its own rounds · up to ${prefab.roundLimit}`, x: FIRST_X - 10, y: Math.max(below, firstTop + NODE.height) + 8, loop: true });
    return { width: LATER_X + NODE.width + 200, height: Math.max(below, firstTop + NODE.height) + 40, nodes, wires, labels, end: null };
  }

  const stop = { x: LATER_X + NODE.width + 88, y: level };
  const half = DECISION / 2;
  nodes.push({ kind: 'decision', id: null, x: stop.x - half, y: stop.y - half });
  later.forEach((_member, index) => {
    const from = { x: LATER_X + OUT, y: bubbleY(TOP + index * ROW) };
    wires.push({ d: curve(from.x, from.y, stop.x - half, stop.y), loop: false, head: index === later.length - 1 ? right(stop.x - half, stop.y) : null });
  });
  const endX = stop.x + half + 20;
  nodes.push({ kind: 'end', id: null, x: endX, y: stop.y - PILL.height / 2 });
  wires.push({ d: `M${stop.x + half} ${stop.y} H${endX - 8}`, loop: false, head: right(endX - 8, stop.y) });
  // The loop back runs square, under every member and its name, then up into the member with the prompt.
  const loopY = Math.max(addTop + NODE.height, firstTop + NODE.height) + 18;
  const backX = FIRST_X + NODE.width / 2;
  const turn = 10;
  const into = firstTop + NODE.height + 4;
  wires.push({
    d: `M${stop.x} ${stop.y + half} V${loopY - turn} Q${stop.x} ${loopY} ${stop.x - turn} ${loopY} H${backX + turn} Q${backX} ${loopY} ${backX} ${loopY - turn} V${into + 6}`,
    loop: true,
    head: { x: backX, y: into, dir: 'up' },
  });
  labels.push({ text: `No: reviews go back · next round · up to ${prefab.roundLimit}`, x: backX + 24, y: loopY + 6, loop: true });
  return { width: endX + 88, height: loopY + 36, nodes, wires, labels, end: 'Ready' };
}

/** A run of the sentence: plain, or in bold. */
export interface Words {
  text: string;
  bold?: boolean;
}

/** Names joined as prose: `A`, `A and B`, `A, B and C`. */
const listed = (names: string[]): Words[] =>
  names.flatMap((name, index): Words[] => [
    ...(index === 0 ? [] : [{ text: index === names.length - 1 ? ' and ' : ', ' }]),
    { text: name, bold: true },
  ]);

/** What the member with the prompt does with it, by its role. */
const works = (member: PrefabMember) => (member.role === 'implementer' ? 'builds' : isOrchestratorRole(member.role) ? 'leads' : 'works');

/** The diagram in words, as under it: who starts, who gets whose work, and when the crew stops. */
export function flowSentence(prefab: Pick<CrewPrefab, 'members' | 'roundLimit'>): Words[] {
  const first = promptMember(prefab);
  if (first === undefined) return [{ text: 'Choose the member that starts with your prompt.' }];
  const name = memberLabel(first);
  const later = prefab.members.filter((member) => member !== first).map(memberLabel);
  const rounds = `up to ${prefab.roundLimit} ${prefab.roundLimit === 1 ? 'round' : 'rounds'}`;
  if (later.length === 0 && !ledCrew(prefab)) return [{ text: name, bold: true }, { text: ` ${works(first)} from your prompt, on its own. No one reviews its work.` }];
  if (ledCrew(prefab)) {
    if (later.length === 0) return [{ text: name, bold: true }, { text: ' leads from your prompt. Add the members it starts.' }];
    return [
      { text: name, bold: true },
      { text: ' leads from your prompt, starting ' },
      ...listed(later),
      { text: ' when their work is ready, for ' },
      { text: `${rounds} of review`, bold: true },
      { text: '. Anyone who needs you pauses it.' },
    ];
  }
  const agree = later.length === 1 ? 'If it approves' : later.length === 2 ? 'If both approve' : 'If all approve';
  return [
    { text: name, bold: true },
    { text: ` ${works(first)} from your prompt. When it hands off, ` },
    ...listed(later),
    { text: ` ${later.length === 1 ? 'reviews' : 'review'} it${later.length === 1 ? '' : ' at once'}. ${agree}, the crew stops: ` },
    { text: 'ready to merge', bold: true },
    { text: `. If not, ${later.length === 1 ? 'its review goes' : 'their reviews go'} back to ${name} for the next round, ` },
    { text: rounds, bold: true },
    { text: '. Anyone who needs you pauses it.' },
  ];
}

/** A member to add to `prefab`: a reviewer at the hand-off, or in a crew with a lead, one more for the lead to start. */
export function newMember(prefab: Pick<CrewPrefab, 'members'>): PrefabMember {
  const taken = new Set(prefab.members.map((member) => member.id));
  let n = prefab.members.length + 1;
  while (taken.has(`member-${n}`)) n += 1;
  const led = ledCrew(prefab);
  const first = promptMember(prefab) === undefined;
  return {
    id: `member-${n}`,
    role: first ? 'implementer' : led ? 'implementer' : 'reviewer',
    name: null,
    harness: 'claude',
    model: null,
    effort: null,
    template: null,
    starts: first ? 'prompt' : led ? 'lead' : 'handoff',
    subagents: [],
  };
}

/**
 * What the draft still lacks before the library would take it, in the order to fix it: its name, one member on the
 * prompt, and each member's start matching its role. The library checks the rest when it is saved.
 */
export function draftProblems(prefab: Pick<CrewPrefab, 'name' | 'members'>): string[] {
  const problems: string[] = [];
  if (prefab.name.trim() === '') problems.push('Name the prefab.');
  if (prefab.name.trim().length > MAX_PREFAB_NAME) problems.push(`A prefab's name is at most ${MAX_PREFAB_NAME} characters.`);
  if (prefab.members.length === 0) problems.push('Add a member.');
  if (prefab.members.length > MAX_PREFAB_MEMBERS) problems.push(`A prefab has at most ${MAX_PREFAB_MEMBERS} members.`);
  const starting = prefab.members.filter((member) => member.starts === 'prompt');
  if (prefab.members.length > 0 && starting.length !== 1) problems.push('Exactly one member starts with your prompt.');
  const first = starting.length === 1 ? starting[0]! : undefined;
  const led = ledCrew(prefab);
  for (const member of prefab.members) {
    if (member.role !== null && member.role.trim() === '') problems.push(`${memberLabel(member)}'s role needs a name.`);
    if (member.template !== null && member.template.trim() === '') problems.push(`${memberLabel(member)}'s own template is empty: write it, or use the zone's.`);
    if (member.starts === 'handoff' && led) problems.push(`${memberLabel(member)} starts after a hand-off, but in a crew with a lead the lead starts its members.`);
    else if (member.starts === 'handoff' && !isReviewer(member)) problems.push(`${memberLabel(member)} starts after a hand-off, so it is a reviewer or follow-up reviewer.`);
    if (member.starts === 'lead' && first !== undefined && !led) problems.push(`${memberLabel(member)} is started by the lead, so ${memberLabel(first)} is an orchestrator.`);
  }
  return problems;
}

/** A prefab as its board draws it: its members, and the graph of inputs, loop gates and lines between them. */
export type GraphPrefab = Pick<CrewPrefab, 'members'> & { inputs: PrefabInput[]; gates: PrefabGate[]; lines: PrefabLine[] };

/** The inputs work comes from, and their names in the sentence. */
export const SOURCE_NAMES: Partial<Record<PrefabInputKind, string>> = { prompt: 'Your prompt', queue: 'The queue', ticket: 'The ticket', clock: 'The clock' };

const each = (count: number) => (count === 2 ? 'both' : 'all');

/** A loop gate's rule, as on its chip: `until both approve · max 5`, `until done · no limit`, `3 rounds`. */
export function gateRule(gate: PrefabGate, deciders: readonly Pick<PrefabMember, 'role'>[]): string {
  if (gate.rule === 'rounds') return `${gate.rounds} ${gate.rounds === 1 ? 'round' : 'rounds'}`;
  const reviewers = deciders.length > 0 && deciders.every((decider) => REVIEWER_ROLES.includes(decider.role as never));
  const until = !reviewers ? 'until done' : deciders.length === 1 ? 'until it approves' : `until ${each(deciders.length)} approve`;
  return `${until} · ${gate.cap === null ? 'no limit' : `max ${gate.cap}`}`;
}

/** What a member does when more than one line brings it work, as under its tile; null for one line or none. */
export function joinBadge(member: Pick<PrefabMember, 'join' | 'timeout'>, linesIn: number): string | null {
  if (linesIn < 2) return null;
  if (member.join === 'each') return 'each as it comes';
  return `waits for ${each(linesIn)}${member.timeout === undefined ? '' : ` · ${member.timeout} min`}`;
}

/**
 * What a loop gate waits for, as on the badge under its diamond: `waits for both · 30 min`, `waits for all 3`, `waits
 * 30 min` for one decider with a timeout. Null when it waits for one, with no timeout, as there is nothing to say.
 */
export function gateWait(gate: Pick<PrefabGate, 'timeout'>, deciders: number): string | null {
  if (deciders < 2 && gate.timeout === null) return null;
  const late = gate.timeout === null ? '' : `${gate.timeout} min`;
  if (deciders < 2) return `waits ${late}`;
  return `waits for ${deciders === 2 ? 'both' : `all ${deciders}`}${late === '' ? '' : ` · ${late}`}`;
}

export interface Size {
  width: number;
  height: number;
}

/** Where each node of a graph goes, by its top-left corner and its size. */
export type GraphPlaces = Map<string, Size & { x: number; y: number }>;

/**
 * A graph laid out left to right: each node in the column of the longest way to it from a node nothing leads to, the
 * loop gates' again lines left out (and any other line back round a loop); the nodes of a column one above the other,
 * every column centred on one middle.
 */
export function graphLayout(prefab: GraphPrefab, sizes: { member: Size; input: Size; gate: Size; end?: Size }, spacing: { gap: number; row: number }): GraphPlaces {
  const nodes = [
    ...prefab.inputs.filter((input) => input.kind !== 'end').map((input) => ({ id: input.id, size: sizes.input })),
    ...prefab.members.map((member) => ({ id: member.id, size: sizes.member })),
    ...prefab.gates.map((gate) => ({ id: gate.id, size: sizes.gate })),
    ...prefab.inputs.filter((input) => input.kind === 'end').map((input) => ({ id: input.id, size: sizes.end ?? sizes.input })),
  ];
  const ids = new Set(nodes.map((node) => node.id));
  const forward = prefab.lines.filter((line) => line.way !== 'again' && ids.has(line.from) && ids.has(line.to));
  const depths = new Map<string, number>();
  const walking = new Set<string>();
  const depth = (id: string): number => {
    const known = depths.get(id);
    if (known !== undefined) return known;
    walking.add(id);
    let most = 0;
    for (const line of forward) if (line.to === id && !walking.has(line.from)) most = Math.max(most, depth(line.from) + 1);
    walking.delete(id);
    depths.set(id, most);
    return most;
  };
  const columns: (typeof nodes)[] = [];
  for (const node of nodes) (columns[depth(node.id)] ??= []).push(node);
  const places: GraphPlaces = new Map();
  const tallest = Math.max(...columns.map((column = []) => column.reduce((sum, node) => sum + node.size.height, 0) + spacing.row * (column.length - 1)));
  let x = 0;
  for (const column of columns) {
    if (column === undefined) continue;
    let y = (tallest - (column.reduce((sum, node) => sum + node.size.height, 0) + spacing.row * (column.length - 1))) / 2;
    for (const node of column) {
      places.set(node.id, { x, y, ...node.size });
      y += node.size.height + spacing.row;
    }
    x += Math.max(...column.map((node) => node.size.width)) + spacing.gap;
  }
  return places;
}

/**
 * The branch a member works on, as its tile and the sentence say it: its own or the crew's, from its role when it sets
 * none. Only where more than one member of the crew writes, so where each works matters; never a reviewer's, which
 * writes only its review, nor a lead's, which runs the crew.
 */
export function memberBranch(members: readonly PrefabMember[], id: string): 'own' | 'crew' | null {
  const writers = members.filter((member) => !isReviewer(member) && !isOrchestratorRole(member.role));
  const member = writers.find((each) => each.id === id);
  if (member === undefined || writers.length < 2) return null;
  return member.works ?? defaultWorks(member.role);
}

const unique = <T>(items: readonly T[]): T[] => [...new Set(items)];

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** The graph in words, as under the board: where work comes from, who gets it, how each loop goes round, where it stops. */
export function graphSentence(prefab: GraphPrefab): Words[] {
  const members = new Map(prefab.members.map((member) => [member.id, member]));
  const inputs = new Map(prefab.inputs.map((input) => [input.id, input]));
  const gates = new Map(prefab.gates.map((gate) => [gate.id, gate]));
  const name = (id: string) => memberLabel(members.get(id)!);
  const out = (id: string) => prefab.lines.filter((line) => line.from === id && line.way !== 'again');
  const into = (id: string) => prefab.lines.filter((line) => line.to === id);
  const sources = prefab.inputs.filter((input) => SOURCE_NAMES[input.kind] !== undefined && out(input.id).length > 0);
  if (sources.length === 0) return [{ text: 'Draw a line from Your prompt to the agent that starts.' }];
  const words: Words[] = [];
  const say = (...more: (Words | string)[]) => words.push(...more.map((each) => (typeof each === 'string' ? { text: each } : each)));
  const said = new Set<string>();
  // The one member the sentence just named, so `Its work` can only mean it; any other member's work is said by name.
  let subject: string | null = null;
  // What a member with more than one line in does with them, as its join badge says it: `, which waits for both, or 20 minutes`.
  // Each member's join is said once, the first time the sentence reaches it.
  const joined = new Set<string>();
  // `waits for both, or 20 minutes`, or '' when it has no join to say.
  const joinOf = (id: string) => {
    const member = members.get(id)!;
    const count = into(id).filter((line) => line.way !== 'again').length;
    if (count < 2 || joined.has(id)) return '';
    joined.add(id);
    if (member.join === 'each') return 'takes each as it comes';
    return `waits for ${each(count)}${member.timeout === undefined ? '' : `, or ${member.timeout} minutes`}`;
  };
  const joins = (id: string) => {
    const join = joinOf(id);
    return join === '' ? '' : `, which ${join}`;
  };
  // Work that goes to more than one member says each one's join as a sentence of its own: `Review waits for both.`
  // Only once every member with a line in is said: until then a later line says it, after the lines it waits for.
  const joinSentences = (ids: readonly string[]) => {
    for (const id of ids) {
      const pending = into(id).some((line) => line.way !== 'again' && members.has(line.from) && !said.has(line.from));
      if (pending) continue;
      const join = joinOf(id);
      if (join !== '') say(' ', { text: capital(name(id)), bold: true }, ` ${join}.`);
    }
  };
  // Where the crew stops, each end once, said last of all, after every agent's work.
  const stops: Extract<PrefabInput, { kind: 'end' }>[] = [];
  // `also`: the source that reaches it goes to an agent too and named the OK in its opening line, so the crew doesn't
  // wait for it after that agent: what comes after the OK is said, if anything but the end.
  const reach = (id: string, also = false) => {
    const input = inputs.get(id);
    if (input === undefined || said.has(id)) return;
    said.add(id);
    if (input.kind === 'user') {
      // Members already said, by another line in, are said again only as going on from the OK too.
      const again = out(input.id).map((line) => line.to).filter((to) => members.has(to) && said.has(to));
      const next = out(input.id).filter((line) => !again.includes(line.to));
      if (!also) say(' Then the crew ', { text: 'waits for your OK', bold: true }, '.');
      else if (next.some((line) => inputs.get(line.to)?.kind !== 'end')) say(' After ', { text: 'your OK', bold: true }, ',');
      for (const line of next) gets(line.to, true);
      if (again.length > 0) say(' ', { text: 'Your OK', bold: true }, ' goes on to ', ...listed(again.map(name)), ' too.');
    }
    if (input.kind === 'end') stops.push(input);
  };
  const ends = (id: string) => {
    for (const line of out(id)) reach(line.to);
  };
  // `past`: it is reached past your OK, where no `work goes to` line has said its join yet.
  const gets = (id: string, past = false) => {
    if (gates.has(id)) return;
    if (!members.has(id)) {
      reach(id);
      return;
    }
    if (said.has(id)) return;
    const branch = memberBranch(prefab.members, id);
    const join = past ? joins(id) : '';
    say(' ', { text: capital(name(id)), bold: true }, ` gets it${join}${branch === null ? '' : `${join === '' ? '' : ','} and works on ${branch === 'own' ? 'its own branch' : 'the crew branch'}`}.`);
    subject = id;
    follow(id);
  };
  const loop = (gateId: string) => {
    const gate = gates.get(gateId)!;
    said.add(gateId);
    const deciders = into(gateId).map((line) => line.from).filter((id) => members.has(id));
    const waits = gate.timeout === null ? '' : deciders.length > 1 ? `waits for ${each(deciders.length)}, or ${gate.timeout} minutes, and ` : deciders.length === 1 ? `waits ${gate.timeout} minutes for it, and ` : '';
    if (gate.rule === 'rounds') say(`; the loop gate ${waits}sends it round again, ${gate.rounds} ${gate.rounds === 1 ? 'round' : 'rounds'} in all.`);
    else {
      const until = deciders.length === 1 ? `${name(deciders[0]!)} says done` : `${each(deciders.length)} approve`;
      say(`; the loop gate ${waits}sends it back until ${until}, ${gate.cap === null ? 'with no limit' : `at most ${gate.cap} ${gate.cap === 1 ? 'round' : 'rounds'}`}.`);
    }
    for (const line of out(gateId)) gets(line.to);
  };
  const follow = (id: string) => {
    if (said.has(id)) return;
    said.add(id);
    walk([id]);
  };
  // What members' work does, once they are said: where it goes, the loop they decide, whom they lead, where it ends.
  // Several makers whose work all goes to the same place are said together, so their reviewer is said once.
  const walk = (ids: readonly string[]) => {
    const lines = ids.flatMap(out);
    const who = (): Words[] => (ids.length === 1 ? [{ text: name(ids[0]!), bold: true }] : listed(ids.map(name)));
    const led = unique(lines.filter((line) => line.lead === true && members.has(line.to)).map((line) => line.to));
    if (led.length > 0) {
      say(' ', ...who(), ids.length === 1 ? ' starts ' : ' start ', ...listed(led.map(name)), ' when it needs them.');
      subject = ids.length === 1 ? ids[0]! : null;
    }
    const work = unique(lines.filter((line) => line.lead !== true && members.has(line.to)).map((line) => line.to));
    const gate = [...ids, ...work].flatMap((each) => out(each)).find((line) => gates.has(line.to) && !said.has(line.to))?.to;
    if (work.length > 0) {
      const whose = ids.length > 1 ? [' Their work goes to '] : subject === ids[0] ? [' Its work goes to '] : [' ', { text: capital(name(ids[0]!)), bold: true }, `${name(ids[0]!).endsWith('s') ? "'" : "'s"} work goes to `];
      subject = work.length === 1 ? work[0]! : null;
      say(...whose, ...listed(work.map(name)), work.length === 1 ? joins(work[0]!) : '');
      if (gate === undefined) say('.');
      else {
        const fresh = work.filter((each) => !said.has(each));
        fresh.forEach((each) => said.add(each));
        loop(gate);
        // The deciders are said, so the loop doesn't name them again; their other lines still are.
        for (const each of fresh) walk([each]);
      }
      if (work.length > 1) joinSentences(work);
      for (const each of work) follow(each);
    } else if (gate !== undefined) {
      say(' ', ...who(), ids.length === 1 ? ' decides' : ' decide');
      loop(gate);
    }
    for (const each of led) follow(each);
    for (const each of ids) ends(each);
  };
  // Members a source starts together, whose work all goes on to the same place and none of whom leads.
  const together = (ids: readonly string[]) => {
    if (ids.length < 2 || ids.some((id) => said.has(id))) return false;
    const onward = (id: string) => out(id).filter((line) => line.lead !== true).map((line) => line.to).sort().join(' ');
    return ids.every((id) => out(id).every((line) => line.lead !== true) && onward(id) !== '' && onward(id) === onward(ids[0]!));
  };
  for (const source of sources) {
    const to = out(source.id).map((line) => line.to).filter((id) => members.has(id));
    const branches = unique(to.map((id) => memberBranch(prefab.members, id)));
    const branch = to.length > 0 && branches.length === 1 ? branches[0]! : null;
    const only = branch === null ? '' : branch === 'crew' ? ' on the crew branch' : to.length === 1 ? ' on its own branch' : ' each on its own branch';
    // Work that goes first to a pill (your OK, an end) starts there: the pill says what comes next.
    if (to.length === 0) say(' ', { text: SOURCE_NAMES[source.kind]!, bold: true }, ' starts it.');
    else {
      // Its pills too, but for the end, which is said last.
      const asks = out(source.id).some((line) => inputs.get(line.to)?.kind === 'user');
      say(' ', { text: SOURCE_NAMES[source.kind]!, bold: true }, ' goes to ', ...listed(to.map(name)), only === '' ? '' : `,${only}`);
      subject = to.length === 1 ? to[0]! : null;
      say(...(asks ? [', and to ', { text: 'your OK', bold: true }, '.'] : ['.']));
    }
  }
  for (const source of sources) {
    const to = out(source.id).map((line) => line.to).filter((id) => members.has(id));
    if (together(to)) {
      to.forEach((id) => said.add(id));
      walk(to);
    }
    // Its agents' work, then what comes after your OK straight from the source; the ends wait for the last word.
    for (const id of to) follow(id);
    for (const line of out(source.id)) if (!members.has(line.to)) reach(line.to, to.length > 0);
  }
  // Agents whose work goes nowhere yet, as the board is being drawn; not a lead's, nor one only a lead starts.
  const stuck = prefab.members
    .filter((member) => said.has(member.id) && out(member.id).length === 0 && !isOrchestratorRole(member.role))
    .filter((member) => into(member.id).some((line) => line.lead !== true))
    .map((member) => member.id);
  if (stuck.length > 0) say(' Nothing goes on from ', ...listed(stuck.map(name)), ' yet.');
  for (const end of stops) say(' Then it stops, ', { text: end.as === 'ready' ? 'ready to merge' : 'done', bold: true }, '.');
  words[0] = { ...words[0]!, text: words[0]!.text.trimStart() };
  return words.filter((each) => each.text !== '');
}
