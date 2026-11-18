// A crew prefab's graph: its members, inputs and loop gates, and the lines between them. Here is how a prefab of members
// that each say when they start (`starts`, a version 1 file) becomes a graph, and the `starts` and round limit the board
// runs a crew by, read back from a graph. Pure, so the app shares it; the checks a graph passes are `prefab-checks.ts`.
import {
  DEFAULT_PREFAB_ROUND_LIMIT,
  MAX_REVIEW_CAP,
  type CrewPrefab,
  type PrefabGate,
  type PrefabInput,
  REVIEWER_ROLES,
  defaultWorks,
  isMakerRole,
  type PrefabLine,
  type PrefabMember,
  type PrefabStart,
} from './protocol.ts';

/** A prefab's graph, apart from its members. */
export interface PrefabGraph {
  inputs: PrefabInput[];
  gates: PrefabGate[];
  lines: PrefabLine[];
}

/** When `member` starts, as the board runs a crew today: on a line from the prompt, by its lead, or else at the hand-off. */
export function startsOf(member: string, graph: PrefabGraph): PrefabStart {
  const prompts = new Set(graph.inputs.filter((input) => input.kind === 'prompt').map((input) => input.id));
  const into = graph.lines.filter((line) => line.to === member);
  if (into.some((line) => prompts.has(line.from))) return 'prompt';
  return into.some((line) => line.lead === true) ? 'lead' : 'handoff';
}

/** The round limit the board runs a crew by: its first loop gate's, all it has a place for. */
export function roundLimitOf(gates: readonly PrefabGate[]): number {
  const gate = gates[0];
  if (gate === undefined) return DEFAULT_PREFAB_ROUND_LIMIT;
  return Math.min(gate.rule === 'rounds' ? gate.rounds : (gate.cap ?? MAX_REVIEW_CAP), MAX_REVIEW_CAP);
}

/**
 * The graph of a prefab whose members say when they start (a version 1 file): a line from the prompt (and the ticket)
 * to each member that starts on it, a lead line to each its lead starts, and for reviewers at the hand-off, a line from
 * the builder to each and from each to one loop gate, with the round limit as its cap and no timeout, whose again line
 * goes back to the builder and whose done line goes to Ready. A crew without reviewers goes from its first member to Ready.
 */
export function graphFromStarts(prefab: Pick<CrewPrefab, 'members' | 'roundLimit' | 'onBoard'>): PrefabGraph {
  const taken = new Set(prefab.members.map((member) => member.id));
  const freeId = (base: string) => {
    let id = base;
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
    taken.add(id);
    return id;
  };
  const prompt = freeId('prompt');
  const ticket = prefab.onBoard === 'ticket' ? freeId('ticket') : null;
  const end = freeId('end');
  const firsts = prefab.members.filter((member) => member.starts === 'prompt');
  const first = firsts[0];
  const reviewers = prefab.members.filter((member) => member.starts === 'handoff');
  const lines: PrefabLine[] = [
    ...firsts.map((member) => ({ from: prompt, to: member.id })),
    ...(ticket === null ? [] : firsts.map((member) => ({ from: ticket, to: member.id }))),
    ...(first === undefined ? [] : prefab.members.filter((member) => member.starts === 'lead').map((member): PrefabLine => ({ from: first.id, to: member.id, lead: true }))),
  ];
  const gates: PrefabGate[] = [];
  if (first !== undefined && reviewers.length > 0) {
    const gate = freeId('loop');
    gates.push({ id: gate, rule: 'done', cap: prefab.roundLimit, atCap: 'ask', timeout: null });
    for (const reviewer of reviewers) lines.push({ from: first.id, to: reviewer.id, carries: 'handoff' });
    for (const reviewer of reviewers) lines.push({ from: reviewer.id, to: gate, carries: 'review' });
    lines.push({ from: gate, to: first.id, way: 'again' }, { from: gate, to: end, way: 'done' });
  } else if (first !== undefined) {
    lines.push({ from: first.id, to: end });
  }
  const inputs: PrefabInput[] = [{ id: prompt, kind: 'prompt' }, ...(ticket === null ? [] : [{ id: ticket, kind: 'ticket' as const }]), { id: end, kind: 'end', as: 'ready' }];
  return { inputs, gates, lines };
}

/**
 * `prefab`'s graph, as its file holds it. A prefab whose members' `starts` no longer match its lines (one built or
 * changed by when its members start, or with a member no line reaches) gets the graph those make; one whose round
 * limit alone changed gets it as its first loop gate's limit.
 */
