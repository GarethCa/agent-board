// What a running crew keeps of where it is in its prefab's graph (`Run`, the `crews.run` column), and the graph as the
// crew loop routes it (`CrewPlan`): which lines carry work, who decides each loop gate, where its again line goes, and
// which members wait for all their inputs. Pure: the crew loop (`crew-loop.ts`) does the reading, starting and sending.
import type { CrewBranch } from './crew-branches.ts';
import { graphOf, type PrefabGraph } from './prefab-graph.ts';
import { defaultFresh, REVIEWER_ROLES, type CrewClash, type CrewPrefab, type CrewRecord, type PrefabGate, type PrefabInput, type PrefabLine, type PrefabMember } from './protocol.ts';

/**
 * Work on its way along the graph: what `from` (an agent's session) sent, from the member, loop gate or Your OK it came
 * out of (`source`), as the payload `name` (`handover.md`, `review, round 2`), and why it is on its way, in words, for
 * an end it reaches. `back` is the session a Send back at Your OK goes to: the member's own, or a loop's head's.
 */
export interface Item {
  from: string;
  source: string;
  name: string;
  text: string;
  why: string;
  back: string;
  /** Set for the words of a loop gate whose deciders all approved, with no blocker open. */
  approved?: true;
  /** What the user said with Go on at Your OK: typed as the board's own message, never inside the sender's mark. */
  note?: string;
}

/** A member as the crew runs it: its agent now, and since when a hand-off of its counts as new. */
export interface MemberRun {
  session: string;
  since: string;
}

/** A decider's word in a loop gate's round: whether it asks for the work again, and what it wrote. */
export interface Word {
  session: string;
  again: boolean;
  text: string;
}

/** A loop gate as the crew runs it. */
export interface GateRun {
  round: number;
  /** Its limit now: its cap, or its rounds, raised by `crew round` at its cap; null for none. */
  limit: number | null;
  /** When this round's work first reached a decider; null before. */
  openedAt: string | null;
  /** Whether this round's deciders were each sent its work, and the round announced. */
  announced: boolean;
  /** Each decider's word this round, by member. */
  words: Record<string, Word>;
  /** The round it decided done in: work reaching a decider again opens the next. */
  closed?: number;
  /** The round whose again it sent and is waiting to see land: it decides nothing more until then. */
  pending?: number;
  /** The round a `crew-waiting` was said for. */
  waitSaid?: number;
  /** Deciders it went on without, by session, with the round their word is late for. */
  late: Record<string, number>;
}

/** A wait-for-all member's inputs as they come: what each source sent this round, and the sources it went on without. */
export interface JoinRun {
  /** When the first of this round's came; null for none yet. */
  since: string | null;
  got: Record<string, Item>;
  late: string[];
}

/** A delivery not yet made: kept until it starts, so a busy agent gets it once it can. */
export interface Send {
  /** One per line: a newer item on the same line takes the place of one not sent yet. */
  key: string;
  /** The member it goes to. */
  to: string;
  item: Item;
  /** Set for a loop gate's again: the gate and round it moves on once it lands. */
  again?: { gate: string; round: number };
  /** Typed at `item.back`'s prompt (Send back), not delivered. */
  tell?: true;
  /** The user's note typed before the work it goes with, which then waits for its own turn. */
  noted?: true;
  /** A user's note typed after the work it went with (its agent had ended, so the work came first): moves on no hand-off. */
  note?: true;
  /** Close the sender once it lands: a late decider whose word was all it had left to give. */
  closeSender?: true;
  /** Why it couldn't start: `crew round`, or the sender's next item on the line, tries again. */
  failed?: string;
}

