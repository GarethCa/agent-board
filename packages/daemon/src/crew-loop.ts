// A running crew, run by the board along its prefab's graph (`crew-run.ts`). Each member's hand-off goes along its
// lines: to the members after it (a wait-for-all member taking a round's as one delivery, or going on without what is
// missing at its timeout), to a loop gate whose deciders' words send the work back to the loop's head or on, to a Your
// OK that waits for the user, or to an end. For the built-in prefabs: at each hand-off it starts that round's reviewers
// on the builder's branch; once each has left its review, it stops at ready to merge, or hands the reviews back to the
// builder for the next round, up to the prefab's round limit. It passes on only what its agents wrote, under their own
// sender marks, with at most a line of its own on what is missing or late, and approves, merges and draws nothing.
// Backed by `crews` (its graph's state in `run`) and `crew_reviewers`, so a crew carries on across a restart. What a
// crew's card shows (`card`) is read from the same rows, and `changed` says when to read it again.
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { shortIssueId } from '@agent-board/tracker';
import type { SpawnUsed } from './agent-spawns.ts';
import type { FolderPlace } from './agent-types.ts';
import type { BoardConnection } from './board.ts';
import { systemClock, type Clock } from './clock.ts';
import { upstreamMakers, type CrewBranch, type CrewBranches, type CrewKept } from './crew-branches.ts';
import { TURN_STATES, type CrewNewsKind } from './crew-events.ts';
import { ownerOf, ownsPath, type SharedWorktree, type Sharer } from './crew-worktree.ts';
import { parsePrefab, prefabFile } from './crew-prefabs.ts';
import {
  afterMinutes,
  AS_THE_USER_SAID,
  decide,
  emptyRun,
  headed,
  listed,
  missingLine,
  newGateRun,
  planOf,
  type CrewPlan,
  type GateRun,
  type Item,
  type Merging,
  type Run,
  type Send,
} from './crew-run.ts';
import type { ActivityEntry, Orchestrator, OrchestratorAccess } from './orchestrator-types.ts';
import { invalidParams, optionalStringParam, paramsObject, stringParam } from './params.ts';
import { crewMakers, crewWorktreeSharers, ownBranchMakers } from './prefab-graph.ts';
import {
  agentRefOf,
  BOARD_ERROR,
  MAX_CREW_CARD_TITLE,
  MAX_FLAG_LENGTH,
  planPending,
  waitsOnUser,
  type Agent,
  type Crew,
  type CrewCardData,
  type CrewPrefab,
  type CrewReviewer,
  type CrewStop,
  type CrewWait,
  type DaemonMethods,
  type OrchestratorAction,
  type PrefabInput,
  type SpawnAgentParams,
} from './protocol.ts';
import { handOffMessage, sentLine } from './handoff-text.ts';
import { openFindings, parseReviewDoc } from './review-doc.ts';
import { RpcMethodError, type RpcHandlers } from './rpc.ts';
import type { RunStart } from './schedules.ts';

type CrewMethods = Pick<
  DaemonMethods,
  'orchestrator.crews' | 'orchestrator.stopCrew' | 'orchestrator.crewRound' | 'orchestrator.crewGoOn' | 'orchestrator.crewSendBack' | 'orchestrator.crewGoOnWithout' | 'orchestrator.crewRestore'
>;

/** The file a member hands over in, and the one a reviewer reviews in, in their worktrees. */
const HANDOVER = join('.agent-board', 'handover.md');
const REVIEW = join('.agent-board', 'review.md');

/** The terminal an agent the crew starts runs in, before any client attaches and resizes it. */
const REVIEWER_SIZE = { cols: 120, rows: 40 };

const MINUTE = 60_000;

interface CrewRow {
  id: string;
  prefab: string;
  body: string;
  zone_id: string | null;
  started_by: string | null;
  builder: string;
  prompt: string;
  round: number;
  round_limit: number;
  phase: 'building' | 'reviewing';
  phase_at: string;
  start_failed: 0 | 1;
  /** Why, while `start_failed`. */
  start_error: string | null;
  stopped: CrewStop | null;
  stopped_at: string | null;
  started_at: string;
  /** Its `Run`, as JSON; `{}` for a crew from before the board ran graphs. */
  run: string;
}

interface ReviewerRow {
  crew_id: string;
  session_id: string;
  member: string;
  round: number;
  verdict: 'approve' | 'changes-requested' | null;
  review: string | null;
  blockers: number | null;
}

export interface CrewLoopOptions {
  agent(sessionId: string): Agent | undefined;
  /**
   * Starts a member in the crew of `spawnedBy` (the user's, without), as an orchestrator's agent starts; a reviewer's
   * template filled with the crew's round and last review (`used.crewReview`). With `place`, in that folder, owning no
   * worktree of its own: a member sharing the crew worktree.
   */
  spawn(params: SpawnAgentParams, spawnedBy: string | undefined, used: SpawnUsed, place?: FolderPlace): Promise<Agent>;
  /** Hands `text`, the payload `name`, from agent `from` to agent `to`, headed with `from`'s sender mark. */
  deliver(from: string, to: string, name: string, text: string): Promise<RunStart>;
  /** Types `text` for the board at the agent's prompt, once it is ready for it: the user's Send back. */
  tell?(sessionId: string, text: string): Promise<RunStart>;
  /** Flags the agent for whoever hears its flags (its orchestrator, else the user's Needs you). */
  flag(sessionId: string, reason: string): void;
  /** Clears the agent's flag. */
  clearFlag(sessionId: string): void;
  /** Closes the agent and removes the worktree and branch it owns. */
  close(sessionId: string, why: string): Promise<void>;
  /** The crew's news, as an event of its builder (`round`, `crew-waiting`, `crew-stopped`), with the loop gate it is of. */
  news(sessionId: string, kind: CrewNewsKind, detail: string, gate?: string): void;
  /** Where the crews keep a copy of each review they read, for the next round's reviewer once its own is closed. */
  dir: string;
  /** The crew may show differently now (`card`): it started, took a step, was stopped, or one of its agents changed. */
  changed?(crewId: string): void;
  log(message: string): void;
  /**
   * The crews' own branches (ADR-0026). Without, a crew of two or more makers runs each on a branch cut from its
   * sender's, merging none, as before crews had branches.
   */
  branches?: CrewBranches;
  /**
   * The crew worktree its non-makers share, each writing to paths of its own: what changed there, the board's commits
   * of a member's own files, and records of its uncommitted work. Without, no member shares it.
   */
  shared?: SharedWorktree;
  /** Pushes the crew branch and opens a draft pull request of it, recorded on the builder: resolves to its URL. */
  openPullRequest?(crew: CrewBranch, builder: string, title: string, body: string): Promise<string>;
  /** Times its timeouts: a wait-for-all member's, a loop gate's. */
  clock?: Clock;
  now?: () => Date;
}

export interface CrewLoop {
  /**
   * Starts a crew around the agent `builder`, just started from `prefab` with `prompt` by `startedBy` (null for the
   * user); null for a prefab with no member after its first and no Your OK.
   */
  start(prefab: CrewPrefab, builder: string, startedBy: string | null, prompt: string): Crew | null;
  /** Hears an agent as it is now: a crew it is in may move on. */
  observe(agent: Agent): void;
  /** Hears the files (absolute) an agent's harness says it just edited: one outside its own paths is a clash. */
  edited(sessionId: string, files: string[]): void;
  /** Moves on every running crew, as the daemon starts: what happened while it was down is read from the files. */
  resume(): void;
  /** The crews, newest first. */
  list(): Crew[];
  /**
   * What the crew's card shows, as the crew is now, its `tiles` as its prefab draws a crew at first; undefined for no
   * such crew.
   */
  card(crewId: string): CrewCardData | undefined;
  /**
   * The round a crew's reviewer reviews and the last round's review it was given to check, as the crew started it;
   * undefined for an agent that is no crew's reviewer.
   */
  reviewOf(sessionId: string): { round: number; previous: string | null } | undefined;
  /** Settles once no crew is moving on: for tests. */
  idle(): Promise<void>;
  /** Stops moving crews on, as the daemon shuts down: its agents stop as it goes, which is no news to a crew. */
  close(): void;
  handlers<Context extends BoardConnection>(access: OrchestratorAccess): RpcHandlers<CrewMethods, Context>;
}

/** What the user or an orchestrator asked of a crew, taken at its next step, so only a step changes its run. */
type Action =
  | { kind: 'retry' }
  | { kind: 'more' }
  | { kind: 'go-on'; input: string; note: string | undefined }
  | { kind: 'send-back'; input: string; note: string }
  | { kind: 'go-on-without'; at: string }
  | { kind: 'edited'; session: string; files: string[] }
  | { kind: 'merge-now'; to: string }
  | { kind: 'wait-longer' }
  | { kind: 'ready-again' }
  | { kind: 'restore' };

/** How each flag the crew raises on its builder starts, so `crew show` never counts a flag of its own as needing you. */
const crewFlag = (prefab: string) => `The ${prefab} crew `;

/**
 * Whether the agent waits on the user for its next step: a permission prompt, a question or a plan. A flag is not one:
 * the board asks agents to flag when their work is ready, which a hand-off then says too.
 */
const waitsForUser = (agent: Agent): boolean =>
  agent.endedAt === null && (agent.state === 'needs-permission' || agent.permissions.length > 0 || waitsOnUser(agent) || planPending(agent));

/** Whether `crew show` says the agent needs you: as `waitsForUser`, or a flag not the crew's own. */
const needsYou = (agent: Agent, prefab: string): boolean =>
  waitsForUser(agent) || (agent.endedAt === null && agent.flag !== null && !agent.flag.reason.startsWith(crewFlag(prefab)));

/** Whether the agent's turn is over: at its prompt, or ended. */
const turnOver = (agent: Agent): boolean => agent.endedAt !== null || !TURN_STATES.has(agent.state);

/** Whether the agent ended only for now: paused, or stopped by a restart of the app, so it carries on when resumed. */
const endedForNow = (agent: Agent): boolean => agent.endedAt !== null && (agent.hibernated !== null || agent.state === 'stopped-by-restart');

/** `path` with its symbolic links resolved, by its nearest folder that is there for a file or folder not yet made. */
async function realOr(path: string): Promise<string> {
  for (let at = path, rest: string[] = []; ; rest.unshift(basename(at)), at = dirname(at)) {
    try {
      return join(await realpath(at), ...rest);
    } catch {
      if (dirname(at) === at) return path;
    }
  }
}