export function graphOf(prefab: CrewPrefab): PrefabGraph {
  const { inputs, gates, lines } = prefab;
  if (inputs === undefined || gates === undefined || lines === undefined) return graphFromStarts(prefab);
  const graph = { inputs, gates, lines };
  const ids = new Set([...prefab.members.map((member) => member.id), ...inputs.map((input) => input.id), ...gates.map((gate) => gate.id)]);
  const stale =
    lines.some((line) => !ids.has(line.from) || !ids.has(line.to)) ||
    prefab.members.some((member) => !lines.some((line) => line.to === member.id) || startsOf(member.id, graph) !== member.starts);
  if (stale) return graphFromStarts(prefab);
  const [gate, ...rest] = gates;
  if (gate === undefined || roundLimitOf(gates) === prefab.roundLimit) return graph;
  return { ...graph, gates: [gate.rule === 'rounds' ? { ...gate, rounds: prefab.roundLimit } : { ...gate, cap: prefab.roundLimit }, ...rest] };
}

/**
 * The members that write on the crew branch: each that works there, but a reviewer (which writes only its review, on a
 * checkout of its own) and a member only a lead starts (which keeps a branch and worktree of its own).
 */
export function crewBranchWriters<M extends Omit<PrefabMember, 'starts'>>(members: readonly M[], lines: readonly PrefabLine[]): M[] {
  return members.filter((member) => (member.works ?? defaultWorks(member.role)) === 'crew' && !REVIEWER_ROLES.includes(member.role as never) && !leadOnly(member, lines));
}

/** The makers on branches of their own (ADR-0026): each implementer or spike that works on its own, but one only a lead starts. */
export function ownBranchMakers<M extends Omit<PrefabMember, 'starts'>>(members: readonly M[], lines: readonly PrefabLine[]): M[] {
  return members.filter((member) => isMakerRole(member.role) && (member.works ?? defaultWorks(member.role)) === 'own' && !leadOnly(member, lines));
}

/** Whether only a lead starts the member: it keeps a branch and worktree of its own, outside the crew's. */
function leadOnly(member: Omit<PrefabMember, 'starts'>, lines: readonly PrefabLine[]): boolean {
  const into = lines.filter((line) => line.to === member.id);
  return into.length > 0 && into.every((line) => line.lead === true);
}

/**
 * The non-makers that share the crew worktree, each writing only to its own paths: those writing on the crew branch
 * when two or more members write there, or beside two or more makers, whose merges land in the crew worktree too.
 */
export function crewWorktreeSharers<M extends Omit<PrefabMember, 'starts'>>(members: readonly M[], lines: readonly PrefabLine[]): M[] {
  const writers = crewBranchWriters(members, lines);
  const others = writers.filter((member) => !isMakerRole(member.role));
  return writers.length > 1 || (others.length > 0 && ownBranchMakers(members, lines).length > 1) ? others : [];
}

/**
 * The makers the board merges into the crew branch (ADR-0026): every maker on a branch of its own, when there are two
 * or more, or non-makers share the crew worktree beside one. None otherwise: a lone maker's branch is the crew's.
 */
export function crewMakers<M extends Omit<PrefabMember, 'starts'>>(members: readonly M[], lines: readonly PrefabLine[]): M[] {
  const makers = ownBranchMakers(members, lines);
  return makers.length > 1 || (makers.length > 0 && crewWorktreeSharers(members, lines).length > 0) ? makers : [];
}

/**
 * Why the board can't start a crew from `prefab` yet, or null when it can. It runs any graph of members, Your OKs,
 * loop gates and ends, non-makers sharing the crew worktree on paths of their own, but not yet a member's own work
 * folder, nor work that comes in from a queue, a ticket or a clock: a ticket tile's ticket reaches only the member the
 * prompt starts, as its chat.
 */
export function unrunnable(prefab: CrewPrefab): string | null {
  const later = 'which this version of agent-board does not run yet';
  for (const member of prefab.members) {
    if (member.works !== undefined) return `${member.id} has a works of its own, ${later}`;
  }
  const graph = graphOf(prefab);
  const prompted = new Set(graph.lines.filter((line) => graph.inputs.some((input) => input.id === line.from && input.kind === 'prompt')).map((line) => line.to));
  for (const input of graph.inputs) {
    if (input.kind !== 'queue' && input.kind !== 'ticket' && input.kind !== 'clock') continue;
    if (input.kind === 'ticket' && graph.lines.every((line) => line.from !== input.id || prompted.has(line.to))) continue;
    return `work comes in from ${input.kind === 'queue' ? 'a queue' : input.kind === 'clock' ? 'a clock' : 'a ticket to a member the prompt does not start'} (${input.id}), ${later}`;
  }
  return null;
}