/** Where a running crew is in its graph, kept as JSON in `crews.run`. */
export interface Run {
  members: Record<string, MemberRun>;
  gates: Record<string, GateRun>;
  joins: Record<string, JoinRun>;
  /** What waits at each Your OK, and since when. */
  waits: Record<string, Item & { at: string }>;
  outbox: Send[];
  /** The loop gate it stopped at, asking at its cap: `crew round` raises that gate's limit. */
  atLimit?: string;
  /** Its crew branch (ADR-0026), once cut: a crew with two or more makers on branches of their own has one. */
  crewBranch?: CrewBranch;
  /** How many times running each maker's branch has conflicted with the crew branch: twice stops the crew. */
  conflicts?: Record<string, number>;
  /** A conflict's send-back the crew stopped instead of making, which `crew round` makes: one more try. */
  held?: Send;
  /** Changes in the shared crew worktree outside their makers' paths, while open. */
  clashes?: CrewClash[];
  /** Records of the shared crew worktree's uncommitted work, newest last: a few are kept. */
  records?: (CrewRecord & { tree: string; head: string | null })[];
  /**
   * Each sharing member's turn as it began, until its hand-off: the worktree's record, the crew branch's tip, and the
   * files changed but not committed then.
   */
  turns?: Record<string, { tree: string; head: string | null; files: string[]; next?: { tree: string; head: string | null; files: string[] } }>;
  /**
   * Work held while its makers' merge waits on the shared crew worktree, one for each member, loop gate or end it
   * goes on from: on members mid-turn there, or uncommitted changes in files it touches. Each step tries each again;
   * past its limit the builder is asked.
   */
  merges?: Merging[];
  /** Uncommitted work a sharing member's turn took from the shared crew worktree: it keeps the crew from Ready till it is back, or `crew round` goes on without it. */
  lost?: string[];
  /** A ready end the shared crew worktree kept from ready, with its work: `crew round` tries it again. */
  unready?: { input: string; item: Item };
}

/** A merge into the crew branch held for the shared crew worktree, and the work that goes on once it is made. */
export interface Merging {
  since: string;
  from: string;
  item: Item;
  /** Where the work goes: the member or end whose timeout bounds the wait. */
  to: string;
  /** Whom it waits on, by name, or the user. */
  on: string[];
  /** The members whose uncommitted files it waits on: their deliveries go on, so they can hand off and commit. */
  owners?: string[];
  asked?: true;
  now?: true;
}

export const emptyRun = (): Run => ({ members: {}, gates: {}, joins: {}, waits: {}, outbox: [] });

/** A loop gate's limit as a crew starts: its cap, or its set number of rounds. */
const gateLimit = (gate: PrefabGate): number | null => (gate.rule === 'rounds' ? gate.rounds : gate.cap);

export const newGateRun = (gate: PrefabGate): GateRun => ({ round: 1, limit: gateLimit(gate), openedAt: null, announced: false, words: {}, late: {} });

/** The graph of a running crew's prefab, as the loop routes work along it. */
export interface CrewPlan {
  prefab: CrewPrefab;
  graph: PrefabGraph;
  /** The member on the line from Your prompt: the crew's builder. */
  first: PrefabMember;
  member(id: string): PrefabMember | undefined;
  input(id: string): PrefabInput | undefined;
  gate(id: string): PrefabGate | undefined;
  /** The lines out of `id` that carry work: all but lead lines. */
  outs(id: string): PrefabLine[];
  /** The members that decide `gate`, in the prefab's order. */
  deciders(gate: string): string[];
  /** Where `gate`'s again line goes. */
  head(gate: string): string;
  /** The loop gate `member` decides, if any. */
  decides(member: string): string | undefined;
  /** The loop gates whose again line comes back to `member`. */
  heads(member: string): string[];
  /** The members, loop gates and Your OKs whose work reaches `member` through its join: not an again line. */
  sources(member: string): string[];
  /** Whether `member` takes its inputs as one: waiting for all, with more than one source. */
  joinsAll(member: string): boolean;
  /** Whether `member` is a fresh agent each time work reaches it. */
  fresh(member: string): boolean;
  /** Whether `member` reviews: its role's template is a reviewer's, so its spawn gets the crew's round, not the work. */
  reviews(member: string): boolean;
  /** What a member, loop gate or input is called, in words. */
  label(id: string): string;
}