/** When `path` was last written, in ms, or undefined for no such file. */
function writtenAt(path: string): number | undefined {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

const rounds = (n: number) => `${n} ${n === 1 ? 'round' : 'rounds'}`;

/** What a maker on a branch of its own is told as it starts (ADR-0026). */
const MAKER_NOTE =
  'You work on a branch of your own, which the crew merges into its crew branch as you hand off: commit your work before you do, as only what you commit is merged.';

/** Where a member sharing the crew worktree hands over, but its first: a file of its own, as the others hand over there too. */
const sharedHandover = (member: string) => join('.agent-board', member, 'handover.md');

/** How long a merge into the shared crew worktree waits on its members, unless the member it is for says otherwise. */
const MERGE_WAIT_MINUTES = 30;

/** How many records of the shared crew worktree's uncommitted work a crew keeps: one before and one after each turn. */
const RECORDS_KEPT = 10;

/** The end of the key of a note asking a member to hand off, for a merge that waits on its uncommitted files. */
const MERGE_NUDGE = '>merge-wait';

/** The git commands a member sharing the crew worktree is told not to run: each would move or sweep up the others' work. */
const SHARED_GIT = ['git add', 'git commit', 'git stash', 'git reset', 'git checkout', 'git restore', 'git switch', 'git rebase', 'git merge', 'git clean', 'git push'];

/**
 * What a member sharing the crew worktree is told as it starts, or undefined for one that doesn't share it: its own
 * paths, who else writes there, the git it leaves alone, and where it hands over.
 */
export function sharerNote(prefab: CrewPrefab, member: string): string | undefined {
  const plan = planOf(prefab);
  const sharers = crewWorktreeSharers(prefab.members, plan.graph.lines);
  const me = sharers.find((each) => each.id === member);
  if (me === undefined) return undefined;
  const others = sharers.filter((each) => each !== me).map((each) => `${plan.label(each.id)} (${(each.writes ?? []).join(', ')})`);
  if (ownBranchMakers(prefab.members, plan.graph.lines).length > 0) others.push("the makers' merges");
  const handover = member === plan.first.id ? HANDOVER : sharedHandover(member);
  return [
    `You share this worktree with ${listed(others)}. Write only to your own paths: ${(me.writes ?? []).join(', ')}. Leave every other file alone, even to fix it: say what it needs in your hand-off.`,
    `Don't run ${SHARED_GIT.join(', ')}: the board commits your paths under your name as you hand off, and each of those would move or sweep up the others' work.`,
    `Hand over in ${handover}.`,
  ].join(' ');
}

/** What a crew was asked, in a line for its card: its prompt's first line with anything on it, else its prefab's name. */
function cardTitle(prompt: string, prefab: string): string {
  const line = prompt
    .split('\n')
    .map((each) => each.trim())
    .find((each) => each !== '');
  const title = [...(line ?? prefab)];
  return title.length > MAX_CREW_CARD_TITLE ? `${title.slice(0, MAX_CREW_CARD_TITLE - 1).join('')}…` : title.join('');
}

/** A flag's reason, cut to the board's limit. */
const clipped = (reason: string) => (reason.length <= MAX_FLAG_LENGTH ? reason : `${reason.slice(0, MAX_FLAG_LENGTH - 1)}…`);

/** Where a held merge's work goes on from and to, and the work. */
type Then = Pick<Merging, 'from' | 'to' | 'item'>;

/**
 * The shared crew worktree as a sharing member's turn begins: its record, the crew branch's tip, the files changed; and
 * the next turn's, begun at its prompt before this one's hand-off was taken.
 */
type TurnStart = { tree: string; head: string | null; files: string[]; next?: Omit<TurnStart, 'next'> };

/** A step's hold on one crew: its row and graph as the step began, its run as the step changes it. */
interface Step {
  crew: CrewRow;
  plan: CrewPlan;
  run: Run;
  /** Set once the crew stopped during the step: it takes no more. */
  stopped: boolean;
  /** Whether it flagged a start that failed, this step: once is enough. */
  flagged: boolean;
  /** The sends it tried this step: one it couldn't make waits for the next. */
  tried: Set<Send>;
  /** Loop gates the user went on without, which decide now. */
  forced: Set<string>;
}

export function createCrewLoop(db: DatabaseSync, given: CrewLoopOptions): CrewLoop {
  // A flag's reason past the board's limit is refused: the crew's, which can name many files, is cut to it instead.
  // Over the options themselves, so a later change to them still reaches the loop.
  const options = Object.assign(Object.create(given) as CrewLoopOptions, { flag: (sessionId: string, reason: string) => given.flag(sessionId, clipped(reason)) });
  const clock = options.clock ?? systemClock;
  const now = options.now ?? (() => new Date(clock.now()));
  const insertCrew = db.prepare(
    'INSERT INTO crews (id, prefab, body, zone_id, started_by, builder, prompt, round_limit, phase_at, started_at, run) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const selectCrews = db.prepare('SELECT * FROM crews ORDER BY started_at DESC, rowid DESC');
  const selectCrew = db.prepare('SELECT * FROM crews WHERE id = ?');
  // Running, or waiting for its builder (at its round limit, or on its pull request): what a restart looks at again.
  const selectRunning = db.prepare("SELECT * FROM crews WHERE stopped IS NULL OR stopped IN ('round-limit', 'ready-to-merge')");
  const selectReviewers = db.prepare('SELECT * FROM crew_reviewers WHERE crew_id = ? ORDER BY round, rowid');
  const selectReviewer = db.prepare('SELECT * FROM crew_reviewers WHERE session_id = ? ORDER BY rowid DESC LIMIT 1');
  // One row an agent: a decider that is the same agent each round has its row moved on to the round it now decides.
  const insertReviewer = db.prepare(
    'INSERT INTO crew_reviewers (crew_id, session_id, member, round) VALUES (?, ?, ?, ?) ON CONFLICT (crew_id, session_id) DO UPDATE SET member = excluded.member, round = excluded.round, verdict = NULL, review = NULL, blockers = NULL',
  );
  const setReview = db.prepare('UPDATE crew_reviewers SET verdict = ?, review = ?, blockers = ? WHERE crew_id = ? AND session_id = ?');
  // Its first loop gate's round, limit and phase stay in its own columns, as a daemon from before reads them.
  const setRun = db.prepare('UPDATE crews SET run = ?, round = ?, round_limit = ?, phase = ?, phase_at = ? WHERE id = ?');
  const setStopped = db.prepare('UPDATE crews SET stopped = ?, stopped_at = ? WHERE id = ?');
  const restart = db.prepare('UPDATE crews SET stopped = NULL, stopped_at = NULL, round_limit = ? WHERE id = ?');
  const setStartFailed = db.prepare('UPDATE crews SET start_failed = ?, start_error = ? WHERE id = ?');
  const crewsOf = db.prepare(
    'SELECT DISTINCT c.id FROM crews c LEFT JOIN crew_reviewers r ON r.crew_id = c.id WHERE c.builder = ? OR r.session_id = ? OR (c.stopped IS NULL AND instr(c.run, ?) > 0)',
  );

  /** Names of the agents a crew had, kept for once they are gone. */
  const names = new Map<string, string>();
  const nameOf = (sessionId: string) => options.agent(sessionId)?.name ?? names.get(sessionId) ?? sessionId;
  let closing = false;
  const changed = (id: string) => {
    if (!closing) options.changed?.(id);
  };

  const reviewersOf = (id: string, round?: number) =>
    (selectReviewers.all(id) as unknown as ReviewerRow[]).filter((reviewer) => round === undefined || reviewer.round === round);
  const row = (id: string) => selectCrew.get(id) as unknown as CrewRow | undefined;
  const stillRunning = (id: string) => !closing && row(id)?.stopped === null;
  /** Where the crew keeps its copy of a review. */
  const keptReview = (crew: CrewRow, member: string, round: number) => join(options.dir, crew.id, `round-${round}-${member}.md`);

  /** The member's review of the round before `round`, if the crew kept one. */
  const lastReviewOf = (crew: CrewRow, member: string, round: number): string | null => {
    const previous = round === 1 ? undefined : keptReview(crew, member, round - 1);
    return previous !== undefined && writtenAt(previous) !== undefined ? previous : null;
  };

  // A crew's prefab never changes once it started: its graph is read once.
  const plans = new Map<string, CrewPlan>();
  const planFor = (crew: CrewRow): CrewPlan => {
    let plan = plans.get(crew.id);
    if (plan === undefined) plans.set(crew.id, (plan = planOf(parsePrefab(crew.body))));
    return plan;
  };

  /** The members sharing the crew worktree, each with its own paths: none without the means to share it. */
  const sharersOf = (plan: CrewPlan): Sharer[] =>
    options.branches === undefined || options.shared === undefined
      ? []
      : crewWorktreeSharers(plan.prefab.members, plan.graph.lines).map((member) => ({ member: member.id, writes: member.writes ?? [] }));
  const sharing = (plan: CrewPlan, member: string) => sharersOf(plan).some((each) => each.member === member);
  /**
   * The makers on branches of their own merged into the crew branch (ADR-0026): two or more, or one beside members
   * sharing the crew worktree; none otherwise.
   */
  const makersOf = (plan: CrewPlan): Set<string> =>
    new Set(options.branches === undefined ? [] : crewMakers(plan.prefab.members, plan.graph.lines).map((member) => member.id));
  /** Where a member hands over: a member sharing the crew worktree, but its first, in a file of its own there. */
  const handoverOf = (plan: CrewPlan, member: string) => (member !== plan.first.id && sharing(plan, member) ? sharedHandover(member) : HANDOVER);
  const agentOf = (run: Run, member: string): Agent | undefined => {
    const session = run.members[member]?.session;
    return session === undefined ? undefined : options.agent(session);
  };
  const branchOf = (agent: Agent) => agent.ownedBranch || agent.branch;

  /** The rows of `gate`'s deciders in `round`, in the order they started. */
  const deciderRows = (crew: CrewRow, plan: CrewPlan, gate: string, round: number) => {
    const deciders = plan.deciders(gate);
    return reviewersOf(crew.id, round).filter((reviewer) => deciders.includes(reviewer.member));
  };

  /**
   * The run of a crew from before the board ran graphs, from its round columns: its builder, and its first loop gate
   * at its round, with the words its reviewers left this round. A round that failed to start sends to its reviewers
   * still lacking again, at `crew round` or the builder's next hand-off.
   */
  const legacyRun = (crew: CrewRow, plan: CrewPlan): Run => {
    const run = emptyRun();
    run.members[plan.first.id] = { session: crew.builder, since: crew.phase_at };
    for (const gate of plan.graph.gates) run.gates[gate.id] = newGateRun(gate);
    const gate = plan.graph.gates[0];
    if (gate === undefined) return run;
    const state = run.gates[gate.id]!;
    state.round = crew.round;
    state.limit = crew.round_limit;
    state.announced = crew.phase === 'reviewing';
    const rows = deciderRows(crew, plan, gate.id, crew.round);
    if (rows.length > 0) state.openedAt = crew.phase_at;
    for (const each of rows) {
      run.members[each.member] = { session: each.session_id, since: crew.phase_at };
      if (each.review !== null) state.words[each.member] = { session: each.session_id, again: !(each.verdict === 'approve' && each.blockers === 0), text: each.review };
    }
    if (crew.start_failed === 1 && crew.phase === 'building') {
      for (const member of plan.deciders(gate.id).filter((each) => !rows.some((one) => one.member === each))) {
        const item: Item = { from: crew.builder, source: plan.first.id, name: 'handover.md', text: '', why: `${nameOf(crew.builder)} handed off`, back: crew.builder };
        run.outbox.push({ key: `${plan.first.id}>${member}`, to: member, item, failed: crew.start_error ?? 'it failed to start' });
      }
    }
    if (crew.stopped === 'round-limit') run.atLimit = gate.id;
    return run;
  };

  const runOf = (crew: CrewRow): Run => (crew.run === '{}' ? legacyRun(crew, planFor(crew)) : (JSON.parse(crew.run) as Run));

  /** Each timeout the crew waits on, ms: a wait-for-all member's for the rest of its inputs, a loop gate's for its words. */
  const deadlines = (plan: CrewPlan, run: Run): number[] => {
    const at: number[] = [];
    for (const [member, state] of Object.entries(run.joins)) {
      const timeout = plan.member(member)?.timeout;
      if (state.since !== null && timeout !== undefined) at.push(Date.parse(state.since) + timeout * MINUTE);
    }
    for (const [id, state] of Object.entries(run.gates)) {
      const gate = plan.gate(id);
      if (gate?.timeout != null && open(state) && state.openedAt !== null) at.push(Date.parse(state.openedAt) + gate.timeout * MINUTE);
    }
    for (const merging of run.merges ?? []) if (merging.asked !== true) at.push(mergeDeadline(plan, merging));
    return at;
  };

  /** When a merge waiting on the shared crew worktree stops to ask: at the timeout of the member it is for, else 30 min. */
  const mergeDeadline = (plan: CrewPlan, merging: Merging) =>
    Date.parse(merging.since) + (plan.member(merging.to)?.timeout ?? MERGE_WAIT_MINUTES) * MINUTE;

  /** Whether a loop gate's round is under way: work reached it, and it hasn't decided. */
  const open = (state: GateRun) => state.openedAt !== null && state.pending === undefined && state.closed !== state.round;

  /** What the crew waits for now, for its view. */
  const waitsOf = (crew: CrewRow, plan: CrewPlan, run: Run): CrewWait[] => {
    const until = (since: string, minutes: number | null | undefined) => (minutes == null ? null : new Date(Date.parse(since) + minutes * MINUTE).toISOString());
    const waits: CrewWait[] = [];
    for (const [member, state] of Object.entries(run.joins)) {
      if (state.since === null) continue;
      const missing = plan.sources(member).filter((source) => state.got[source] === undefined).map(plan.label);
      waits.push({ kind: 'member', at: member, since: state.since, missing, until: until(state.since, plan.member(member)?.timeout) });
    }
    for (const [id, state] of Object.entries(run.gates)) {
      if (!open(state) || !state.announced) continue;
      const rows = deciderRows(crew, plan, id, state.round);
      const missing = plan.deciders(id).filter((member) => state.words[member] === undefined);
      if (missing.length === 0) continue;
      const named = missing.map((member) => {
        const found = rows.find((each) => each.member === member);
        return found === undefined ? plan.label(member) : deciderName(plan, member, found.session_id);
      });
      waits.push({ kind: 'gate', at: id, since: state.openedAt!, missing: named, until: until(state.openedAt!, plan.gate(id)?.timeout) });
    }
    for (const [input, item] of Object.entries(run.waits)) waits.push({ kind: 'user', at: input, since: item.at, missing: ['the user'], until: null });
    for (const merging of run.merges ?? []) {
      waits.push({ kind: 'merge', at: merging.to, since: merging.since, missing: merging.on, until: new Date(mergeDeadline(plan, merging)).toISOString() });
    }
    return waits;
  };

  const view = (crew: CrewRow): Crew => {
    const plan = planFor(crew);
    const run = runOf(crew);
    const reviewers = reviewersOf(crew.id);
    const current = reviewers.filter((reviewer) => reviewer.round === crew.round).map((reviewer) => reviewer.session_id);
    const sessions = new Set([crew.builder, ...(crew.phase === 'reviewing' ? current : []), ...Object.values(run.members).map((member) => member.session)]);
    const members = [...sessions].map((id) => options.agent(id));
    const waiting = waitsOf(crew, plan, run);
    return {
      id: crew.id,
      prefab: crew.prefab,
      zoneId: crew.zone_id,
      startedBy: crew.started_by,
      builder: crew.builder,
      round: crew.round,
      roundLimit: crew.round_limit,
      phase: crew.stopped === null ? crew.phase : 'stopped',
      needsYou:
        crew.stopped === null && (Object.keys(run.waits).length > 0 || members.some((agent) => agent !== undefined && needsYou(agent, crew.prefab))),
      stopped: crew.stopped,
      startedAt: crew.started_at,
      stoppedAt: crew.stopped_at,
      reviewers: reviewers.map(
        (reviewer): CrewReviewer => ({
          member: reviewer.member,
          sessionId: reviewer.session_id,
          name: nameOf(reviewer.session_id),
          round: reviewer.round,
          verdict: reviewer.verdict,
          blockers: reviewer.blockers,
        }),
      ),
      gates: plan.graph.gates.map((gate) => {
        const state = run.gates[gate.id] ?? newGateRun(gate);
        return { id: gate.id, round: state.round, limit: state.limit, openedAt: state.openedAt };
      }),
      waiting,
      ...(run.clashes === undefined || run.clashes.length === 0 ? {} : { clashes: run.clashes }),
      ...(run.records === undefined || run.records.length === 0 ? {} : { record: recordOf(run.records.at(-1)!) }),
    };
  };

  const recordOf = ({ at, why, files }: NonNullable<Run['records']>[number]) => ({ at, why, files });

  const stop = (crew: CrewRow, why: CrewStop, said: string) => {
    setStopped.run(why, now().toISOString(), crew.id);
    options.news(crew.builder, 'crew-stopped', `${why}: ${said}`);
  };

  /** Saves the step's run, with its first loop gate's round, limit and phase in the crew's own columns. */
  const save = (step: Step) => {
    const gate = step.plan.graph.gates[0];
    const state = gate === undefined ? undefined : step.run.gates[gate.id];
    const phase = state?.announced === true ? 'reviewing' : 'building';
    const at = phase === step.crew.phase ? step.crew.phase_at : now().toISOString();
    const round = state?.round ?? 1;
    const limit = state === undefined ? step.crew.round_limit : (state.limit ?? 0);
    setRun.run(JSON.stringify(step.run), round, limit, phase, at, step.crew.id);
    step.crew = { ...step.crew, phase, phase_at: at, round, round_limit: limit };
  };

  /**
   * Closes the crew's agents, as its work is done or its builder's pull request merged: its reviewers, then its other
   * members, its builder last. One that won't close is flagged on the builder, if it can be.
   */
  const closeAll = async (crew: CrewRow, run: Run, why: string, when: string, keepCrewBranch: boolean) => {
    const sessions = new Set([...reviewersOf(crew.id).map((each) => each.session_id), ...Object.values(run.members).map((member) => member.session)]);
    sessions.delete(crew.builder);
    const failed: string[] = [];
    const close = async (sessionId: string) => {
      await options.close(sessionId, why).catch((error: Error) => {
        failed.push(`${nameOf(sessionId)} (${error.message})`);
      });
    };
    for (const sessionId of sessions) if (options.agent(sessionId) !== undefined) await close(sessionId);
    if (options.agent(crew.builder) !== undefined) await close(crew.builder);
    // Its crew worktree goes with them; its branch too once merged, else it is kept, as it may hold the work.
    const crewBranch = run.crewBranch;
    let kept: CrewKept | undefined;
    if (crewBranch?.made === true && crewBranch.adopted !== true && options.branches !== undefined) {
      kept = await options.branches.remove(crewBranch, keepCrewBranch).catch((error: Error) => {
        failed.push(`its crew worktree ${crewBranch.worktree} (${error.message})`);
        return undefined;
      });
    }
    if (options.agent(crew.builder) === undefined) return;
    if (failed.length > 0) options.flag(crew.builder, `${crewFlag(crew.prefab)}couldn't close ${failed.join(', ')} ${when}: close them yourself`);
    else if (kept !== undefined) options.flag(crew.builder, `${crewFlag(crew.prefab)}kept its crew branch ${crewBranch!.branch} ${when}, as ${kept.why}`);
  };

  /**
   * Removes the crew worktree of a crew stopped for good (by the user, or its builder gone), once: its branch too, but
   * one with work no other branch or remote has, which is kept and named. `said`, why it stopped, heads what is flagged.
   */
  const release = async (crew: CrewRow, run: Run, said?: string) => {
    const crewBranch = run.crewBranch;
    if (crewBranch?.made !== true || crewBranch.adopted === true || crewBranch.released === true || options.branches === undefined) return;
    crewBranch.released = true;
    save({ crew, plan: planFor(crew), run, stopped: true, flagged: false, tried: new Set(), forced: new Set() });
    const after = await options.branches.remove(crewBranch, false).then(
      (kept) =>
        kept === undefined
          ? undefined
          : kept.worktree
            ? `its crew branch ${crewBranch.branch} is kept, as ${kept.why}`
            : `its crew worktree is removed, but its crew branch ${crewBranch.branch} is kept, as ${kept.why}`,
      (error: Error) => `its crew worktree ${crewBranch.worktree} couldn't be removed (${error.message}): remove it yourself`,
    );
    const reason = [said, after].filter((part) => part !== undefined).join(': ');
    if (reason === '') return;
    if (options.agent(crew.builder) !== undefined) options.flag(crew.builder, `${crewFlag(crew.prefab)}${reason}`);
    else options.news(crew.builder, 'crew-stopped', reason);
  };

  /** Queues a delivery, in place of one not sent yet on the same line. */
  const queue = (step: Step, send: Send) => {
    const at = step.run.outbox.findIndex((each) => each.key === send.key);
    if (at === -1) step.run.outbox.push(send);
    else step.run.outbox[at] = send;
  };

  /** A merge held for the shared crew worktree, and an end that waits for it to be committed: neither a maker's name. */
  const WAITING = '\0waiting';
  const NOT_READY = '\0not-ready';

  /** The member whose agent `session` is, if any. */
  const memberOf = (run: Run, session: string) => Object.entries(run.members).find(([, member]) => member.session === session)?.[0];

  /** Work reaching an end: with more than one line in, once each has delivered (or the user went on without the rest). */
  const end = async (step: Step, input: Extract<PrefabInput, { kind: 'end' }>, item: Item) => {
    const { plan, run } = step;
    const sources = plan.sources(input.id);
    if (sources.length < 2) return finish(step, input, item);
    const state = (run.joins[input.id] ??= { since: null, got: {}, late: [] });
    const first = state.since === null;
    state.got[item.source] = item;
    state.since ??= now().toISOString();
    const missing = sources.filter((source) => state.got[source] === undefined);
    if (missing.length === 0) return settleJoin(step, input.id, null);
    if (first) options.news(step.crew.builder, 'crew-waiting', `the ${input.as} end waits for ${listed(missing.map(plan.label))}`);
  };

  /**
   * The crew at an end: ready to merge, or done, which closes the crew's agents. With a crew branch, an end first
   * merges each maker's branch into it, and a ready one then opens one pull request of it; a maker whose branch won't
   * merge is named, and the crew goes on without finishing.
   */
  const finish = async (step: Step, input: Extract<PrefabInput, { kind: 'end' }>, item: Item): Promise<string | undefined> => {
    const { crew, run } = step;
    let opened = '';
    if (run.crewBranch !== undefined) {
      const blocked = await mergeMakers(step, [...makersOf(step.plan)], { from: input.id, to: input.id, item });
      if (blocked !== undefined) return blocked === WAITING ? undefined : blocked;
      if (input.as === 'ready' && (await notReady(step, item))) {
        run.unready = { input: input.id, item };
        return NOT_READY;
      }
      if (input.as === 'ready') opened = await openCrewPullRequest(step, run.crewBranch);
    }
    delete run.unready;
    step.stopped = true;
    save(step);
    if (input.as === 'ready') {
      stop(crew, 'ready-to-merge', item.why);
      options.flag(crew.builder, `${crewFlag(crew.prefab)}is ready to merge: ${item.why}${item.approved === true ? ', with no blocker open' : ''}${opened}`);
      return;
    }
    stop(crew, 'done', `${item.why}, so the crew closed its agents`);
    await closeAll(crew, run, `its crew's work is done`, 'once its work was done', true);
  };

  /** Opens the one pull request of the crew branch, once: what the ready flag says of it. */
  const openCrewPullRequest = async (step: Step, crewBranch: CrewBranch): Promise<string> => {
    const { crew, run } = step;
    const of = `the crew branch ${crewBranch.branch}`;
    if (crewBranch.pr !== undefined) return `: its draft pull request is ${crewBranch.pr}, of ${of}`;
    if (options.openPullRequest === undefined) return `, on ${of}`;
    const builder = options.agent(crew.builder);
    // Named by its ticket, or else by its prefab and branch: never by the prompt, which the board doesn't send to GitHub.
    const title = builder?.issue == null ? `${crew.prefab} crew: ${crewBranch.branch}` : `${shortIssueId(builder.issue)}: ${builder.issue.title}`;
    const makers = [...makersOf(step.plan)].flatMap((member) => {
      const agent = agentOf(run, member);
      return agent === undefined ? [] : [`- ${agent.name}: \`${branchOf(agent)}\``];
    });
    // The board opens it with no step from the user, so it names only the crew's branches and ticket: never the prompt.
    const ticket = builder?.issue == null || builder.issue.url === '' ? '' : `\n\nFor ${builder.issue.url}`;
    const body = `The ${crew.prefab} crew's work, on its crew branch \`${crewBranch.branch}\`, with each maker's branch merged in:\n\n${makers.join('\n')}${ticket}`;
    try {
      crewBranch.pr = await options.openPullRequest(crewBranch, crew.builder, title, body);
      return `: its draft pull request is ${crewBranch.pr}, of ${of}`;
    } catch (error) {
      return `, but the pull request of ${of} couldn't be opened (${(error as Error).message}): open it yourself`;
    }
  };

  /**
   * Merges each of `makers`' branches into the crew branch, as their work meets there. The first that won't merge is
   * named: one that conflicts is sent back to its maker, one that fails otherwise flagged on the builder. With members
   * sharing the crew worktree, a merge waits (`WAITING`, with `then` kept to take up again) while one of them is mid-turn
   * or has uncommitted changes in a file it touches. Any other outcome ends its wait.
   */
  const mergeMakers = async (step: Step, makers: readonly string[], then: Then): Promise<string | undefined> => {
    const blocked = await tryMerges(step, makers, then);
    if (blocked !== WAITING) unhold(step, then.from, blocked === undefined);
    return blocked;
  };

  const tryMerges = async (step: Step, makers: readonly string[], then: Then): Promise<string | undefined> => {
    const { crew, plan, run } = step;
    const crewBranch = run.crewBranch;
    if (crewBranch === undefined || options.branches === undefined) return undefined;
    const held = run.merges?.find((each) => each.from === then.from);
    const now_ = held?.now === true;
    if (!now_ && sharersOf(plan).length > 0) {
      const busy = midTurn(step);
      if (busy.length > 0) return waitToMerge(step, then, busy.map(nameOf));
    }
    await movedByOthers(step);
    const merged: string[] = [];
    for (const maker of makers) {
      const agent = agentOf(run, maker);
      if (agent === undefined || branchOf(agent) === '') continue;
      const branch = branchOf(agent);
      // Only what it committed is merged: work it left uncommitted goes back to it, as a conflict does.
      const uncommitted = await options.branches.uncommitted(agent.worktree).catch(() => []);
      if (uncommitted.length > 0) {
        sendMakerBack(step, maker, agent, 'uncommitted', uncommitted, merged);
        return maker;
      }
      const result = await options.branches.merge(crewBranch, branch, `Merge ${branch} into the crew branch`).catch((error: Error) => ({ error: error.message }));
      if ('waits' in result) {
        if (now_) {
          options.flag(
            crew.builder,
            `${crewFlag(crew.prefab)}couldn't merge ${agent.name}'s ${branch} into its crew branch: its crew worktree has uncommitted changes in ${listed(result.waits)}, which the merge touches. Commit or undo them, then Merge now again`,
          );
          delete held!.now;
          return WAITING;
        }
        return waitToMerge(step, then, owners(plan, result.waits), result.waits);
      }
      if ('conflicts' in result) {
        sendMakerBack(step, maker, agent, 'conflict', result.conflicts, merged);
        return maker;
      }
      if ('error' in result) {
        options.flag(
          crew.builder,
          `${crewFlag(crew.prefab)}couldn't merge ${agent.name}'s ${branch} into its crew branch ${crewBranch.branch} (${result.error}): merge it there yourself, then have ${agent.name} hand off again`,
        );
        return maker;
      }
      if (run.conflicts !== undefined) delete run.conflicts[maker];
      merged.push(agent.name);
      if ('files' in result) {
        crewBranch.head = (await options.shared?.head(crewBranch.worktree, crewBranch.branch).catch(() => null)) ?? crewBranch.head;
        tellOwners(step, result.files, `The board merged ${agent.name}'s ${branch} into the crew branch, which changed`);
      }
    }
    return undefined;
  };

  /** A held merge's wait over: made, or blocked by its maker's branch. The nudges to commit for it go too, once none is held. */
  const unhold = (step: Step, from: string, made: boolean) => {
    const { crew, run } = step;
    const held = run.merges?.find((each) => each.from === from);
    if (held === undefined) return;
    run.merges = run.merges!.filter((each) => each !== held);
    if (run.merges.length === 0) {
      delete run.merges;
      run.outbox = run.outbox.filter((send) => !send.key.endsWith(MERGE_NUDGE));
    }
    options.news(crew.builder, 'crew-waiting', made ? `the merge into the crew branch is made` : `the merge into the crew branch waits no longer: a maker's branch went back to it`);
  };

  /** The members sharing the crew worktree that are mid-turn, by agent. */
  const midTurn = (step: Step): string[] =>
    sharersOf(step.plan).flatMap(({ member }) => {
      const agent = agentOf(step.run, member);
      return agent !== undefined && !turnOver(agent) ? [agent.sessionId] : [];
    });

  /** Who a merge waiting on `files` waits on: each file's owner, by name, else the user. */
  const owners = (plan: CrewPlan, files: readonly string[]) => {
    const sharers = sharersOf(plan);
    return [...new Set(files.map((file) => ownerOf(file, sharers)))].map((owner) => (owner === null ? 'the user' : plan.label(owner)));
  };

  /**
   * A merge into the shared crew worktree held, one for each place its work goes on from, for a later step to take up
   * again: it says once whom it waits on. Waiting on uncommitted `files`, it asks each owner once to hand off, which
   * commits them, and tells the builder once of any in no member's paths, which only the user can commit or undo.
   */
  const waitToMerge = (step: Step, then: Then, on: string[], files: readonly string[] = []): typeof WAITING => {
    const { crew, plan, run } = step;
    const merges = (run.merges ??= []);
    const was = merges.find((each) => each.from === then.from);
    const sharers = sharersOf(plan);
    const byOwner = new Map<string | null, string[]>();
    for (const file of files) {
      const owner = ownerOf(file, sharers);
      byOwner.set(owner, [...(byOwner.get(owner) ?? []), file]);
    }
    const owners = [...byOwner.keys()].filter((owner) => owner !== null);
    const merging: Merging = {
      since: was?.since ?? now().toISOString(),
      ...then,
      on,
      ...(owners.length === 0 ? {} : { owners }),
      ...(was?.asked === true ? { asked: true as const } : {}),
    };
    if (was === undefined) merges.push(merging);
    else merges[merges.indexOf(was)] = merging;
    if (was === undefined) options.news(crew.builder, 'crew-waiting', `the merge into the crew branch waits for ${listed(on)}`);
    for (const owner of owners.filter((each) => !(was?.owners ?? []).includes(each))) {
      const agent = agentOf(run, owner);
      if (agent === undefined) continue;
      const text = `[agent-board] A merge into the crew branch waits on your uncommitted changes in ${listed(byOwner.get(owner)!)}. Finish them and hand off: the board commits them, then merges.`;
      queue(step, { key: `${owner}${MERGE_NUDGE}`, to: owner, item: { from: agent.sessionId, source: owner, name: 'note', text, why: '', back: agent.sessionId }, tell: true });
    }
    const nobodys = byOwner.get(null);
    if (nobodys !== undefined && !(was?.on ?? []).includes('the user')) {
      options.flag(
        crew.builder,
        `${crewFlag(crew.prefab)}can't merge into its crew branch yet: the merge touches uncommitted changes in its crew worktree, in no member's paths: ${listed(nobodys)}. Commit or undo them, and the merge goes on`,
      );
    }
    return WAITING;
  };

  /**
   * A merge held for the shared crew worktree, taken up again: made once no one it waits on is mid-turn, or at once on
   * Merge now. Past its deadline it asks the builder, once: Merge now, Wait longer, or stop the crew.
   */
  const mergeWaiting = async (step: Step) => {
    const { crew, plan, run } = step;
    for (const { from } of [...(run.merges ?? [])]) {
      const merging = run.merges?.find((each) => each.from === from);
      if (step.stopped) return;
      if (merging === undefined) continue;
      if (merging.asked !== true && merging.now !== true && now().getTime() >= mergeDeadline(plan, merging)) {
        merging.asked = true;
        options.flag(
          crew.builder,
          `${crewFlag(crew.prefab)}waited ${plan.member(merging.to)?.timeout ?? MERGE_WAIT_MINUTES} min to merge into its crew branch, for ${listed(merging.on)}: Merge now, Wait longer (agent-board crew round crew:${crew.id}), or Stop crew (agent-board crew stop crew:${crew.id})`,
        );
      }
      const input = plan.input(merging.from);
      if (input?.kind === 'end') await finish(step, input, merging.item);
      else await route(step, merging.from, merging.item);
    }
  };

  /** The shared crew worktree now: a record of its uncommitted work, the crew branch's tip, and the files changed. */
  const snapshot = async (step: Step): Promise<TurnStart | undefined> => {
    const crewBranch = step.run.crewBranch;
    if (crewBranch === undefined || options.shared === undefined) return undefined;
    try {
      const head = await options.shared.head(crewBranch.worktree, crewBranch.branch);
      const tree = await options.shared.record(crewBranch.worktree);
      return { tree, head, files: await options.shared.changed(crewBranch.worktree) };
    } catch (error) {
      options.log(`crew ${step.crew.id}: couldn't record its crew worktree (${(error as Error).message})`);
      return undefined;
    }
  };

  /** A snapshot of the shared crew worktree kept as a record, for Restore: the few last. */
  const keepRecord = (step: Step, why: string, at: TurnStart) => {
    const { run } = step;
    run.records = [...(run.records ?? []), { at: now().toISOString(), why, files: at.files.length, tree: at.tree, head: at.head }].slice(-RECORDS_KEPT);
  };

  /** A sharing member's turn begun, from the snapshot just before it: kept as a record, and for its hand-off. */
  const beginTurn = (step: Step, member: string, at: TurnStart) => {
    keepRecord(step, `before ${step.plan.label(member)}'s turn`, at);
    (step.run.turns ??= {})[member] = at;
  };

  /** A sharing member's turn about to begin: the snapshot to begin it from. */
  const beforeTurn = async (step: Step, member: string): Promise<TurnStart | undefined> => (sharing(step.plan, member) ? snapshot(step) : undefined);

  /** A commit or branch move the board didn't make on the crew branch, reported to the builder: the board goes on from it. */
  const movedByOthers = async (step: Step) => {
    const { crew, run } = step;
    const crewBranch = run.crewBranch;
    if (crewBranch === undefined || options.shared === undefined) return;
    const head = await options.shared.head(crewBranch.worktree, crewBranch.branch).catch(() => null);
    if (head === null || head === crewBranch.head) return;
    const was = crewBranch.head;
    crewBranch.head = head;
    if (was === undefined) return;
    const files = await options.shared.between(crewBranch.worktree, was, head).catch(() => []);
    const said = `the crew branch ${crewBranch.branch} moved to ${head.slice(0, 7)} without the board${files.length === 0 ? '' : `, changing ${listed(files)}`}`;
    options.news(crew.builder, 'crew-clash', said);
    options.flag(crew.builder, `${crewFlag(crew.prefab)}saw ${said}: check that's yours`);
  };

  /** Tells each member sharing the crew worktree that has paths among `files` which of its files: `what` heads it. */
  const tellOwners = (step: Step, files: readonly string[], what: string, but?: string) => {
    const { run } = step;
    for (const { member, writes } of sharersOf(step.plan)) {
      if (member === but) continue;
      const theirs = files.filter((file) => ownsPath(writes, file));
      const agent = agentOf(run, member);
      if (theirs.length === 0 || agent === undefined) continue;
      const text = `[agent-board] ${what} files in your paths: ${listed(theirs)}.`;
      queue(step, { key: `${member}>told:${randomBytes(3).toString('hex')}`, to: member, item: { from: agent.sessionId, source: member, name: 'note', text, why: '', back: agent.sessionId }, tell: true, note: true });
    }
  };

  /** What others changed in a sharing member's paths before it started, for its first prompt, if anything. */
  const changedForIt = (step: Step, member: string): string | undefined => {
    const theirs = (step.run.clashes ?? []).filter((each) => each.owner === member && each.by !== member);
    if (theirs.length === 0) return undefined;
    const by = [...new Set(theirs.map((each) => (each.by === null ? 'a member' : step.plan.label(each.by))))];
    return `Before you started, ${listed(by)} changed files in your paths: ${listed([...new Set(theirs.map((each) => each.path))])}. Keep, change or undo them: the board commits them with your work.`;
  };

  /** A clash in the shared crew worktree, once a path and member: told to both members and to the crew's news. */
  const clash = (step: Step, path: string, by: string | null, out = false) => {
    const { crew, plan, run } = step;
    // A path a symbolic link takes out of the worktree is in no member's paths: the board never commits through one.
    const owner = out ? null : ownerOf(path, sharersOf(plan));
    const clashes = (run.clashes ??= []);
    if (clashes.some((each) => each.path === path && each.by === by)) return;
    clashes.push({ path, by, owner, at: now().toISOString() });
    const who = by === null ? 'a member' : plan.label(by);
    const where = out
      ? `which a symbolic link takes out of the crew worktree, so the board commits none of it`
      : owner === null
        ? `outside every member's paths, so it stays uncommitted for the user`
        : `in ${plan.label(owner)}'s paths, so it stays uncommitted until ${plan.label(owner)} hands off`;
    options.news(crew.builder, 'crew-clash', `${who} changed ${path}, ${where}`);
    const agent = by === null ? undefined : agentOf(run, by);
    if (agent !== undefined) {
      const text = `[agent-board] You changed ${path}, which is ${out ? 'through a symbolic link out of the crew worktree' : owner === null ? 'in no member\'s paths' : `in ${plan.label(owner)}'s paths`}. Write only to your own; say what it needs in your hand-off.`;
      queue(step, { key: `${by}>clash:${path}`, to: by!, item: { from: agent.sessionId, source: by!, name: 'clash', text, why: '', back: agent.sessionId }, tell: true, note: true });
    }
    if (owner !== null && owner !== by) tellOwners(step, [path], `${who} changed`, by ?? undefined);
  };

  /**
   * A sharing member's hand-off, before it goes on: the board commits the changes in its own paths under its name,
   * naming who made any clash there (each closes), and finds the changes its turn made in others' paths, or in nobody's.
   * A record of the worktree is kept too.
   */
  const commitHandOff = async (step: Step, member: string, agent: Agent) => {
    const { crew, plan, run } = step;
    const crewBranch = run.crewBranch;
    const shared = options.shared;
    if (crewBranch === undefined || shared === undefined || !sharing(plan, member)) return;
    const worktree = crewBranch.worktree;
    await movedByOthers(step);
    const sharers = sharersOf(plan);
    const writes = sharers.find((each) => each.member === member)!.writes;
    let changed: string[];
    try {
      changed = await shared.changed(worktree);
    } catch (error) {
      options.flag(crew.builder, `${crewFlag(crew.prefab)}couldn't read its crew worktree at ${agent.name}'s hand-off (${(error as Error).message})`);
      return;
    }
    const at = await snapshot(step);
    if (at !== undefined) keepRecord(step, `${agent.name}'s hand-off`, at);
    // What its turn changed: the worktree since it began, but what came in by commits and merges meanwhile.
    const turn = run.turns?.[member];
    let during = changed;
    if (turn !== undefined && at !== undefined) {
      const inTurn = await shared.between(worktree, turn.tree, at.tree).catch(() => changed);
      const moved = turn.head === null || at.head === null || at.head === turn.head ? [] : await shared.between(worktree, turn.head, at.head).catch(() => []);
      during = inTurn.filter((file) => !moved.includes(file));
      // Uncommitted work there as it began, gone now but by a commit: its git wiped it, or it undid it.
      const lost = turn.files.filter((file) => !changed.includes(file) && !moved.includes(file));
      if (lost.length > 0) {
        run.lost = [...new Set([...(run.lost ?? []), ...lost])].sort();
        const said = `uncommitted work in ${listed(lost)} went from its crew worktree while ${agent.name}'s turn ran`;
        options.news(crew.builder, 'crew-clash', said);
        options.flag(crew.builder, `${crewFlag(crew.prefab)}saw ${said} (a git stash, reset or checkout, or an undo?): Restore puts it back`);
      }
    }
    if (turn?.next !== undefined) run.turns![member] = turn.next;
    else delete run.turns?.[member];
    // Its own changes, but one through a symbolic link, which is never committed.
    const own: string[] = [];
    for (const file of changed.filter((each) => ownsPath(writes, each))) {
      if (await shared.throughSymlink(worktree, file).catch(() => true)) {
        options.flag(crew.builder, `${crewFlag(crew.prefab)}didn't commit ${file} for ${agent.name}: it is reached through a symbolic link`);
      } else own.push(file);
    }
    const closing = (run.clashes ?? []).filter((each) => each.owner === member);
    if (own.length > 0) {
      const made = closing.filter((each) => each.by !== null && each.by !== member && own.includes(each.path));
      const message = [
        `${agent.name}: ${plan.label(member)}'s work`,
        ...(made.length === 0 ? [] : ['', ...made.map((each) => `${each.path} has a change by ${plan.label(each.by!)} in it.`)]),
      ].join('\n');
      const result = await shared.commit({ worktree, branch: crewBranch.branch, files: own, author: agent.name, message }).catch((error: Error) => ({ error: error.message }));
      if ('error' in result) {
        options.flag(crew.builder, `${crewFlag(crew.prefab)}couldn't commit ${agent.name}'s work on its crew branch: ${result.error}`);
        return;
      }
      if ('commit' in result) crewBranch.head = result.commit;
    }
    run.clashes = (run.clashes ?? []).filter((each) => each.owner !== member);
    // Changes in nobody's paths close once they are gone; its turn's changes outside its own are clashes.
    run.clashes = run.clashes.filter((each) => each.owner !== null || changed.includes(each.path));
    const busy = new Set(midTurn(step));
    for (const file of during) {
      if (ownsPath(writes, file)) continue;
      const owner = ownerOf(file, sharers);
      const ownerAgent = owner === null ? undefined : agentOf(run, owner);
      // In the paths of a member mid-turn, the change is likely that member's own.
      if (ownerAgent !== undefined && busy.has(ownerAgent.sessionId)) continue;
      clash(step, file, owner === null && busy.size > 0 ? null : member);
    }
  };

  /**
   * Whether the shared crew worktree keeps the crew from ready: a sharing member's uncommitted changes, an open clash,
   * or a change in nobody's paths. Flagged on the builder, with the files: commit it, undo it, or send it to its owner.
   */
  const notReady = async (step: Step, item: Item): Promise<boolean> => {
    const { crew, plan, run } = step;
    const crewBranch = run.crewBranch;
    if (crewBranch === undefined || options.shared === undefined || sharersOf(plan).length === 0) return false;
    const again = `agent-board crew round crew:${crew.id} tries again, and so does the next hand-off to the end`;
    let changed: string[];
    try {
      changed = await options.shared.changed(crewBranch.worktree);
    } catch (error) {
      options.flag(crew.builder, `${crewFlag(crew.prefab)}couldn't read its crew worktree to see that it is ready to merge (${(error as Error).message}): ${again}`);
      return true;
    }
    // A clash in no member's paths is over once its file is committed or undone.
    if (run.clashes !== undefined) run.clashes = run.clashes.filter((each) => each.owner !== null || changed.includes(each.path));
    // Work a turn took is back once its files are changed again.
    const lost = (run.lost ?? []).filter((file) => !changed.includes(file));
    if (lost.length > 0) run.lost = lost;
    else delete run.lost;
    const open = [...new Set([...changed, ...(run.clashes ?? []).map((each) => each.path)])].sort();
    if (open.length === 0 && lost.length === 0) return false;
    const gone = `lost uncommitted work in ${listed(lost)}`;
    const said =
      open.length === 0
        ? `isn't ready to merge: its crew worktree ${gone}`
        : `isn't ready to merge: its crew worktree has ${open.length === 1 ? 'a change' : 'changes'} not committed in ${listed(open)}${lost.length === 0 ? '' : `, and ${gone}`}`;
    const fix =
      open.length === 0
        ? `Restore puts it back. Or agent-board crew round crew:${crew.id} goes on without it`
        : `${lost.length === 0 ? '' : 'Restore puts it back. '}Commit it, undo it, or send it to its owner; then ${again}`;
    options.flag(crew.builder, `${crewFlag(crew.prefab)}${said}${open.length > 0 && lost.length > 0 ? ':' : '.'} ${fix}`);
    options.news(crew.builder, 'crew-waiting', `${item.why}, but the crew ${said}`);
    return true;
  };

  /**
   * A maker whose branch conflicts with the crew branch, or that left work uncommitted: sent back to it, as a round of
   * its loop gate, to merge the crew branch in and fix, or to commit. Twice running, the crew stops instead, for the
   * user: one more try, or take it over.
   */
  const sendMakerBack = (step: Step, maker: string, agent: Agent, why: 'conflict' | 'uncommitted', files: readonly string[], merged: readonly string[]) => {
    const { run } = step;
    const crewBranch = run.crewBranch!;
    const count = ((run.conflicts ??= {})[maker] ?? 0) + 1;
    run.conflicts[maker] = count;
    const inFiles = `${files.length} ${files.length === 1 ? 'file' : 'files'}`;
    const conflict = why === 'conflict';
    const send: Send = {
      key: `${maker}>${why}`,
      to: maker,
      item: {
        from: agent.sessionId,
        source: maker,
        name: why,
        text: conflict
          ? `[agent-board] Your branch conflicts with the crew branch in ${inFiles}: ${listed(files)}. Merge the crew branch (${crewBranch.branch}) into yours, fix them, and hand off.`
          : `[agent-board] You have uncommitted changes in ${inFiles}: ${listed(files)}. Commit them, and hand off: the crew merges your branch as you committed it.`,
        why: '',
        back: agent.sessionId,
      },
      tell: true,
    };
    const what = conflict ? `${agent.name}'s branch conflicts with the crew branch` : `${agent.name} has uncommitted changes`;
    const said = `${what} in ${inFiles} (${listed(files)}).${merged.map((name) => ` ${name}'s is merged.`).join('')}`;
    if (count > 1) {
      const twice = conflict ? `${agent.name}'s branch conflicted with its crew branch twice running` : `${agent.name} left changes uncommitted twice running`;
      hold(step, send, `${said} ${conflict ? 'It conflicted' : 'It left them uncommitted'} twice running`, `stopped: ${twice}, in ${listed(files)}`);
      return;
    }
    sendBack(step, send, said);
  };

  /** A conflict's send-back, as a round of its maker's loop gate: at that gate's limit the crew stops instead, asking. */
  const sendBack = (step: Step, send: Send, said: string) => {
    const { crew, plan, run } = step;
    const gate = plan.heads(send.to)[0];
    const state = gate === undefined ? undefined : run.gates[gate];
    const name = nameOf(send.item.back);
    if (state !== undefined && state.limit !== null && state.round >= state.limit) {
      run.atLimit = gate;
      const waiting = send.item.name === 'uncommitted' ? `${name}'s changes uncommitted` : `${name}'s branch conflicting with its crew branch`;
      hold(step, send, `${said} Its limit of ${rounds(state.limit)} is reached`, `stopped at its limit of ${rounds(state.limit)}, with ${waiting}`);
      return;
    }
    if (state !== undefined) state.pending = state.round;
    queue(step, state === undefined ? send : { ...send, again: { gate: gate!, round: state.round } });
    const round = state === undefined ? '' : `, round ${state.round + 1}${state.limit === null ? '' : ` of ${state.limit}`}`;
    options.news(crew.builder, 'round', `${said} Sent back to ${name}${round}.`, gate);
  };

  /** Stops the crew with `send` held, for `crew round` to make: one more try, or the user takes it over. */
  const hold = (step: Step, send: Send, said: string, flag: string) => {
    const { crew, run } = step;
    run.held = send;
    step.stopped = true;
    save(step);
    stop(crew, 'round-limit', said);
    options.flag(crew.builder, `${crewFlag(crew.prefab)}${flag}: agent-board crew round crew:${crew.id} for one more try, or take it over`);
  };

  /** Work that reaches Your OK: it waits there for the user's Go on or Send back. */
  const awaitUser = (step: Step, input: string, item: Item) => {
    step.run.waits[input] = { ...item, at: now().toISOString() };
    const { crew } = step;
    options.flag(crew.builder, `${crewFlag(crew.prefab)}waits for your OK on the work of ${nameOf(item.from)}: Go on or Send back`);
    options.news(crew.builder, 'crew-waiting', `the work of ${nameOf(item.from)} waits for your OK`);
  };

  /**
   * Work for `member` through its join: at once for one that takes each as it comes, or the only line in; else held
   * until each of its sources has sent this round's, and one its last went on without comes alone, marked late.
   */
  const toMember = async (step: Step, member: string, item: Item) => {
    const { plan, run } = step;
    if (!plan.joinsAll(member)) {
      queue(step, { key: `${item.source}>${member}`, to: member, item });
      return;
    }
    const state = (run.joins[member] ??= { since: null, got: {}, late: [] });
    if (state.late.includes(item.source) && state.got[item.source] === undefined) {
      state.late = state.late.filter((source) => source !== item.source);
      const line = `Late: ${plan.label(item.source)} reported after ${plan.label(member)} went on without it.`;
      queue(step, { key: `${item.source}>${member}:late`, to: member, item: { ...item, name: `late ${item.name}`, text: headed(line, item.text) } });
      return;
    }
    const first = state.since === null;
    state.got[item.source] = item;
    state.since ??= now().toISOString();
    const missing = plan.sources(member).filter((source) => state.got[source] === undefined);
    if (missing.length === 0) {
      await settleJoin(step, member, null);
      return;
    }
    if (first) {
      const timeout = plan.member(member)?.timeout;
      options.news(step.crew.builder, 'crew-waiting', `${plan.label(member)} waits for ${listed(missing.map(plan.label))}${timeout === undefined ? '' : `, ${timeout} min at most`}`);
    }
  };

  /**
   * A wait-for-all member's inputs, as one delivery: all of them, or what came, with a line naming what is missing
   * (`why` it went on without it). What is missing comes on its own once it does.
   */
  const settleJoin = async (step: Step, member: string, why: string | null) => {
    const { plan, run } = step;
    const state = run.joins[member];
    if (state === undefined) return;
    const sources = plan.sources(member);
    const items = sources.flatMap((source) => (state.got[source] === undefined ? [] : [state.got[source]]));
    const missing = sources.filter((source) => state.got[source] === undefined);
    const [lead] = items;
    if (lead === undefined) return;
    run.joins[member] = { since: null, got: {}, late: [...state.late, ...missing] };
    const input = plan.input(member);
    if (input?.kind === 'end') {
      const reason = [...new Set(items.map((each) => each.why).filter(Boolean))].join('; ');
      const reached: Item = { ...lead, why: missing.length === 0 ? reason : `${reason}, without ${listed(missing.map(plan.label))}` };
      if (!items.every((each) => each.approved === true)) delete reached.approved;
      const blocked = await finish(step, input, reached);
      // A maker sent back: what came through it comes again, the rest is kept.
      if (blocked !== undefined) {
        const through = (source: string) => source === blocked || upstreamMakers(plan.graph.lines, makersOf(plan), source).includes(blocked);
        if (blocked === NOT_READY) {
          run.joins[member] = state;
          save(step);
          return;
        }
        run.joins[member] = { since: state.since, got: Object.fromEntries(Object.entries(state.got).filter(([source]) => !through(source))), late: state.late };
        // Saved now: a send-back held at its limit stopped the crew (and saved it) with this join emptied.
        save(step);
      }
      return;
    }
    const line = why === null || missing.length === 0 ? null : missingLine(missing.map(plan.label), why);
    const text = items.length === 1 ? lead.text : items.map((each) => `${nameOf(each.from)}'s ${each.name}: ${each.text}`).join('\n\n');
    const notes = [...new Set(items.flatMap((each) => (each.note === undefined ? [] : [each.note])))];
    const joined: Item = { ...lead, name: items.length === 1 ? lead.name : 'hand-offs', text: headed(line, text), note: notes.join('\n\n') };
    if (notes.length === 0) delete joined.note;
    queue(step, { key: `join>${member}`, to: member, item: joined });
  };

  /** `item` on along the lines out of `from` (a member, loop gate or Your OK): never a loop gate's again line. */
  const route = async (step: Step, from: string, item: Item) => {
    const { plan, run } = step;
    const lines = plan.outs(from).filter((line) => line.way !== 'again' && plan.gate(line.to) === undefined);
    // Where makers' work meets, with a crew branch, their branches are merged into it first: an end merges them all.
    const makers = makersOf(plan);
    const meets = (to: string) => makers.has(to) || (plan.member(to) !== undefined && upstreamMakers(plan.graph.lines, makers, to).length > 1);
    if (run.crewBranch !== undefined && makers.size > 0 && lines.some((line) => meets(line.to))) {
      const through = makers.has(from) ? [from] : upstreamMakers(plan.graph.lines, makers, from);
      if ((await mergeMakers(step, through, { from, to: lines.find((line) => meets(line.to))!.to, item })) !== undefined) return;
    }
    for (const line of lines) {
      if (step.stopped) return;
      const input = plan.input(line.to);
      if (input?.kind === 'end') await end(step, input, item);
      else if (input?.kind === 'user') awaitUser(step, input.id, item);
      else if (input === undefined) await toMember(step, line.to, makers.has(line.to) && agentOf(run, line.to) !== undefined ? { ...item, text: headed(mergeFirst(run), item.text) } : item);
    }
  };

  /** The board's line to a maker already at work, as work comes to it from another: the crew branch has that work. */
  const mergeFirst = (run: Run) =>
    run.crewBranch === undefined ? null : `[agent-board] First merge the crew branch (${run.crewBranch.branch}) into yours: it has the other makers' work.`;

  /**
   * A decider's word, once its turn is over: what it left in its review, kept for the next round; one paused or
   * stopped by a restart carries on when resumed, so the crew waits for it; one gone, or ended for good, with no
   * review, left none, which counts as again. A same agent each round must have written it since its work came.
   */
  const readWord = (step: Step, reviewer: ReviewerRow): { again: boolean; text: string } | undefined => {
    const agent = options.agent(reviewer.session_id);
    if (agent !== undefined && !turnOver(agent)) return undefined;
    const path = agent === undefined ? undefined : join(agent.worktree, REVIEW);
    let text = path === undefined ? undefined : readText(path);
    const since = step.run.members[reviewer.member];
    if (text !== undefined && !step.plan.fresh(reviewer.member) && since?.session === reviewer.session_id && (writtenAt(path!) ?? 0) <= Date.parse(since.since)) {
      text = undefined;
    }
    // At its prompt with no review yet it may be asking something; paused, it carries on once woken.
    if (text === undefined && agent !== undefined && (agent.endedAt === null || endedForNow(agent))) return undefined;
    const doc = parseReviewDoc(text ?? '');
    const blockers = openFindings(doc).blocker;
    if (text !== undefined) {
      mkdirSync(join(options.dir, step.crew.id), { recursive: true });
      writeFileSync(keptReview(step.crew, reviewer.member, reviewer.round), text);
    }
    setReview.run(doc.verdict, text ?? '', blockers, step.crew.id, reviewer.session_id);
    return { again: !(doc.verdict === 'approve' && blockers === 0), text: text ?? '' };
  };

  /** The user's note from Your OK, as the board types it. */
  const userNote = (item: Item) => `[agent-board] The user let the work of ${nameOf(item.from)} go on from Your OK, and says: ${item.note}`;

  /** An agent's name as its sender mark has it, one gone too: as a delivery names it. */
  const markName = (sessionId: string) => options.agent(sessionId)?.name ?? names.get(sessionId) ?? 'another agent';

  /**
   * The work in a new agent's first prompt as a delivery types it (ADR-0023): under its sender's mark and head, on one
   * line, so no line of the sender's can start as the board's (`[agent-board] …`) and pass for the user's note. None
   * when there is nothing to hand off. The sender's name as a delivery has it, one gone too.
   */
  const markedWork = (item: Item) => handOffMessage(markName(item.from), agentRefOf(item.from), item.name, item.text);

  /** A decider as the crew names it: a fresh one by its agent (`code (round 2)`), one kept each round by its member. */
  const deciderName = (plan: CrewPlan, member: string, session: string) => (plan.fresh(member) ? nameOf(session) : plan.label(member));

  /** Reads the words each loop gate's deciders left this round, and those late for a round it went on without. */
  const readWords = async (step: Step) => {
    const { crew, plan, run } = step;
    for (const gate of plan.graph.gates) {
      const state = run.gates[gate.id]!;
      for (const reviewer of deciderRows(crew, plan, gate.id, state.round)) {
        if (step.stopped) return;
        if (state.words[reviewer.member] !== undefined || state.late[reviewer.session_id] !== undefined) continue;
        if (state.closed === state.round || state.pending !== undefined) continue;
        const word = readWord(step, reviewer);
        if (word === undefined) continue;
        state.words[reviewer.member] = { session: reviewer.session_id, ...word };
        const item: Item = { from: reviewer.session_id, source: reviewer.member, name: 'review.md', text: word.text, why: `${nameOf(reviewer.session_id)} reviewed`, back: reviewer.session_id };
        await route(step, reviewer.member, item);
      }
      for (const [session, round] of Object.entries(state.late)) {
        const reviewer = reviewersOf(crew.id, round).find((each) => each.session_id === session);
        const word = reviewer === undefined ? undefined : readWord(step, reviewer);
        if (reviewer === undefined || word === undefined) continue;
        delete state.late[session];
        const head = plan.head(gate.id);
        const name = deciderName(plan, reviewer.member, session);
        const line = `Late: ${name}'s review of round ${round}, after loop gate ${gate.id} went on without it.`;
        queue(step, {
          key: `${gate.id}>${head}:late:${session}`,
          to: head,
          item: { from: session, source: gate.id, name: `late review, round ${round}`, text: headed(line, word.text || `${name} left no review`), why: '', back: session },
          ...(plan.fresh(reviewer.member) ? { closeSender: true as const } : {}),
        });
      }
    }
  };

  /** Whether a member has handed off since `since`: by `handoff` (finished), or a turn ended on a new handover in `file`. */
  const handedOff = (agent: Agent, since: number, file: string): boolean => {
    if (agent.workFinishedAt !== null && Date.parse(agent.workFinishedAt) > since) return true;
    if (!turnOver(agent)) return false;
    const written = writtenAt(join(agent.worktree, file));
    return written !== undefined && written > since;
  };

  /**
   * Takes each member's new hand-off on along its lines: not a decider's (its review is its word), nor one of a loop's
   * head while that loop's round is under review, nor while it waits on the user.
   */
  const takeHandOffs = async (step: Step) => {
    const { plan, run } = step;
    for (const [member, state] of Object.entries(run.members)) {
      if (step.stopped) return;
      if (plan.decides(member) !== undefined) continue;
      const agent = options.agent(state.session);
      if (agent === undefined || waitsForUser(agent)) continue;
      if (plan.heads(member).some((gate) => run.gates[gate]!.announced && run.gates[gate]!.closed !== run.gates[gate]!.round)) continue;
      const since = Date.parse(state.since);
      const file = handoverOf(plan, member);
      if (!handedOff(agent, since, file)) continue;
      const handover = join(agent.worktree, file);
      const written = writtenAt(handover);
      const fresh = written !== undefined && written > since ? readText(handover) : undefined;
      state.since = now().toISOString();
      await commitHandOff(step, member, agent);
      const item: Item = {
        from: agent.sessionId,
        source: member,
        name: fresh === undefined ? 'final message' : 'handover.md',
        text: fresh ?? agent.lastMessage ?? '',
        why: `${agent.name} handed off`,
        back: agent.sessionId,
      };
      await route(step, member, item);
    }
  };

  /** Wait-for-all members past their timeout go on with what came. */
  const joinTimeouts = async (step: Step) => {
    for (const [member, state] of Object.entries(step.run.joins)) {
      if (step.stopped) return;
      const timeout = step.plan.member(member)?.timeout;
      if (state.since !== null && timeout !== undefined && now().getTime() >= Date.parse(state.since) + timeout * MINUTE) await settleJoin(step, member, afterMinutes(timeout));
    }
  };

  /**
   * Each loop gate's round: announced once each of its deciders has the round's work, and decided once each has given
   * its word, or at its timeout, or when the user goes on without the rest, each missing word counting as again.
   */
  const gates = async (step: Step) => {
    const { crew, plan, run } = step;
    for (const gate of plan.graph.gates) {
      if (step.stopped) return;
      const state = run.gates[gate.id]!;
      if (!open(state)) continue;
      const deciders = plan.deciders(gate.id);
      const rows = deciderRows(crew, plan, gate.id, state.round);
      if (!state.announced && deciders.every((member) => rows.some((each) => each.member === member)) && !run.outbox.some((send) => deciders.includes(send.to))) {
        state.announced = true;
        setStartFailed.run(0, null, crew.id);
        const reviewing = rows.map((each) => nameOf(each.session_id));
        const of = state.limit === null ? '' : ` of ${state.limit}`;
        options.news(crew.builder, 'round', `round ${state.round}${of}: ${reviewing.join(', ')} reviewing`, gate.id);
      }
      const missing = deciders.filter((member) => state.words[member] === undefined);
      const timedOut = gate.timeout !== null && now().getTime() >= Date.parse(state.openedAt!) + gate.timeout * MINUTE;
      const forced = step.forced.has(gate.id);
      if (missing.length > 0 && !timedOut && !forced) {
        if (gate.timeout !== null && state.announced && missing.length < deciders.length && state.waitSaid !== state.round) {
          state.waitSaid = state.round;
          const named = missing.map((member) => nameOf(rows.find((each) => each.member === member)?.session_id ?? member));
          options.news(crew.builder, 'crew-waiting', `loop gate ${gate.id} waits for ${listed(named)}, ${gate.timeout} min at most`, gate.id);
        }
        continue;
      }
      if (!state.announced && !timedOut && !forced) continue;
      await decided(step, gate.id, rows, missing, timedOut ? afterMinutes(gate.timeout!) : AS_THE_USER_SAID);
    }
  };

  /** A loop gate's round decided: its words go back to its loop's head, on along its done lines, or it asks at its cap. */
  const decided = async (step: Step, id: string, rows: ReviewerRow[], missing: string[], why: string) => {
    const { crew, plan, run } = step;
    const gate = plan.gate(id)!;
    const state = run.gates[id]!;
    const round = state.round;
    const decision = decide(gate, state, missing.length);
    // A fresh decider late for an earlier round reviewed an older commit: its word can come until this round decides.
    for (const [session, lateRound] of Object.entries(state.late)) {
      const reviewer = lateRound < round ? reviewersOf(crew.id, lateRound).find((each) => each.session_id === session) : undefined;
      if (reviewer === undefined || !plan.fresh(reviewer.member)) continue;
      delete state.late[session];
      if (options.agent(session) === undefined) continue;
      await options.close(session, `loop gate ${id} decided round ${round} without its late review`).catch((error: Error) => options.log(error.message));
    }
    if (decision === 'ask') {
      run.atLimit = id;
      step.stopped = true;
      save(step);
      stop(crew, 'round-limit', `changes still asked for after ${rounds(round)}`);
      options.flag(
        crew.builder,
        `${crewFlag(crew.prefab)}stopped at its limit of ${rounds(state.limit!)}, with changes still asked for: agent-board crew round crew:${crew.id} for one more, or take it over`,
      );
      return;
    }
    // Each review under its reviewer's name: the crew adds nothing of its own to what they wrote, but what is missing.
    const words = rows.flatMap((each) => {
      const word = state.words[each.member];
      return word === undefined ? [] : [{ ...word, name: deciderName(plan, each.member, word.session) }];
    });
    const missingNames = missing.map((member) => {
      const found = rows.find((each) => each.member === member);
      return found === undefined ? plan.label(member) : deciderName(plan, member, found.session_id);
    });
    const line = missing.length === 0 ? null : missingLine(missingNames, why);
    const from = words.find((word) => word.again) ?? words[0];
    const sender = from?.session ?? rows[0]?.session_id ?? crew.builder;
    const said =
      words.length === 1
        ? words[0]!.text === '' ? `${words[0]!.name} left no review` : words[0]!.text
        : words.map((word) => `${word.name}'s review: ${word.text === '' ? '(none left)' : word.text}`).join('\n\n');
    for (const member of missing) {
      const late = rows.find((each) => each.member === member);
      if (late !== undefined && options.agent(late.session_id) !== undefined) state.late[late.session_id] = round;
    }
    const head = plan.head(id);
    if (decision === 'again') {
      state.pending = round;
      queue(step, {
        key: `${id}>${head}`,
        to: head,
        item: { from: sender, source: id, name: `review, round ${round}`, text: headed(line, said), why: '', back: sender },
        again: { gate: id, round },
      });
      return;
    }
    state.closed = round;
    const atCap = decision === 'on' ? `Loop gate ${id} reached its limit of ${rounds(state.limit!)} with changes still asked for, so this goes on.` : null;
    const reason =
      gate.rule === 'rounds'
        ? `loop gate ${id} went its ${rounds(round)}`
        : decision === 'on'
          ? `loop gate ${id} went on at its limit of ${rounds(state.limit!)}`
          : `every reviewer of round ${round} approved`;
    const approved = decision === 'done' && gate.rule === 'done' && missing.length === 0;
    const item: Item = {
      from: sender,
      source: id,
      name: `review, round ${round}`,
      text: headed(atCap, headed(line, said)),
      why: reason,
      back: run.members[head]?.session ?? crew.builder,
      ...(approved ? { approved: true as const } : {}),
    };
    await route(step, id, item);
  };

  /** The agent `send` goes to as a new one: a decider with its round, else with the work it brings. */
  const spawnFor = async (step: Step, send: Send, round: number | null): Promise<Agent> => {
    const { crew, plan } = step;
    const member = plan.member(send.to)!;
    const builder = options.agent(crew.builder);
    // A builder in a ticket tile has its crew there too, as its helpers: the ticket's chat sees what they flag.
    const ticket = builder === undefined ? null : builder.ticketChat ? builder.sessionId : builder.ticket;
    const sender = options.agent(send.item.from);
    const branch = crewBase(step, member.id) ?? (sender !== undefined && sender.branch !== '' ? sender.branch : builder?.branch);
    const lastReview = round === null ? null : lastReviewOf(crew, member.id, round);
    // A member sharing the crew worktree starts in it, owning no worktree of its own.
    const crewBranch = step.run.crewBranch;
    const shares = crewBranch?.made === true && sharing(plan, member.id);
    const place: FolderPlace | undefined = shares ? { cwd: crewBranch.worktree, repoRoot: crewBranch.repoRoot, readOnly: false } : undefined;
    // A reviewer starts from the crew's prompt and reads the work on its branch; any other member is handed it too.
    const work = round !== null && plan.reviews(member.id) ? undefined : markedWork(send.item);
    // The crew's prompt is its starter's words: an agent's goes on one line under its mark (ADR-0023), so no line of it
    // can pass for the board's; the user's is as they wrote it.
    const starter = crew.started_by;
    const crewPrompt = starter === null ? crew.prompt : sentLine(markName(starter), agentRefOf(starter), crew.prompt);
    // A prompt that starts with the mark is read back as all the sender's (`readSender`, which trims a folded prompt's
    // start), the user's note after it too: with nothing of the brief or the user's crew prompt first, a plain line is.
    // Judged by what goes in, as an agent's prompt of nothing once on one line (control characters only) is left out.
    const unmarkedFirst = member.brief?.trim() || (starter === null && crew.prompt.trim());
    const lead = unmarkedFirst ? undefined : starter !== null && crewPrompt ? 'Your crew starts you with this prompt.' : work && 'Your crew hands you this work.';
    const prompt = [
      lead,
      member.brief,
      crewPrompt,
      work,
      lastReview === null ? undefined : `The last round's review is ${lastReview}: check each of its findings is fixed.`,
      send.item.note === undefined ? undefined : userNote(send.item),
      step.run.crewBranch !== undefined && makersOf(plan).has(member.id) ? MAKER_NOTE : undefined,
      shares ? sharerNote(plan.prefab, member.id) : undefined,
      shares ? changedForIt(step, member.id) : undefined,
    ]
      .filter(Boolean)
      .join('\n\n');
    const agent = await options.spawn(
      {
        zoneId: builder?.zoneId ?? crew.zone_id,
        harness: member.harness,
        ...(member.model === null ? {} : { model: member.model }),
        ...(member.effort === null ? {} : { effort: member.effort }),
        ...(member.role === null ? {} : { role: member.role }),
        ...(member.template === null ? {} : { template: member.template }),
        // Its own name, not the builder's (both would be made from the prompt), with its round if it decides one.
        name: round === null ? (member.name ?? member.id) : `${member.name ?? member.id} (round ${round})`,
        ...(branch === undefined || shares ? {} : { baseBranch: branch }),
        ...(ticket === null ? {} : { ticket }),
        prompt,
        ...REVIEWER_SIZE,
      },
      crew.started_by ?? undefined,
      round === null ? { template: null } : { template: null, crewReview: { round, previous: lastReview } },
      place,
    );
    names.set(agent.sessionId, agent.name);
    return agent;
  };

  /**
   * The branch a new member starts from, in a crew with a crew branch: a maker's own is cut from it, a member after one
   * maker alone checks out that maker's, and one where makers meet the crew branch itself. Undefined without one.
   */
  const crewBase = (step: Step, member: string): string | undefined => {
    const { plan, run } = step;
    const makers = makersOf(plan);
    if (run.crewBranch === undefined || (makers.size === 0 && sharersOf(plan).length === 0)) return undefined;
    if (makers.has(member)) return run.crewBranch.branch;
    const [only, ...more] = upstreamMakers(plan.graph.lines, makers, member);
    const agent = only === undefined || more.length > 0 ? undefined : agentOf(run, only);
    return agent === undefined ? run.crewBranch.branch : branchOf(agent);
  };

  /** A start that failed, flagged on the builder once a step: `crew round` tries again, as the sender's next work does. */
  const failed = (step: Step, send: Send, round: number | null, error: Error) => {
    send.failed = error.message;
    const { crew } = step;
    setStartFailed.run(1, error.message, crew.id);
    if (step.flagged) return;
    step.flagged = true;
    const what = round === null ? step.plan.label(send.to) : `round ${round}'s reviewers`;
    options.flag(
      crew.builder,
      `${crewFlag(crew.prefab)}couldn't start ${what} (${error.message}): agent-board crew round crew:${crew.id} tries again, and so does ${nameOf(send.item.from)}'s next hand-off`,
    );
  };

  /** A loop gate's again, landed: its next round begins, and the deciders that gave their word are closed if fresh. */
  const landed = async (step: Step, gate: string, round: number, to: string) => {
    const state = step.run.gates[gate]!;
    if (state.pending !== round) return;
    const gave = Object.entries(state.words).filter(([member]) => step.plan.fresh(member));
    Object.assign(state, { round: round + 1, words: {}, openedAt: null, announced: false, pending: undefined });
    delete state.pending;
    save(step);
    for (const [, word] of gave) {
      if (options.agent(word.session) === undefined) continue;
      await options.close(word.session, `its review went back to ${nameOf(to)}`).catch((error: Error) => options.log(error.message));
    }
  };

  /**
   * Makes one delivery: to a decider, starting its agent for the round (once a round), or delivering to the same agent;
   * to another member, starting a fresh one or one it has none of, else delivering to it. One that can't land yet
   * (the agent busy) waits for the next step.
   */
  const sendOne = async (step: Step, send: Send): Promise<void> => {
    const { crew, plan, run } = step;
    const done = () => {
      run.outbox = run.outbox.filter((each) => each !== send);
    };
    const notYet = (reason: string) => options.log(`crew ${crew.id}: ${send.item.name} didn't reach ${plan.label(send.to)} yet (${reason})`);
    const held = run.merges ?? [];
    // A merge waiting on the shared crew worktree holds its members' new turns until it is made: but the turns of those
    // whose uncommitted files it waits on, which their hand-offs commit.
    if (sharing(plan, send.to) && held.length > 0 && !held.some((each) => each.owners?.includes(send.to) === true)) return notYet('a merge into the crew worktree waits');
    // A turn that begins here is recorded from just before it: anything typed at an idle prompt begins one, and what
    // reaches a member mid-turn begins none.
    const current = agentOf(run, send.to);
    const before = current !== undefined && !turnOver(current) ? undefined : await beforeTurn(step, send.to);
    // One begun before the last one's hand-off is taken starts from its own record, once that hand-off is.
    const began = () => {
      if (before === undefined) return;
      const open = run.turns?.[send.to];
      if (open === undefined) beginTurn(step, send.to, before);
      else {
        keepRecord(step, `before ${plan.label(send.to)}'s turn`, before);
        open.next = before;
      }
    };
    if (send.tell === true) {
      const sent = (await options.tell?.(send.item.back, send.item.text)) ?? { started: false, reason: 'the board types at no prompt here' };
      if (!sent.started) return notYet(sent.reason);
      began();
      done();
      const member = memberOf(run, send.item.back);
      if (member !== undefined && send.note !== true) run.members[member]!.since = now().toISOString();
      if (send.again !== undefined) await landed(step, send.again.gate, send.again.round, send.item.back);
      return;
    }
    const gate = plan.decides(send.to);
    const state = gate === undefined ? undefined : run.gates[gate]!;
    if (state !== undefined && state.closed === state.round) {
      Object.assign(state, { round: state.round + 1, words: {}, openedAt: null, announced: false, late: state.late });
      delete state.closed;
    }
    if (state !== undefined && deciderRows(crew, plan, gate!, state.round).some((each) => each.member === send.to)) return done();
    const existing = send.to === plan.first.id ? { session: crew.builder, since: '' } : run.members[send.to];
    const agent = existing === undefined ? undefined : options.agent(existing.session);
    let session: string;
    if (send.to !== plan.first.id && (agent === undefined || plan.fresh(send.to))) {
      try {
        session = (await spawnFor(step, send, state?.round ?? null)).sessionId;
        began();
      } catch (error) {
        failed(step, send, state?.round ?? null, error as Error);
        return;
      }
    } else {
      if (agent === undefined) return notYet(`${nameOf(existing!.session)} is gone`);
      if (send.item.note !== undefined && send.noted !== true) {
        // The user's note first, as the board's own message: under the sender's mark it would read as the sender's.
        const told = (await options.tell?.(agent.sessionId, `${userNote(send.item)}\n\nThat work comes to you next, as its own message.`)) ?? {
          started: false,
          reason: 'the board types at no prompt here',
        };
        if (told.started) {
          send.noted = true;
          began();
          save(step);
          return notYet('the user’s note went first');
        }
        if (told.busy === true) return notYet(told.reason);
        // Ended: the work starts it again, and the note follows it.
        queue(step, { key: `${send.key}:note`, to: send.to, item: { ...send.item, back: agent.sessionId, text: userNote(send.item) }, tell: true, note: true });
        send.noted = true;
      }
      const sent = await options.deliver(send.item.from, agent.sessionId, send.item.name, send.item.text);
      if (!sent.started) return notYet(sent.reason);
      session = agent.sessionId;
      began();
      // A decider kept each round that was late for the last: its word from now on is this round's.
      if (state !== undefined) delete state.late[session];
    }
    done();
    run.members[send.to] = { session, since: now().toISOString() };
    if (state !== undefined) {
      insertReviewer.run(crew.id, session, send.to, state.round);
      state.openedAt ??= now().toISOString();
    }
    save(step);
    if (send.again !== undefined) await landed(step, send.again.gate, send.again.round, session);
    if (send.closeSender === true && options.agent(send.item.from) !== undefined) {
      await options.close(send.item.from, `its late review went to ${nameOf(session)}`).catch((error: Error) => options.log(error.message));
    }
  };

  /** Makes each delivery due, until there are none it hasn't tried this step: a stop on the way ends it. */
  const sendAll = async (step: Step) => {
    for (;;) {
      await gates(step);
      if (step.stopped) return;
      const next = step.run.outbox.find((send) => send.failed === undefined && !step.tried.has(send));
      if (next === undefined) return;
      step.tried.add(next);
      await sendOne(step, next);
      if (!stillRunning(step.crew.id)) {
        step.stopped = true;
        return;
      }
    }
  };

  /** What the user or an orchestrator asked of the crew since its last step. */
  const actions = new Map<string, Action[]>();
  /** Into the crew's own queue, never a copy: a step taking it then takes one that comes meanwhile too, once. */
  const ask = (id: string, action: Action) => {
    const queued = actions.get(id);
    if (queued === undefined) actions.set(id, [action]);
    else queued.push(action);
  };

  const applyActions = async (step: Step) => {
    const { plan, run } = step;
    const queued = actions.get(step.crew.id) ?? [];
    // One at a time: an answer behind one that stops the crew stays queued, so its call is refused, not lost.
    while (!step.stopped && queued.length > 0) {
      const action = queued.shift()!;
      if (action.kind === 'retry') {
        for (const send of run.outbox) delete send.failed;
      } else if (action.kind === 'more') {
        const gate = run.atLimit === undefined ? undefined : run.gates[run.atLimit];
        if (gate !== undefined) gate.limit = (gate.limit ?? gate.round) + 1;
        delete run.atLimit;
        // One more try for a maker whose branch conflicted: sent back, the next conflict stopping the crew again.
        const held = run.held;
        delete run.held;
        if (held !== undefined) {
          if (run.conflicts?.[held.to] !== undefined) run.conflicts[held.to] = 1;
          // At its loop gate's limit, the try is one more round of it: else it would stop again at once.
          const head = plan.heads(held.to)[0];
          const state = head === undefined ? undefined : run.gates[head];
          if (state !== undefined && state.limit !== null && state.round >= state.limit) state.limit = state.round + 1;
          sendBack(step, held, `${nameOf(held.item.back)} has one more try.`);
        }
      } else if (action.kind === 'go-on') {
        const waiting = run.waits[action.input];
        if (waiting === undefined) continue;
        delete run.waits[action.input];
        const item: Item & { at?: string } = { ...waiting };
        delete item.at;
        const note = [item.note, action.note?.trim()].filter(Boolean).join('\n\n');
        if (note === '') delete item.note;
        else item.note = note;
        await route(step, action.input, { ...item, source: action.input, why: 'the user said go on' });
      } else if (action.kind === 'send-back') {
        const waiting = run.waits[action.input];
        if (waiting === undefined) continue;
        delete run.waits[action.input];
        queue(step, { key: `${action.input}>back`, to: memberOf(run, waiting.back) ?? plan.first.id, item: { ...waiting, text: `The user sent your work back from Your OK: ${action.note}` }, tell: true });
      } else if (action.kind === 'edited') {
        await edits(step, action.session, action.files);
      } else if (action.kind === 'merge-now') {
        for (const merging of run.merges ?? []) if (merging.to === action.to) merging.now = true;
      } else if (action.kind === 'wait-longer') {
        for (const merging of run.merges ?? []) {
          if (merging.asked !== true) continue;
          merging.since = now().toISOString();
          delete merging.asked;
        }
      } else if (action.kind === 'ready-again') {
        const unready = run.unready;
        const input = unready === undefined ? undefined : plan.input(unready.input);
        if (input?.kind !== 'end') continue;
        // The user goes on without the work a turn lost.
        delete run.lost;
        // Work that met there from several lines meets again, as it did.
        if (run.joins[input.id]?.since != null) await settleJoin(step, input.id, null);
        else await finish(step, input, unready!.item);
      } else if (action.kind === 'restore') {
        await restore(step);
      } else if (plan.gate(action.at) !== undefined) {
        step.forced.add(action.at);
      } else {
        await settleJoin(step, action.at, AS_THE_USER_SAID);
      }
    }
  };

  /**
   * What a member's harness says it edited: in the shared crew worktree, outside its own paths, a clash. So is a path
   * there that a symbolic link takes out of it, which is in no member's paths.
   */
  const edits = async (step: Step, session: string, files: readonly string[]) => {
    const { plan, run } = step;
    const member = memberOf(run, session);
    const crewBranch = run.crewBranch;
    if (member === undefined || crewBranch === undefined || !sharing(plan, member)) return;
    const writes = sharersOf(plan).find((each) => each.member === member)!.writes;
    const root = await realOr(crewBranch.worktree);
    const inside = (from: string, file: string) => {
      const path = relative(from, file).split(sep).join('/');
      return path === '' || path === '..' || path.startsWith('../') || isAbsolute(path) ? undefined : path;
    };
    for (const file of files) {
      const real = inside(root, await realOr(file));
      const named = real ?? inside(crewBranch.worktree, file) ?? inside(root, file);
      if (named === undefined || named.startsWith('.agent-board/')) continue;
      if (real === undefined) clash(step, named, member, true);
      else if (!ownsPath(writes, real)) clash(step, real, member);
    }
  };

  /**
   * Puts back, for the user, the uncommitted work the crew worktree's newest record that lost some has lost: files it
   * changed that are now as committed, and that no commit changed since. Its files are named.
   */
  const restore = async (step: Step) => {
    const { crew, run } = step;
    const crewBranch = run.crewBranch;
    const shared = options.shared;
    if (crewBranch === undefined || shared === undefined) return;
    try {
      for (const record of [...(run.records ?? [])].reverse()) {
        if (record.head === null || (await shared.lost(crewBranch.worktree, record.tree, record.head)).length === 0) continue;
        const files = await shared.restore(crewBranch.worktree, record.tree, record.head);
        options.news(crew.builder, 'crew-clash', `put back ${listed(files)} in the crew worktree, from its record ${record.why}`);
        return;
      }
      options.news(crew.builder, 'crew-clash', `the crew worktree has lost none of the work its records hold`);
    } catch (error) {
      options.flag(crew.builder, `${crewFlag(crew.prefab)}couldn't put back its crew worktree's work (${(error as Error).message})`);
    }
  };

  /** Moves the crew on one step, if it can. */
  const advance = async (id: string): Promise<void> => {
    const crew = row(id);
    if (crew === undefined) return;
    const builder = options.agent(crew.builder);
    // Its pull request merged: the crew closes its agents and their worktrees, unless the user took it over. With a
    // crew branch, that is the crew branch's; the builder's own merging is only its part of the work, so the crew stops.
    const run = runOf(crew);
    const crewBranch = run.crewBranch;
    const ownMerged = builder?.pullRequests.some((pr) => pr.state === 'merged') === true;
    const recorded = builder === undefined ? [] : [...(builder.recordedPullRequests ?? []), ...(builder.pushedPullRequests ?? [])];
    const crewMerged = crewBranch?.pr !== undefined && recorded.some((pr) => pr.url === crewBranch.pr && pr.state === 'merged');
    const closable = builder !== undefined && crew.stopped !== 'stopped' && crew.stopped !== 'merged' && crew.stopped !== 'done';
    if (closable && (crewBranch === undefined ? ownMerged : crewMerged)) {
      stop(crew, 'merged', `${builder.name}'s pull request was merged, so the crew closed its agents`);
      await closeAll(crew, run, `its crew's pull request was merged`, 'after the merge', false);
      return;
    }
    // Once the crew's own pull request is open, it holds the work: the builder's merging first changes nothing.
    if (closable && crewBranch !== undefined && crewBranch.pr === undefined && ownMerged) {
      stop(crew, 'stopped', `${builder.name}'s own pull request was merged, not its crew branch's, so the crew stopped`);
      await release(crew, run, `stopped: ${builder.name}'s own pull request was merged, not its crew branch's`);
      return;
    }
    if (crew.stopped === 'stopped' || crew.stopped === 'builder-gone') return release(crew, run);
    // A crew waiting at its round limit, or on its pull request, keeps its crew worktree for its builder: with the
    // builder gone, no one comes back to it.
    const waiting = crew.stopped === 'round-limit' || crew.stopped === 'ready-to-merge';
    if (crew.stopped !== null && !(waiting && builder === undefined && crewBranch?.made === true)) return;
    if (builder === undefined) {
      stop(crew, 'builder-gone', `${nameOf(crew.builder)} is gone`);
      return release(row(id)!, run);
    }
    const step: Step = { crew, plan: planFor(crew), run, stopped: false, flagged: false, tried: new Set(), forced: new Set() };
    if (step.run.crewBranch?.made !== true && sharing(step.plan, step.plan.first.id)) {
      // A builder sharing it: its own branch and worktree are the crew's.
      const head = (await options.shared!.head(builder.worktree, branchOf(builder)).catch(() => null)) ?? undefined;
      step.run.crewBranch = { repoRoot: builder.repoRoot, branch: branchOf(builder), worktree: builder.worktree, made: true, adopted: true, ...(head === undefined ? {} : { head }) };
      save(step);
    } else if (step.run.crewBranch?.made !== true && (makersOf(step.plan).size > 0 || sharersOf(step.plan).length > 0)) {
      // One that failed to cut is tried again at `crew round`, not at every step: each try would flag it again.
      if (crew.start_failed === 1 && !(actions.get(id) ?? []).some((action) => action.kind === 'retry')) return;
      if (!(await cutCrewBranch(step, builder))) return;
    }
    if (step.run.turns?.[step.plan.first.id] === undefined && sharing(step.plan, step.plan.first.id) && step.run.members[step.plan.first.id]?.since === crew.started_at) {
      // The builder's first turn began as the crew started.
      const at = await snapshot(step);
      if (at !== undefined) beginTurn(step, step.plan.first.id, at);
    }
    await applyActions(step);
    if (!step.stopped) await mergeWaiting(step);
    if (!step.stopped) await readWords(step);
    if (!step.stopped) await takeHandOffs(step);
    if (!step.stopped) await joinTimeouts(step);
    if (!step.stopped) await sendAll(step);
    if (step.stopped) return;
    save(step);
    if (step.run.outbox.every((send) => send.failed === undefined) && row(id)?.start_failed === 1) setStartFailed.run(0, null, id);
  };

  /** Cuts the crew branch from its builder's, as the crew takes its first step; one that fails is flagged, for `crew round`. */
  const cutCrewBranch = async (step: Step, builder: Agent): Promise<boolean> => {
    const { crew } = step;
    try {
      // Placed and saved first, so a daemon that stops part-way finds it cut, rather than cutting a second.
      if (step.run.crewBranch === undefined) {
        step.run.crewBranch = await options.branches!.place(builder.repoRoot, branchOf(builder));
        save(step);
      }
      step.run.crewBranch = { ...(await options.branches!.cut(builder.repoRoot, branchOf(builder), step.run.crewBranch)), made: true };
      const head = await options.shared?.head(step.run.crewBranch.worktree, step.run.crewBranch.branch).catch(() => null);
      if (head != null) step.run.crewBranch.head = head;
      save(step);
      return true;
    } catch (error) {
      const message = (error as Error).message;
      setStartFailed.run(1, message, crew.id);
      options.flag(crew.builder, `${crewFlag(crew.prefab)}couldn't cut its crew branch from ${branchOf(builder) || 'no branch'} (${message}): agent-board crew round crew:${crew.id} tries again`);
      return false;
    }
  };

  /** How many of the crew's timeouts have passed: each that passes is a step to take. */
  const due = (crew: CrewRow) => deadlines(planFor(crew), runOf(crew)).filter((at) => at <= now().getTime()).length;

  /**
   * What a step of the crew reads: its rows, what each of its agents is doing, what was asked of it, and its timeouts
   * passed. A step taken on the same inputs as the last would do the same again, so it isn't taken.
   */
  const inputs = (id: string): string => {
    const crew = row(id);
    if (crew === undefined) return '';
    const reviewers = reviewersOf(id);
    const sessions = new Set([crew.builder, ...reviewers.map((reviewer) => reviewer.session_id), ...Object.values(runOf(crew).members).map((member) => member.session)]);
    const agents = [...sessions].map((sessionId) => {
      const agent = options.agent(sessionId);
      return agent === undefined
        ? null
        : [agent.state, agent.endedAt, agent.hibernated?.at, agent.workFinishedAt, agent.flag?.id, agent.permissions.length, agent.ask !== null, agent.plan?.decision, agent.pullRequests.map((pr) => pr.state), agent.recordedPullRequests?.map((pr) => pr.state)];
    });
    return JSON.stringify([crew, reviewers, agents, actions.get(id)?.length ?? 0, crew.stopped === null ? due(crew) : 0]);
  };

  // A timer for each crew's next timeout, set again after each step.
  const timers = new Map<string, () => void>();
  const schedule = (id: string) => {
    timers.get(id)?.();
    timers.delete(id);
    const crew = closing ? undefined : row(id);
    if (crew === undefined || crew.stopped !== null) return;
    const at = Math.min(...deadlines(planFor(crew), runOf(crew)).filter((each) => each > now().getTime()));
    if (at === Infinity) return;
    timers.set(id, clock.setTimer(() => void move(id), at - now().getTime()));
  };

  // One step at a time for each crew. An update heard meanwhile (often of the crew's own doing: a start, a hand-off
  // announced) takes another once that one is done, but only if something it reads has changed.
  const moving = new Map<string, Promise<void>>();
  const again = new Set<string>();
  const move = (id: string): Promise<void> => {
    if (closing) return Promise.resolve();
    const under = moving.get(id);
    if (under !== undefined) {
      again.add(id);
      return under;
    }
    // Begun on a later tick, so it is under way before anything it does is heard back here.
    const run = Promise.resolve()
      .then(async () => {
        let last: string | undefined;
        for (;;) {
          again.delete(id);
          // Closing finalizes the statements inputs reads: check it first.
          if (closing) return;
          const now = inputs(id);
          if (now === last) return;
          last = now;
          await advance(id).catch((error: Error) => options.log(`crew ${id}: ${error.message}`));
          // Each step shows as it is taken: the next may take a while (a reviewer starting).
          changed(id);
          if (!again.has(id)) return;
          // Let the daemon's other work run between steps.
          await new Promise((resolve) => setImmediate(resolve));
        }
      })
      .finally(() => {
        moving.delete(id);
        if (closing) return;
        schedule(id);
        // An update heard during a step may change only what the card shows (a name, who needs you), with no step to take.
        changed(id);
      });
    moving.set(id, run);
    return run;
  };

  const crewNamed = (crewId: string): CrewRow => {
    const id = crewId.replace(/^crew:/, '');
    const found = row(id);
    if (found === undefined) throw invalidParams(`there is no crew ${crewId}: agent-board crew lists them`);
    return found;
  };

  return {
    reviewOf(sessionId) {
      const reviewer = selectReviewer.get(sessionId) as unknown as ReviewerRow | undefined;
      const crew = reviewer === undefined ? undefined : row(reviewer.crew_id);
      if (reviewer === undefined || crew === undefined) return undefined;
      return { round: reviewer.round, previous: lastReviewOf(crew, reviewer.member, reviewer.round) };
    },
    start(prefab, builderId, startedBy, prompt) {
      const builder = options.agent(builderId);
      if (builder === undefined) return null;
      const plan = planOf(prefab);
      if (!prefab.members.some((member) => member.starts === 'handoff') && !plan.graph.inputs.some((input) => input.kind === 'user')) return null;
      const id = randomBytes(4).toString('hex');
      const at = now().toISOString();
      names.set(builder.sessionId, builder.name);
      const run = emptyRun();
      run.members[plan.first.id] = { session: builder.sessionId, since: at };
      for (const gate of plan.graph.gates) run.gates[gate.id] = newGateRun(gate);
      const first = plan.graph.gates[0];
      const limit = first === undefined ? 0 : (run.gates[first.id]!.limit ?? 0);
      insertCrew.run(id, prefab.name, prefabFile(prefab), builder.zoneId, startedBy, builder.sessionId, prompt, limit, at, at, JSON.stringify(run));
      changed(id);
      // A builder sharing the crew worktree is at work already: its crew branch and first record are taken at once.
      if (sharing(plan, plan.first.id)) void move(id);
      return view(row(id)!);
    },

    observe(agent) {
      if (closing) return;
      names.set(agent.sessionId, agent.name);
      for (const { id } of crewsOf.all(agent.sessionId, agent.sessionId, `"${agent.sessionId}"`) as { id: string }[]) void move(id);
    },

    edited(sessionId, files) {
      if (closing || files.length === 0) return;
      for (const { id } of crewsOf.all(sessionId, sessionId, `"${sessionId}"`) as { id: string }[]) {
        if (row(id)?.stopped !== null) continue;
        ask(id, { kind: 'edited', session: sessionId, files });
        void move(id);
      }
    },

    resume() {
      for (const crew of selectRunning.all() as unknown as CrewRow[]) void move(crew.id);
    },

    list: () => (selectCrews.all() as unknown as CrewRow[]).map(view),

    card(crewId) {
      const crew = row(crewId);
      if (crew === undefined) return undefined;
      const prefab = planFor(crew).prefab;
      return {
        crewId: crew.id,
        title: cardTitle(crew.prompt, crew.prefab),
        icon: prefab.icon,
        tiles: prefab.onBoard === 'tiles',
        members: prefab.members.map((member) => ({
          id: member.id,
          name: member.name ?? member.id,
          role: member.role,
          harness: member.harness,
          model: member.model,
          starts: member.starts,
        })),
        crew: view(crew),
        phaseAt: crew.phase_at,
        startFailed: crew.start_failed === 1,
        startError: crew.start_failed === 1 ? crew.start_error : null,
      };
    },

    async idle() {
      while (moving.size > 0) await Promise.all(moving.values());
    },

    close() {
      closing = true;
      for (const cancel of timers.values()) cancel();
      timers.clear();
    },

    handlers<Context extends BoardConnection>(access: OrchestratorAccess): RpcHandlers<CrewMethods, Context> {
      /** Whether `me` reaches the crew: any agent does while its builder is on the board, else the one that started it. */
      const reaches = (me: Orchestrator, crew: CrewRow) => me.agent === null || options.agent(crew.builder) !== undefined || crew.started_by === me.sessionId;
      const reached = (me: Orchestrator, crewId: string): CrewRow => {
        const crew = crewNamed(crewId);
        if (!reaches(me, crew)) throw new RpcMethodError(BOARD_ERROR.outOfScope, `crew:${crew.id}'s builder is gone, and you didn't start it`);
        return crew;
      };
      const logged = (crew: CrewRow) => ({ id: `crew:${crew.id}`, name: crew.prefab });
      /** Clears the builder's flag if it is the crew's own: answered, by what the user asks of the crew now. */
      const clearOwnFlag = (crew: CrewRow) => {
        if (options.agent(crew.builder)?.flag?.reason.startsWith(crewFlag(crew.prefab)) === true) options.clearFlag(crew.builder);
      };

      /**
       * One of the user's own answers to a running crew, logged: refused to an agent, as the user's to give. `act`
       * says what to ask of the crew, or throws for a crew with nothing of the kind waiting.
       */
      const usersAnswer = (method: keyof CrewMethods, action: OrchestratorAction, act: (crew: CrewRow, run: Run, fields: Record<string, unknown>) => Action) =>
        (params: unknown, connection: Context) => {
          const fields = paramsObject(params);
          const me = access.caller(method, fields, connection);
          const entry: ActivityEntry = { detail: String(fields.crewId ?? '') };
          return access.logged(me, action, entry, async () => {
            if (me.agent !== null) throw new RpcMethodError(BOARD_ERROR.notAllowed, `${method} is the user's own answer to a crew: an agent may not give it`);
            const crew = reached(me, stringParam(fields, 'crewId'));
            entry.on = logged(crew);
            entry.detail = crew.prefab;
            if (crew.stopped !== null) throw invalidParams(`crew:${crew.id} has stopped (${crew.stopped})`);
            const answer = act(crew, runOf(crew), fields);
            ask(crew.id, answer);
            clearOwnFlag(crew);
            await move(crew.id);
            // Answered only once a step took it and saved where the crew is: one the daemon stopped first is refused, not lost.
            const left = actions.get(crew.id) ?? [];
            if (left.includes(answer)) {
              left.splice(left.indexOf(answer), 1);
              const stopped = row(crew.id)?.stopped ?? null;
              throw new Error(
                stopped !== null && !closing ? `crew:${crew.id} has stopped (${stopped}): nothing waits for an answer now` : `crew:${crew.id} couldn't take that now (the board is stopping): try again`,
              );
            }
            return view(row(crew.id)!);
          });
        };
      /** The Your OK the user answers: the one named, or the only one with work waiting. */
      const waitingAt = (crew: CrewRow, run: Run, fields: Record<string, unknown>): string => {
        const input = optionalStringParam(fields, 'input');
        const waiting = Object.keys(run.waits);
        if (input !== undefined && waiting.includes(input)) return input;
        if (input === undefined && waiting.length === 1) return waiting[0]!;
        if (waiting.length === 0) throw invalidParams(`crew:${crew.id} has no work waiting for your OK`);
        throw invalidParams(`crew:${crew.id} has work waiting for your OK at ${listed(waiting)}: name one`);
      };

      return {
        'orchestrator.crews': (params, connection) => {
          const fields = paramsObject(params);
          const me = access.caller('orchestrator.crews', fields, connection);
          const crewId = optionalStringParam(fields, 'crewId');
          if (crewId !== undefined) return [view(reached(me, crewId))];
          return (selectCrews.all() as unknown as CrewRow[]).filter((crew) => reaches(me, crew)).map(view);
        },
        'orchestrator.stopCrew': (params, connection) => {
          const fields = paramsObject(params);
          const me = access.caller('orchestrator.stopCrew', fields, connection);
          const entry: ActivityEntry = { detail: String(fields.crewId ?? '') };
          return access.logged(me, 'stop-crew', entry, () => {
            const crew = reached(me, stringParam(fields, 'crewId'));
            entry.on = logged(crew);
            entry.detail = crew.prefab;
            if (crew.stopped !== null) throw invalidParams(`crew:${crew.id} has stopped already (${crew.stopped})`);
            stop(crew, 'stopped', `stopped by ${me.agent === null ? 'the user' : me.name}`);
            schedule(crew.id);
            // Its next step, after any under way, removes its crew worktree.
            void move(crew.id);
            changed(crew.id);
            return view(row(crew.id)!);
          });
        },
        'orchestrator.crewRound': (params, connection) => {
          const fields = paramsObject(params);
          const me = access.caller('orchestrator.crewRound', fields, connection);
          const entry: ActivityEntry = { detail: String(fields.crewId ?? '') };
          return access.logged(me, 'crew-round', entry, async () => {
            const crew = reached(me, stringParam(fields, 'crewId'));
            entry.on = logged(crew);
            entry.detail = crew.prefab;
            // A start that failed: it is tried again now, whether or not its flag was dismissed.
            if (crew.stopped === null && crew.start_failed === 1) {
              clearOwnFlag(crew);
              ask(crew.id, { kind: 'retry' });
            } else if (crew.stopped === null && runOf(crew).merges?.some((each) => each.asked === true) === true) {
              clearOwnFlag(crew);
              ask(crew.id, { kind: 'wait-longer' });
            } else if (crew.stopped === null && runOf(crew).unready !== undefined) {
              clearOwnFlag(crew);
              ask(crew.id, { kind: 'ready-again' });
            } else if (crew.stopped === 'round-limit') {
              const atLimit = runOf(crew).atLimit;
              restart.run(atLimit === planFor(crew).graph.gates[0]?.id ? crew.round_limit + 1 : crew.round_limit, crew.id);
              clearOwnFlag(crew);
              ask(crew.id, { kind: 'more' });
            } else {
              throw invalidParams(
                `crew:${crew.id} ${crew.stopped === null ? 'is still running' : `stopped ${crew.stopped}`}: crew round gives one more round to a crew stopped at its round limit, or starts again a round that failed to start`,
              );
            }
            await move(crew.id);
            return view(row(crew.id)!);
          });
        },
        'orchestrator.crewGoOn': usersAnswer('orchestrator.crewGoOn', 'crew-go-on', (crew, run, fields) => ({
          kind: 'go-on',
          input: waitingAt(crew, run, fields),
          note: optionalStringParam(fields, 'note'),
        })),
        'orchestrator.crewSendBack': usersAnswer('orchestrator.crewSendBack', 'crew-send-back', (crew, run, fields) => {
          const note = stringParam(fields, 'note');
          if (note.trim() === '') throw invalidParams('a Send back says what to change: give a note');
          return { kind: 'send-back', input: waitingAt(crew, run, fields), note: note.trim() };
        }),
        'orchestrator.crewGoOnWithout': usersAnswer('orchestrator.crewGoOnWithout', 'crew-go-on-without', (crew, run, fields) => {
          const at = stringParam(fields, 'member');
          const plan = planFor(crew);
          if (run.merges?.some((each) => each.to === at) === true) return { kind: 'merge-now', to: at };
          const gate = run.gates[at];
          if (gate !== undefined && open(gate)) return { kind: 'go-on-without', at };
          const state = run.joins[at];
          if (state !== undefined && state.since !== null) return { kind: 'go-on-without', at };
          const what = plan.gate(at) !== undefined ? `loop gate ${at} has no round under way` : plan.member(at) !== undefined ? `${plan.label(at)} waits for no input` : `its prefab has no ${at}`;
          throw invalidParams(`crew:${crew.id} can't go on without anything there: ${what}`);
        }),
        'orchestrator.crewRestore': usersAnswer('orchestrator.crewRestore', 'crew-restore', (crew, run) => {
          if (run.records === undefined || run.records.length === 0) throw invalidParams(`crew:${crew.id} has no record of a shared crew worktree to put back`);
          return { kind: 'restore' };
        }),
      };
    },
  };
}
