// A crew prefab as its flow editor draws and words it: where each piece of its diagram goes, the sentence under it,
// and what a draft still lacks before the library would take it. Pure, so the editor and its tests share it.
import {
  isOrchestratorRole,
  MAX_PREFAB_MEMBERS,
  REVIEWER_ROLES,
  type CrewPrefab,
  type Harness,
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