const FROM_OUTSIDE = new Set<PrefabInput['kind']>(['prompt', 'ticket', 'queue', 'clock']);

export function planOf(prefab: CrewPrefab): CrewPlan {
  const graph = graphOf(prefab);
  const members = new Map(prefab.members.map((member) => [member.id, member]));
  const inputs = new Map(graph.inputs.map((input) => [input.id, input]));
  const gates = new Map(graph.gates.map((gate) => [gate.id, gate]));
  const routed = graph.lines.filter((line) => line.lead !== true);
  const first = prefab.members.find((member) => member.starts === 'prompt') ?? prefab.members[0]!;
  const deciders = (gate: string) => prefab.members.filter((member) => routed.some((line) => line.from === member.id && line.to === gate)).map((member) => member.id);
  const head = (gate: string) => routed.find((line) => line.from === gate && line.way === 'again')!.to;
  const sources = (member: string) => [
    ...new Set(
      routed
        .filter((line) => line.to === member && line.way !== 'again')
        .filter((line) => {
          const input = inputs.get(line.from);
          return input === undefined || !FROM_OUTSIDE.has(input.kind);
        })
        .map((line) => line.from),
    ),
  ];
  return {
    prefab,
    graph,
    first,
    member: (id) => members.get(id),
    input: (id) => inputs.get(id),
    gate: (id) => gates.get(id),
    outs: (id) => routed.filter((line) => line.from === id),
    deciders,
    head,
    decides: (member) => graph.gates.find((gate) => deciders(gate.id).includes(member))?.id,
    heads: (member) => graph.gates.filter((gate) => head(gate.id) === member).map((gate) => gate.id),
    sources,
    joinsAll: (member) => (members.get(member)?.join ?? 'all') === 'all' && sources(member).length > 1,
    fresh: (member) => {
      const found = members.get(member);
      return found !== undefined && member !== first.id && (found.fresh ?? defaultFresh(found.role));
    },
    reviews: (member) => REVIEWER_ROLES.includes(members.get(member)?.role as never),
    label: (id) => {
      const found = members.get(id);
      if (found !== undefined) return found.name ?? found.id;
      if (gates.has(id)) return `loop gate ${id}`;
      return inputs.get(id)?.kind === 'user' ? 'Your OK' : id;
    },
  };
}

/** What a loop gate does with its round's words: send the work back, on, or stop and ask at its cap. */
export type GateDecision = 'again' | 'done' | 'ask' | 'on';

/**
 * A loop gate's decision on its round's words, a missing word counting as again: a set number of rounds goes on once
 * it has gone them; otherwise it goes on once every decider says done, and at its limit asks or goes on, as it says.
 */
export function decide(gate: PrefabGate, run: GateRun, missing: number): GateDecision {
  if (gate.rule === 'rounds') return run.round >= (run.limit ?? gate.rounds) ? 'done' : 'again';
  if (missing === 0 && Object.values(run.words).every((word) => !word.again)) return 'done';
  if (run.limit !== null && run.round >= run.limit) return gate.atCap;
  return 'again';
}

/** `names` as a list in words: `a`, `a and b`, `a, b and c`. */
export function listed(names: readonly string[]): string {
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)!}`;
}

/**
 * The board's line heading work that goes on without `missing`: who hasn't reported, and `why` it went on, as the end
 * of the sentence (`after 30 min`, `as the user said`).
 */
export function missingLine(missing: readonly string[], why: string): string {
  return `${listed(missing)} ${missing.length === 1 ? "hasn't" : "haven't"} reported yet, so this goes on without ${missing.length === 1 ? 'it' : 'them'} ${why}.`;
}

/** Why work went on without what is missing: its timeout ran out, or the user said so. */
export const AS_THE_USER_SAID = 'as the user said';
export const afterMinutes = (minutes: number) => `after ${minutes} min`;

/** `text` with the board's line about what is missing first, if anything is. */
export const headed = (line: string | null, text: string): string => (line === null ? text : `${line}\n\n${text}`);
