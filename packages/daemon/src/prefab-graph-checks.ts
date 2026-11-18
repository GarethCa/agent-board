// The checks a crew prefab's graph passes, as its `.crew.json` file is read and as the prefab's board draws it: the first
// problem, in words a person who wrote the file by hand can act on, and what it is about (a member, input or loop gate
// by its id, or a line by `lineKey`), so the board can show it there. Pure, so the app shares it; `prefab-checks.ts`
// throws it as an RPC error.
import { isMakerRole, isOrchestratorRole, type CrewPrefab, type PrefabInput, type PrefabLine, type PrefabMember } from './protocol.ts';
import { crewBranchWriters, crewWorktreeSharers, type PrefabGraph } from './prefab-graph.ts';
import { writesPathsOverlap } from './prefab-paths.ts';

/** What is wrong with a graph, and the id of what it is about: a member, input or loop gate, a line's `lineKey`, or null for the whole. */
export interface PrefabGraphProblem {
  message: string;
  about: string | null;
}

/** A line's key, as a problem names it: `from>to`, which no id holds. */
export const lineKey = (line: Pick<PrefabLine, 'from' | 'to'>): string => `${line.from}>${line.to}`;

// No parameter properties: the CLI runs this file with its types stripped.
class Problem extends Error {
  readonly about: string | null;
  constructor(message: string, about: string | null) {
    super(message);
    this.about = about;
  }
}

/** The inputs work comes from: every member is reached from one of these. */
const SOURCES: readonly PrefabInput['kind'][] = ['prompt', 'queue', 'ticket', 'clock'];

type Member = Omit<PrefabMember, 'starts'>;

const arrow = (line: PrefabLine) => `the line ${line.from} → ${line.to}`;

/** The ids reachable from `starts` along `lines`, leaving out any line `skip` says to. */
function reachable(starts: Iterable<string>, lines: readonly PrefabLine[], skip: (line: PrefabLine) => boolean = () => false): Set<string> {
  const seen = new Set(starts);
  const queue = [...seen];
  for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
    for (const line of lines) {
      if (line.from !== id || skip(line) || seen.has(line.to)) continue;
      seen.add(line.to);
      queue.push(line.to);
    }
  }
  return seen;
}

/** A member as the board names it: its tile's name, or else its id. */
const label = (members: readonly Member[], id: string) => members.find((member) => member.id === id)?.name ?? id;

/** A loop gate in the board's words, which show no gate id: the crew's one loop gate, or the one after its deciders. */
function gateLabel(members: readonly Member[], graph: PrefabGraph, gate: string) {
  if (graph.gates.length === 1) return 'the loop gate';
  const deciders = graph.lines.filter((line) => line.to === gate).map((line) => label(members, line.from));
  return `the loop gate after ${deciders.join(' and ')}`;
}

const endless = 'so approved work would go round forever: draw it to an end, or to a member after the loop that goes on to one';

