// A running crew's loop, run by the board: a crew started from a prefab whose reviewers start at its builder's hand-off.
// At each hand-off it starts that round's reviewers on the builder's branch; once each has left its review, it stops at
// ready to merge, or hands the reviews back to the builder for the next round, up to the prefab's round limit. It
// passes on only what its agents wrote, under their own sender marks, and approves, merges and draws nothing. Backed by
// `crews` and `crew_reviewers`, so a crew carries on across a restart. What a crew's card shows (`card`) is read from
// the same rows, and `changed` says when to read it again.
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { SpawnUsed } from './agent-spawns.ts';
import type { BoardConnection } from './board.ts';
import { TURN_STATES } from './crew-events.ts';
import { parsePrefab, prefabFile } from './crew-prefabs.ts';
import type { ActivityEntry, OrchestratorAccess } from './orchestrators.ts';
import { invalidParams, optionalStringParam, paramsObject, stringParam } from './params.ts';
import {
  BOARD_ERROR,
  MAX_CREW_CARD_TITLE,
  planPending,
  waitsOnUser,
  type Agent,
  type Crew,
  type CrewCardData,
  type CrewPrefab,
  type CrewReviewer,
  type CrewStop,
  type DaemonMethods,
  type SpawnAgentParams,
} from './protocol.ts';
import { openFindings, parseReviewDoc } from './review-doc.ts';
import { RpcMethodError, type RpcHandlers } from './rpc.ts';
import type { RunStart } from './schedules.ts';

type CrewMethods = Pick<DaemonMethods, 'orchestrator.crews' | 'orchestrator.stopCrew' | 'orchestrator.crewRound'>;

/** The file a builder hands over in, and the one a reviewer reviews in, in their worktrees. */
const HANDOVER = join('.agent-board', 'handover.md');
const REVIEW = join('.agent-board', 'review.md');

/** The terminal a reviewer the crew starts runs in, before any client attaches and resizes it. */
const REVIEWER_SIZE = { cols: 120, rows: 40 };

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
   * Starts a reviewer in the crew of `spawnedBy` (the user's, without), as an orchestrator's agent starts, its template
   * filled with the crew's round and last review (`used.crewReview`).
   */
  spawn(params: SpawnAgentParams, spawnedBy: string | undefined, used: SpawnUsed): Promise<Agent>;
  /** Hands `text`, the payload `name`, from agent `from` to agent `to`, headed with `from`'s sender mark. */
  deliver(from: string, to: string, name: string, text: string): Promise<RunStart>;
  /** Flags the agent for whoever hears its flags (its orchestrator, else the user's Needs you). */
  flag(sessionId: string, reason: string): void;
  /** Clears the agent's flag. */
  clearFlag(sessionId: string): void;
  /** Closes the agent and removes the worktree and branch it owns. */
  close(sessionId: string, why: string): Promise<void>;
  /** The crew's news, as an event of its builder (`round`, `crew-stopped`). */
  news(sessionId: string, kind: 'round' | 'crew-stopped', detail: string): void;
  /** Where the crews keep a copy of each review they read, for the next round's reviewer once its own is closed. */
  dir: string;
  /** The crew may show differently now (`card`): it started, took a step, was stopped, or one of its agents changed. */
  changed?(crewId: string): void;
  log(message: string): void;
  now?: () => Date;
}

export interface CrewLoop {
  /**
   * Starts a crew around the agent `builder`, just started from `prefab` with `prompt` by `startedBy` (null for the
   * user); null for a prefab with no reviewers at the hand-off.
   */
  start(prefab: CrewPrefab, builder: string, startedBy: string | null, prompt: string): Crew | null;
  /** Hears an agent as it is now: a crew it is in may move on. */
  observe(agent: Agent): void;
  /** Moves on every running crew, as the daemon starts: what happened while it was down is read from the files. */
  resume(): void;
  /** The crews, newest first. */
  list(): Crew[];
  /**
   * What the crew's card shows, as the crew is now, its `tiles` as its prefab draws a crew at first; undefined for no
   * such crew.
   */
  card(crewId: string): CrewCardData | undefined;
  /** Settles once no crew is moving on: for tests. */
  idle(): Promise<void>;
  /** Stops moving crews on, as the daemon shuts down: its agents stop as it goes, which is no news to a crew. */
  close(): void;
  handlers<Context extends BoardConnection>(access: OrchestratorAccess): RpcHandlers<CrewMethods, Context>;
}

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