/** Refuses a line whose ends don't exist, or that joins things no line may join. */
function checkLines(members: readonly Member[], graph: PrefabGraph, onBoard: CrewPrefab['onBoard']) {
  const roles = new Map(members.map((member) => [member.id, member.role]));
  const inputs = new Map(graph.inputs.map((input) => [input.id, input]));
  const gates = new Set(graph.gates.map((gate) => gate.id));
  const kind = (id: string) => (roles.has(id) ? 'member' : gates.has(id) ? 'gate' : inputs.get(id)?.kind);
  // A ticket's chat leads as an orchestrator does: the member the ticket's prompt goes to.
  const chats = new Set(onBoard === 'ticket' ? graph.lines.filter((line) => inputs.get(line.from)?.kind === 'prompt').map((line) => line.to) : []);
  const seen = new Set<string>();
  for (const line of graph.lines) {
    const refuse = (message: string) => new Problem(message, lineKey(line));
    for (const end of [line.from, line.to]) if (kind(end) === undefined) throw refuse(`${arrow(line)}: the prefab has no ${end}`);
    if (line.from === line.to) throw refuse(`${arrow(line)} goes nowhere: a line joins two different things`);
    const key = `${line.from}\n${line.to}`;
    if (seen.has(key)) {
      // The again line already goes to the loop's head, so a done line drawn there too sends approved work round again.
      const ways = graph.lines.filter((other) => other.from === line.from && other.to === line.to).map((other) => other.way);
      if (ways.includes('again') && ways.includes('done')) throw refuse(`${gateLabel(members, graph, line.from)}'s done line goes back into ${label(members, line.to)}, the loop's head, ${endless}`);
      throw refuse(`two lines go ${line.from} → ${line.to}`);
    }
    seen.add(key);
    const from = kind(line.from)!;
    const to = kind(line.to)!;
    if (from === 'end') throw refuse(`${arrow(line)}: ${line.from} is an end, which no line leaves`);
    if (SOURCES.includes(to as never)) throw refuse(`${arrow(line)}: ${line.to} is where work comes from, so no line goes into it`);
    if (from === 'gate' && line.way === undefined) throw refuse(`${arrow(line)} leaves a loop gate, so it is the gate's again or done way`);
    if (from !== 'gate' && line.way !== undefined) throw refuse(`${arrow(line)}: only a line out of a loop gate has a way, again or done`);
    if (to === 'gate' && from !== 'member') throw refuse(`${arrow(line)}: every line into a loop gate comes from a member, one of its deciders`);
    if (line.carries !== undefined && from !== 'member') throw refuse(`${arrow(line)}: only a member's line carries a hand-off or a review`);
    if (line.lead === true) {
      if (from !== 'member' || !(isOrchestratorRole(roles.get(line.from)!) || chats.has(line.from))) {
        throw refuse(`${arrow(line)} is a lead line, so ${line.from} is an orchestrator or the ticket's chat`);
      }
      if (to !== 'member') throw refuse(`${arrow(line)} is a lead line, so it goes to a member the lead starts`);
      if (line.carries !== undefined) throw refuse(`${arrow(line)} is a lead line, which starts a member and carries nothing`);
    }
  }
}

/**
 * Refuses a loop gate without one again line closing its loop back through its deciders, or without a done line out of
 * that loop.
 */
function checkGates(members: readonly Member[], graph: PrefabGraph) {
  const isMember = new Set(members.map((member) => member.id));
  for (const gate of graph.gates) {
    const refuse = (message: string) => new Problem(message, gate.id);
    const out = graph.lines.filter((line) => line.from === gate.id);
    const again = out.filter((line) => line.way === 'again');
    if (again.length !== 1) throw refuse(`loop gate ${gate.id} has one again line, back to the loop's head; it has ${again.length}`);
    const head = again[0]!.to;
    if (!isMember.has(head)) throw refuse(`loop gate ${gate.id}'s again line goes back to a member, the loop's head`);
    if (!out.some((line) => line.way === 'done')) throw refuse(`loop gate ${gate.id} has at least one done line, where work goes on`);
    const deciders = graph.lines.filter((line) => line.to === gate.id).map((line) => line.from);
    if (deciders.length === 0) throw refuse(`loop gate ${gate.id} has no deciders: draw a line into it from each member that decides`);
    const looped = reachable([head], graph.lines, (line) => line.from === gate.id);
    const outside = deciders.find((decider) => !looped.has(decider));
    if (outside !== undefined) {
      throw refuse(`loop gate ${gate.id}'s again line goes to ${head}, but ${outside} isn't after it: the again line closes a loop back through the gate's deciders`);
    }
    // From each done target, work goes on along every line, through other loop gates by their done ways (their again
    // ways close loops of their own), until it stops at an end. Reaching this gate again, it never leaves.
    const againOfOthers = (line: PrefabLine) => line.way === 'again' && line.from !== gate.id;
    const leadsBack = reachable([gate.id], graph.lines.filter((line) => !againOfOthers(line) && line.from !== gate.id).map((line) => ({ ...line, from: line.to, to: line.from })));
    for (const done of out.filter((line) => line.way === 'done')) {
      const onward = reachable([done.to], graph.lines, (line) => againOfOthers(line) || line.from === gate.id);
      if (!onward.has(gate.id)) continue;
      // Only a member lines into a gate, so the walk passed a decider: the first member of the loop it met is named.
      const into = [...onward].find((id) => looped.has(id) && leadsBack.has(id))!;
      const goes = into === done.to ? `goes back into ${label(members, into)}, inside its own loop` : `goes to ${label(members, done.to)}, which leads back into ${label(members, into)}`;
      throw new Problem(`${gateLabel(members, graph, gate.id)}'s done line ${goes}, ${endless}`, lineKey(done));
    }
  }
}

/** Refuses a member no input reaches, and a crew with no end unless a clock or a queue runs it. */
function checkReach(members: readonly Member[], graph: PrefabGraph) {
  const sources = graph.inputs.filter((input) => SOURCES.includes(input.kind)).map((input) => input.id);
  const reached = reachable(sources, graph.lines);
  const lost = members.find((member) => !reached.has(member.id));
  if (lost !== undefined) throw new Problem(`${lost.id} is reached from no input: draw a line to it from Your prompt, or from a member before it`, lost.id);
  const ends = new Set(graph.inputs.filter((input) => input.kind === 'end').map((input) => input.id));
  const runs = graph.inputs.some((input) => input.kind === 'clock' || input.kind === 'queue');
  if (!runs && !graph.lines.some((line) => ends.has(line.to))) {
    throw new Problem('no line reaches an end: draw one to Ready or Done, so the crew knows when it is finished', [...ends][0] ?? null);
  }
}

/** Refuses a branch a member's role can't have, and paths of its own that are missing, misplaced or overlap another's. */
function checkBranches(members: readonly Member[], graph: PrefabGraph) {
  const ownless = members.find((member) => member.works === 'own' && !isMakerRole(member.role));
  if (ownless !== undefined) {
    throw new Problem(`${ownless.id} works on a branch of its own, but only a maker (an implementer or a spike) has one: leave works out, or make it crew`, ownless.id);
  }
  const writers = crewBranchWriters(members, graph.lines);
  const shared = writers.length > 1;
  const others = (member: Member) => writers.filter((each) => each !== member).map((each) => each.id).join(', ');
  const maker = writers.find((member) => isMakerRole(member.role));
  if (shared && maker !== undefined) {
    throw new Problem(`${maker.id} works on the crew branch, but ${others(maker)} writes there too: a maker shares the crew branch only when no other member writes on it`, maker.id);
  }
  const sharing = crewWorktreeSharers(members, graph.lines);
  const stray = members.find((member) => member.writes !== undefined && !sharing.includes(member));
  if (stray !== undefined) {
    throw new Problem(`${stray.id} has paths of its own, but shares no crew worktree: only a non-maker beside other writers on the crew branch, or beside two makers, writes to its own paths`, stray.id);
  }
  const pathless = sharing.find((member) => member.writes === undefined);
  if (pathless !== undefined) {
    const beside = others(pathless) || 'the makers\' merges';
    throw new Problem(`${pathless.id} shares the crew worktree with ${beside}, so it writes to paths of its own: give it writes, such as docs/specs/`, pathless.id);
  }
  for (const [n, a] of sharing.entries()) {
    for (const b of sharing.slice(n + 1)) {
      for (const p of a.writes!) {
        const q = b.writes!.find((path) => writesPathsOverlap(p, path));
        if (q !== undefined) throw new Problem(`${a.id}'s ${p} and ${b.id}'s ${q} overlap: two members never write to the same paths`, a.id);
      }
    }
  }
}

/** The first thing wrong with a prefab's graph, or null when it passes. */
export function graphProblem(members: readonly Member[], graph: PrefabGraph, onBoard: CrewPrefab['onBoard']): PrefabGraphProblem | null {
  try {
    const ids = [...members.map((member) => member.id), ...graph.inputs.map((input) => input.id), ...graph.gates.map((gate) => gate.id)];
    const twice = ids.find((id, n) => ids.indexOf(id) !== n);
    if (twice !== undefined) throw new Problem(`two of the prefab's members, inputs and loop gates are ${twice}: each has an id of its own`, twice);
    checkLines(members, graph, onBoard);
    checkGates(members, graph);
    checkReach(members, graph);
    checkBranches(members, graph);
    return null;
  } catch (error) {
    if (error instanceof Problem) return { message: error.message, about: error.about };
    throw error;
  }
}