/** What a crew was asked, in a line for its card: its prompt's first line with anything on it, else its prefab's name. */
function cardTitle(prompt: string, prefab: string): string {
  const line = prompt
    .split('\n')
    .map((each) => each.trim())
    .find((each) => each !== '');
  const title = [...(line ?? prefab)];
  return title.length > MAX_CREW_CARD_TITLE ? `${title.slice(0, MAX_CREW_CARD_TITLE - 1).join('')}…` : title.join('');
}

export function createCrewLoop(db: DatabaseSync, options: CrewLoopOptions): CrewLoop {
  const now = options.now ?? (() => new Date());
  const insertCrew = db.prepare(
    'INSERT INTO crews (id, prefab, body, zone_id, started_by, builder, prompt, round_limit, phase_at, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const selectCrews = db.prepare('SELECT * FROM crews ORDER BY started_at DESC, rowid DESC');
  const selectCrew = db.prepare('SELECT * FROM crews WHERE id = ?');
  const selectRunning = db.prepare('SELECT * FROM crews WHERE stopped IS NULL');
  const selectReviewers = db.prepare('SELECT * FROM crew_reviewers WHERE crew_id = ? ORDER BY round, rowid');
  const insertReviewer = db.prepare('INSERT INTO crew_reviewers (crew_id, session_id, member, round) VALUES (?, ?, ?, ?)');
  const setReview = db.prepare('UPDATE crew_reviewers SET verdict = ?, review = ?, blockers = ? WHERE crew_id = ? AND session_id = ?');
  const setPhase = db.prepare('UPDATE crews SET phase = ?, phase_at = ?, round = ? WHERE id = ?');
  const setStopped = db.prepare('UPDATE crews SET stopped = ?, stopped_at = ? WHERE id = ?');
  const restart = db.prepare('UPDATE crews SET stopped = NULL, stopped_at = NULL, round_limit = ? WHERE id = ?');
  const setStartFailed = db.prepare('UPDATE crews SET start_failed = ?, start_error = ? WHERE id = ?');
  const crewsOf = db.prepare(
    'SELECT DISTINCT c.id FROM crews c LEFT JOIN crew_reviewers r ON r.crew_id = c.id WHERE c.builder = ? OR r.session_id = ?',
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

  const view = (row: CrewRow): Crew => {
    const reviewers = reviewersOf(row.id);
    const current = reviewers.filter((reviewer) => reviewer.round === row.round).map((reviewer) => reviewer.session_id);
    const members = [row.builder, ...(row.phase === 'reviewing' ? current : [])].map((id) => options.agent(id));
    return {
      id: row.id,
      prefab: row.prefab,
      zoneId: row.zone_id,
      startedBy: row.started_by,
      builder: row.builder,
      round: row.round,
      roundLimit: row.round_limit,
      phase: row.stopped === null ? row.phase : 'stopped',
      needsYou: row.stopped === null && members.some((agent) => agent !== undefined && needsYou(agent, row.prefab)),
      stopped: row.stopped,
      startedAt: row.started_at,
      stoppedAt: row.stopped_at,
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
    };
  };

  const stop = (crew: CrewRow, why: CrewStop, said: string) => {
    setStopped.run(why, now().toISOString(), crew.id);
    options.news(crew.builder, 'crew-stopped', `${why}: ${said}`);
  };

  /**
   * The crew's reviewers of the hand-off, started on the builder's branch for the round it is on: only those the round
   * still lacks, if a start failed before. Each is told its round and the last review of its place in the crew.
   */
  const startReviewers = async (crew: CrewRow, builder: Agent) => {
    const prefab = parsePrefab(crew.body);
    const already = new Set(reviewersOf(crew.id, crew.round).map((each) => each.member));
    for (const member of prefab.members.filter((each) => each.starts === 'handoff' && !already.has(each.id))) {
      // Stopped while an earlier one started: no more start.
      if (!stillRunning(crew.id)) return;
      const previous = crew.round === 1 ? undefined : keptReview(crew, member.id, crew.round - 1);
      const lastReview = previous !== undefined && writtenAt(previous) !== undefined ? previous : null;
      const prompt =
        lastReview === null ? crew.prompt : [crew.prompt, `The last round's review is ${lastReview}: check each of its findings is fixed.`].filter(Boolean).join('\n\n');
      const reviewer = await options.spawn(
        {
          zoneId: builder.zoneId,
          harness: member.harness,
          ...(member.model === null ? {} : { model: member.model }),
          ...(member.effort === null ? {} : { effort: member.effort }),
          ...(member.role === null ? {} : { role: member.role }),
          // Its own name, not the builder's (both would be made from the prompt), with its round.
          name: `${member.name ?? member.id} (round ${crew.round})`,
          baseBranch: builder.branch,
          prompt,
          ...REVIEWER_SIZE,
        },
        crew.started_by ?? undefined,
        { template: null, crewReview: { round: crew.round, previous: lastReview } },
      );
      names.set(reviewer.sessionId, reviewer.name);
      insertReviewer.run(crew.id, reviewer.sessionId, member.id, crew.round);
    }
    if (!stillRunning(crew.id)) return;
    setStartFailed.run(0, null, crew.id);
    setPhase.run('reviewing', now().toISOString(), crew.round, crew.id);
    const reviewing = reviewersOf(crew.id, crew.round).map((each) => nameOf(each.session_id));
    options.news(crew.builder, 'round', `round ${crew.round} of ${crew.round_limit}: ${reviewing.join(', ')} reviewing`);
  };

  /** Whether the builder has handed off since its round began: by `handoff` (finished), or a turn ended on a new handover. */
  const handedOff = (crew: CrewRow, builder: Agent): boolean => {
    const since = Date.parse(crew.phase_at);
    if (builder.workFinishedAt !== null && Date.parse(builder.workFinishedAt) > since) return true;
    if (!turnOver(builder)) return false;
    const written = writtenAt(join(builder.worktree, HANDOVER));
    return written !== undefined && written > since;
  };

  /**
   * Reads the review each of the round's reviewers left, once its turn is over, keeping a copy: true once every one
   * has. One paused or stopped by a restart carries on when resumed, so the crew waits for it; one gone, or ended for
   * good, with no review, left none.
   */
  const readReviews = (crew: CrewRow): boolean => {
    let all = true;
    for (const reviewer of reviewersOf(crew.id, crew.round).filter((each) => each.review === null)) {
      const agent = options.agent(reviewer.session_id);
      if (agent !== undefined && !turnOver(agent)) {
        all = false;
        continue;
      }
      const text = agent === undefined ? undefined : readText(join(agent.worktree, REVIEW));
      // At its prompt with no review yet it may be asking something; paused, it carries on once woken.
      if (text === undefined && agent !== undefined && (agent.endedAt === null || endedForNow(agent))) {
        all = false;
        continue;
      }
      const doc = parseReviewDoc(text ?? '');
      if (text !== undefined) {
        const kept = keptReview(crew, reviewer.member, reviewer.round);
        mkdirSync(join(options.dir, crew.id), { recursive: true });
        writeFileSync(kept, text);
      }
      setReview.run(doc.verdict, text ?? '', openFindings(doc).blocker, crew.id, reviewer.session_id);
    }
    return all;
  };

  /**
   * The round's reviews back to the builder, as one hand-off from the first reviewer that asked for changes. Once it is
   * typed, the round's reviewers are closed: the crew keeps their reviews, and the next round's are fresh.
   */
  const handBack = async (crew: CrewRow): Promise<void> => {
    const reviews = reviewersOf(crew.id, crew.round);
    const from = reviews.find((each) => each.verdict !== 'approve' || (each.blockers ?? 0) > 0) ?? reviews[0]!;
    // Each review under its reviewer's name: the crew adds nothing of its own to what they wrote.
    const text =
      reviews.length === 1
        ? from.review!
        : reviews.map((each) => `${nameOf(each.session_id)}'s review: ${each.review === '' ? '(none left)' : each.review}`).join('\n\n');
    const sent = await options.deliver(from.session_id, crew.builder, `review, round ${crew.round}`, text === '' ? `${nameOf(from.session_id)} left no review` : text);
    if (!sent.started) {
      // Tried again once the builder changes: its turn ends, it is woken, you stop typing at its prompt.
      options.log(`crew ${crew.id}: the round ${crew.round} reviews didn't reach its builder yet (${sent.reason})`);
      return;
    }
    setPhase.run('building', now().toISOString(), crew.round + 1, crew.id);
    for (const reviewer of reviews) {
      if (options.agent(reviewer.session_id) === undefined) continue;
      await options.close(reviewer.session_id, `its review went back to ${nameOf(crew.builder)}`).catch((error: Error) => options.log(error.message));
    }
  };

  /** Closes the crew's agents once its builder's pull request is merged; one that won't close is flagged, if it can be. */
  const closeMerged = async (crew: CrewRow, builder: Agent) => {
    stop(crew, 'merged', `${builder.name}'s pull request was merged, so the crew closed its agents`);
    const failed: string[] = [];
    const close = async (sessionId: string) => {
      await options.close(sessionId, `its crew's pull request was merged`).catch((error: Error) => {
        failed.push(`${nameOf(sessionId)} (${error.message})`);
      });
    };
    for (const reviewer of reviewersOf(crew.id)) if (options.agent(reviewer.session_id) !== undefined) await close(reviewer.session_id);
    await close(builder.sessionId);
    if (failed.length > 0 && options.agent(builder.sessionId) !== undefined) {
      options.flag(builder.sessionId, `${crewFlag(crew.prefab)}couldn't close ${failed.join(', ')} after the merge: close them yourself`);
    }
  };

  /** Crews whose round failed to start, which `crew round` starts again now. */
  const retry = new Set<string>();

  /** Moves the crew on one step, if it can. */
  const advance = async (id: string): Promise<void> => {
    const crew = row(id);
    if (crew === undefined) return;
    const builder = options.agent(crew.builder);
    // Its builder's pull request merged: the crew closes its agents and their worktrees, unless the user took it over.
    if (builder?.pullRequests.some((pr) => pr.state === 'merged') === true && crew.stopped !== 'stopped' && crew.stopped !== 'merged') {
      await closeMerged(crew, builder);
      return;
    }
    if (crew.stopped !== null) return;
    if (builder === undefined) {
      stop(crew, 'builder-gone', `${nameOf(crew.builder)} is gone`);
      return;
    }
    if (crew.phase === 'building') {
      if (waitsForUser(builder)) return;
      if (!retry.delete(crew.id) && !handedOff(crew, builder)) return;
      try {
        await startReviewers(crew, builder);
      } catch (error) {
        setPhase.run('building', now().toISOString(), crew.round, crew.id);
        setStartFailed.run(1, (error as Error).message, crew.id);
        options.flag(
          crew.builder,
          `${crewFlag(crew.prefab)}couldn't start round ${crew.round}'s reviewers (${(error as Error).message}): agent-board crew round crew:${crew.id} tries again, and so does ${builder.name}'s next hand-off`,
        );
      }
      return;
    }
    if (!readReviews(crew)) return;
    const reviews = reviewersOf(crew.id, crew.round);
    if (reviews.every((each) => each.verdict === 'approve' && each.blockers === 0)) {
      stop(crew, 'ready-to-merge', `every reviewer of round ${crew.round} approved`);
      options.flag(crew.builder, `${crewFlag(crew.prefab)}is ready to merge: every reviewer of round ${crew.round} approved, with no blocker open`);
      return;
    }
    if (crew.round >= crew.round_limit) {
      stop(crew, 'round-limit', `changes still asked for after ${rounds(crew.round)}`);
      options.flag(
        crew.builder,
        `${crewFlag(crew.prefab)}stopped at its limit of ${rounds(crew.round_limit)}, with changes still asked for: agent-board crew round crew:${crew.id} for one more, or take it over`,
      );
      return;
    }
    await handBack(crew);
  };

  /**
   * What a step of the crew reads: its rows, and what each of its agents is doing. A step taken on the same inputs as
   * the last would do the same again, so it isn't taken.
   */
  const inputs = (id: string): string => {
    const crew = row(id);
    if (crew === undefined) return '';
    const reviewers = reviewersOf(id);
    const agents = [crew.builder, ...reviewers.map((reviewer) => reviewer.session_id)].map((sessionId) => {
      const agent = options.agent(sessionId);
      return agent === undefined
        ? null
        : [agent.state, agent.endedAt, agent.hibernated?.at, agent.workFinishedAt, agent.flag?.id, agent.permissions.length, agent.ask !== null, agent.plan?.decision, agent.pullRequests.map((pr) => pr.state)];
    });
    return JSON.stringify([crew, reviewers, agents, retry.has(id)]);
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
    start(prefab, builderId, startedBy, prompt) {
      const builder = options.agent(builderId);
      if (builder === undefined || !prefab.members.some((member) => member.starts === 'handoff')) return null;
      const id = randomBytes(4).toString('hex');
      const at = now().toISOString();
      names.set(builder.sessionId, builder.name);
      insertCrew.run(id, prefab.name, prefabFile(prefab), builder.zoneId, startedBy, builder.sessionId, prompt, prefab.roundLimit, at, at);
      changed(id);
      return view(row(id)!);
    },

    observe(agent) {
      if (closing) return;
      names.set(agent.sessionId, agent.name);
      for (const { id } of crewsOf.all(agent.sessionId, agent.sessionId) as { id: string }[]) void move(id);
    },

    resume() {
      for (const crew of selectRunning.all() as unknown as CrewRow[]) void move(crew.id);
    },

    list: () => (selectCrews.all() as unknown as CrewRow[]).map(view),

    card(crewId) {
      const crew = row(crewId);
      if (crew === undefined) return undefined;
      const prefab = parsePrefab(crew.body);
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
    },

    handlers<Context extends BoardConnection>(access: OrchestratorAccess): RpcHandlers<CrewMethods, Context> {
      /** Whether `me` reaches the crew: by its builder, while it is on the board, else as the one that started it. */
      const reaches = (me: ReturnType<OrchestratorAccess['caller']>, crew: CrewRow) => {
        if (me.agent === null) return true;
        const builder = options.agent(crew.builder);
        return builder === undefined ? crew.started_by === me.sessionId : access.reachesAgent(me, builder);
      };
      const reached = (me: ReturnType<OrchestratorAccess['caller']>, crewId: string): CrewRow => {
        const crew = crewNamed(crewId);
        if (!reaches(me, crew)) throw new RpcMethodError(BOARD_ERROR.outOfScope, `crew:${crew.id} is outside your scope (${access.scopeText(me)})`);
        return crew;
      };
      const logged = (crew: CrewRow) => ({ id: `crew:${crew.id}`, name: crew.prefab });
      /** Clears the builder's flag if it is the crew's own: answered, by what the user asks of the crew now. */
      const clearOwnFlag = (crew: CrewRow) => {
        if (options.agent(crew.builder)?.flag?.reason.startsWith(crewFlag(crew.prefab)) === true) options.clearFlag(crew.builder);
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
            // A round whose start failed: its reviewers start again now, whether or not its flag was dismissed.
            if (crew.stopped === null && crew.phase === 'building' && crew.start_failed === 1) {
              clearOwnFlag(crew);
              retry.add(crew.id);
            } else if (crew.stopped === 'round-limit') {
              restart.run(crew.round_limit + 1, crew.id);
              clearOwnFlag(crew);
            } else {
              throw invalidParams(
                `crew:${crew.id} ${crew.stopped === null ? 'is still running' : `stopped ${crew.stopped}`}: crew round gives one more round to a crew stopped at its round limit, or starts again a round that failed to start`,
              );
            }
            await move(crew.id);
            return view(row(crew.id)!);
          });
        },
      };
    },
  };
}
