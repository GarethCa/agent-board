// Clocks: schedules as board items. A clock fires on its cron and either messages the agent it is joined to, or starts
// a fresh agent with its task, waits for that agent's turn to end, sends its final message where the clock says, and
// closes it. The scheduler (`schedules.ts`) keeps the times; this is what a clock does when it fires.
import type { DatabaseSync } from 'node:sqlite';
import { agentNoteAuthor, agentNoteData, agentNoteSize } from './agent-notes.ts';
import type { AgentHost } from './agents.ts';
import type { Clock } from './clock.ts';
import type { DaemonCall } from './orchestrator-layout.ts';
import { finiteNumberParam, invalidParams, optionalBooleanParam, optionalStringParam, paramsObject, stringParam } from './params.ts';
import {
  CLOCK_SIZE,
  MAX_STICKY_TEXT,
  CLOCK_MODES,
  MAX_CLOCK_WHY,
  clockMode,
  roleLabel,
  withClockMode,
  type ClockMark,
  type ClockMode,
  type Agent,
  type BoardItem,
  type ClockData,
  type ClockPlace,
  type DaemonEvent,
  type DaemonMethods,
  type ScheduleSpec,
  type Zone,
  BOARD_ERROR,
  type ClockStatus,
} from './protocol.ts';
import { boardCaller, isOwnLiveSession, type BoardCallerSources, type BoardConnection } from './board.ts';
import type { OrchestratorAccess } from './orchestrators.ts';
import { RpcMethodError, type RpcHandlers } from './rpc.ts';
import { cronWords, looksStuck, sinceWords, stuckFlagReason } from './cron.ts';
import { createScheduleHost, type FiringClock, type Fired, type OpenRun, type ScheduleHost } from './schedules.ts';
import { cutText } from './text-cut.ts';
import type { ClockTemplateHost } from './clock-templates.ts';
import { isObject } from './json.ts';
import { asksSomething } from './hook-states.ts';
import { AGENT_TILE_SIZE, freeSpotFor } from './board-layout.ts';

type ClockMethods = Pick<DaemonMethods, 'clock.list' | 'clock.add' | 'agent.setSchedule'>;
type OrchestratorClockMethods = Pick<DaemonMethods, 'orchestrator.addClock' | 'orchestrator.removeClock'>;
type AgentClockMethods = Pick<DaemonMethods, 'clock.self' | 'clock.addSelf'>;

/** Why a fresh agent that flagged you is left on the board when its run ends: closing it would take its flag. */
const KEPT_FLAGGED = 'kept: it flagged you';

/** The gap between a clock and the tile it is put beside, and between a clock and the fresh agent it starts. */
const CLOCK_GAP = 60;
const FRESH_GAP = 24;
/** The terminal a fresh agent starts with, as an orchestrator's do. */
const FRESH_SIZE = { cols: 120, rows: 40 };
/** The most characters of a fresh agent's final message kept as its run's result. */
const MAX_RESULT = 4_000;
/** The most characters of a fresh agent's task its name takes. */
const MAX_NAME_TASK = 32;
/** The most agents a clock started that may still be on the board: it starts no more until one goes. */
const MAX_FRESH_ON_BOARD = 3;

/** A new clock's data: weekdays at nine, on, messaging and leaving its agent idle, with nothing to say yet. */
export function newClockData(): ClockData {
  return {
    cron: '0 9 * * 1-5',
    enabled: true,
    does: 'message',
    agent: null,
    hibernate: false,
    prompt: '',
    fresh: { harness: 'claude', model: null, role: null, closeWhenDone: true },
    result: 'history',
    handoffTo: null,
    folded: false,
  };
}

/** What a fresh agent started by a clock is called: its task's first words, and which run it is. */
function freshAgentName(prompt: string, count: number): string {
  const task = cutText(prompt.trim().split('\n', 1)[0]!, MAX_NAME_TASK);
  return `${task} #${count}`;
}

export interface ClockHostOptions {
  db: DatabaseSync;
  clock: Clock;
  agents: Pick<AgentHost, 'get' | 'runScheduled' | 'spawn' | 'finalMessage' | 'delete' | 'stop' | 'deliver' | 'announce' | 'flag' | 'clearFlag' | 'pause'>;
  /** The daemon's own methods: clocks, notes and their changes are made as the board makes them. */
  call: DaemonCall;
  broadcast(event: DaemonEvent): void;
  log(message: string): void;
  /** The saved templates a new clock can start from, by id or name. */
  templates?: Pick<ClockTemplateHost, 'dataOf'>;
}

export interface ClockHost {
  /** The scheduler, for the agents' own schedules (`Agent.schedule`) and keeping the daemon up. */
  schedules: Pick<ScheduleHost, 'forAgent' | 'runOf' | 'hasEnabled'>;
  handlers<Context>(): RpcHandlers<ClockMethods, Context>;
  /** The orchestrator's clock methods: `schedule add` and `schedule remove`, in its scope, logged. */
  orchestratorHandlers<Context extends BoardConnection>(access: OrchestratorAccess, zones: () => Zone[]): RpcHandlers<OrchestratorClockMethods, Context>;
  /** What any live agent may do to its own clock (`clock.self`, `clock.addSelf`), from its own session. */
  agentHandlers<Context extends BoardConnection>(sources: BoardCallerSources): RpcHandlers<AgentClockMethods, Context>;
  /** Hears every event the daemon broadcasts: a clock changed, or a fresh agent failed or ended. */
  onEvent(event: DaemonEvent): void;
  /** The agent's turn ended: a fresh agent's run is over, unless its turn ended asking the user something. */
  turnEnded(sessionId: string): void;
  /** The agent's turn ended with no `Stop`, as `why` says: a message's run of it fails. */
  turnCut(sessionId: string, why: string): void;
  /** Settles the runs a stopped daemon left going, once the agents are there to ask. */
  resumeRuns(): void;
  /** The agent is being deleted: the clocks joined to it are left unjoined. */
  agentRemoved(sessionId: string): void;
  /** Stops firing. */
  close(): void;
}

export function createClockHost(options: ClockHostOptions): ClockHost {
  const { agents, call, log } = options;
  /** The flag each messaged agent had as its run fired, by run id: one it still has isn't the run's. */
  const flagAtFire = new Map<number, number | null>();
  /** Fresh agents' runs being finished, so a second turn end doesn't finish one twice. */
  const finishing = new Set<string>();

  const fire = (firing: FiringClock, count: number): Fired => {
    const { data } = firing;
    const maker = (selectMadeBy.get(firing.id) as { made_by: string | null } | undefined)?.made_by ?? null;
    if (data.does === 'message' && data.agent !== null) {
      const agent = agents.get(data.agent);
      if (agent === undefined) return { started: false, reason: 'its agent is gone' };
      const flagBefore = agent.flag?.id ?? null;
      // Typing it may fail after it started: its run is over then, as no turn of it will end.
      let runId: number | undefined;
      let notTyped: string | undefined;
      const untyped = (id: number, reason: string) => {
        try {
          if (schedules.runOf(agent.sessionId)?.runId === id) schedules.updateRun(id, { outcome: 'failed', reason: `its message wasn't typed: ${reason}`, finishedAt: now() });
        } catch (error) {
          // Typing gave up as the daemon shut down, with the database closed: the run settles once it starts again.
          log(`clock ${firing.id}: its message wasn't typed (${reason}), and its run wasn't recorded: ${(error as Error).message}`);
        }
      };
      const started = agents.runScheduled(agent.sessionId, data.prompt, (reason) => {
        if (runId === undefined) notTyped = reason;
        else untyped(runId, reason);
      });
      // A message that started a turn, or will once the agent is up (queued), is a run until that turn ends.
      return {
        ...started,
        sessionId: agent.sessionId,
        agentName: agent.name,
        awaitsTurn: started.started,
        onRun: (id) => {
          runId = id;
          const open = new Set(schedules.running().map((each) => each.runId));
          for (const each of flagAtFire.keys()) if (!open.has(each)) flagAtFire.delete(each);
          flagAtFire.set(id, flagBefore);
          if (notTyped !== undefined) untyped(id, notTyped);
        },
      };
    }
    // An orchestrator's clock starts its agents in its crew, so they are no shallower than it could start them. An agent's
    // own clock (`clock.addSelf`) is marked as made by no one, so one it sets to close starts its agents as the user's do.
    if (maker !== null && agents.get(maker) === undefined) return { started: false, reason: 'the orchestrator that made it is gone' };
    const onBoard = (selectRunAgents.all(firing.id) as { session_id: string }[]).filter((row) => agents.get(row.session_id) !== undefined).length;
    // An unjoined clock that starts its own agent (`startsAgent`) starts it as a fresh one, then joins it.
    const joins = data.does === 'message';
    if (!joins && onBoard >= MAX_FRESH_ON_BOARD) return { started: false, reason: `${onBoard} agents it started are still on the board` };
    return { running: true, joins, start: (runId) => void startFresh(firing, runId, count, maker ?? undefined, joins) };
  };
  const selectRunAgents = options.db.prepare('SELECT DISTINCT session_id FROM clock_runs WHERE clock_id = ? AND session_id IS NOT NULL');

  const selectClock = options.db.prepare("SELECT data, zone_id AS zoneId, x, y, height FROM board_items WHERE kind = 'clock' AND id = ?");
  /** The clock's data and where it is, as stored now; undefined once it is deleted. */
  const clockOf = (clockId: string): { data: ClockData; zoneId: string | null; x: number; y: number; height: number } | undefined => {
    const row = selectClock.get(clockId) as { data: string; zoneId: string | null; x: number; y: number; height: number } | undefined;
    return row === undefined ? undefined : { ...row, data: JSON.parse(row.data) as ClockData };
  };
  /** Whether the clock messages the agent now: one its run started may have joined it since (`startsAgent`, `clock.self`). */
  const messages = (clockId: string, sessionId: string): boolean => {
    const data = clockOf(clockId)?.data;
    return data?.does === 'message' && data.agent === sessionId;
  };
  /**
   * Whether the run's agent is its clock's own, so the run settles as a message's does and its agent is never closed
   * after it: one the run started to join (kept on the run, so a turn ending before the join is written still counts),
   * or one the clock messages now.
   */
  const ownsRun = (run: OpenRun, sessionId: string): boolean => run.joins || messages(run.clockId, sessionId);
  const selectClocks = options.db.prepare("SELECT id FROM board_items WHERE kind = 'clock'");
  /** The agent each clock messages now, null for none: one it no longer does is told so as it changes. */
  const joinedOf = (clockId: string): string | null => clockOf(clockId)?.data.agent ?? null;
  const joinedAgents = new Map<string, string>();
  for (const { id } of selectClocks.all() as { id: string }[]) {
    const joined = joinedOf(id);
    if (joined !== null) joinedAgents.set(id, joined);
  }
  const selectMadeBy = options.db.prepare("SELECT made_by FROM board_items WHERE kind = 'clock' AND id = ?");
  const markMadeBy = options.db.prepare('UPDATE board_items SET made_by = ? WHERE id = ?');
  /**
   * The flag each clock raised on its agent, whose turn looked stuck, and the run of skips it raised it for: by the
   * flag's id (null when the agent had a flag already), so one the agent has since replaced stays, and by the run's
   * start, so that run never raises it again.
   */
  const stuckFlags = new Map<string, { sessionId: string; flagId: number | null; since: string }>();
  /** Takes down the flag a clock raised, unless the agent or the user has replaced or cleared it since. */
  const lowerStuck = (clockId: string) => {
    const raised = stuckFlags.get(clockId);
    if (raised === undefined) return;
    const agent = agents.get(raised.sessionId);
    if (raised.flagId !== null && agent?.endedAt === null && agent.flag?.id === raised.flagId) agents.clearFlag(raised.sessionId);
  };
  /** A clock that no longer messages the agent it flagged (deleted, turned off, joined to another) takes its flag down. */
  const dropStuck = (clockId: string) => {
    const raised = stuckFlags.get(clockId);
    if (raised === undefined) return;
    const data = clockOf(clockId)?.data;
    if (data !== undefined && data.enabled && data.does === 'message' && data.agent === raised.sessionId) return;
    lowerStuck(clockId);
    stuckFlags.delete(clockId);
  };
  /**
   * The reason the agent flagged you for a look while `run` went on, if it did: its own flag, raised since the run went
   * off, and not one a clock raised for a stuck turn.
   */
  const runFlag = (agent: Agent | undefined, run: OpenRun): string | null => {
    const flag = agent?.flag;
    if (flag == null) return null;
    // After a restart, which forgets the flag it had as the run fired, one raised before the run isn't the run's.
    const before = flagAtFire.get(run.runId);
    if (before === undefined ? flag.at < run.firedAt : flag.id === before) return null;
    for (const raised of stuckFlags.values()) if (raised.flagId === flag.id) return null;
    return flag.reason;
  };

  /**
   * A clock that messages its agent flags it once its skips in a row look stuck (`looksStuck`): no check-in can reach
   * it. A flag the agent already has is left as it is. The flag goes once a check-in reaches the agent again, or its
   * turn ends, unless the agent or the user has replaced or cleared it; that run of skips doesn't raise it again.
   */
  const afterFire = (firing: FiringClock, status: ClockStatus) => {
    const sessionId = firing.data.does === 'message' ? firing.data.agent : null;
    if (sessionId === null) return;
    const skips = status.skips;
    const raised = stuckFlags.get(firing.id);
    if (raised !== undefined && raised.since !== skips?.since) {
      lowerStuck(firing.id);
      stuckFlags.delete(firing.id);
    }
    if (!looksStuck(skips) || stuckFlags.has(firing.id)) return;
    const agent = agents.get(sessionId);
    if (agent === undefined || agent.endedAt !== null) return;
    // A flag it already has asks for a look as it is: that run of skips is not news again once the user has looked.
    if (agent.flag !== null) {
      stuckFlags.set(firing.id, { sessionId, flagId: null, since: skips!.since });
      return;
    }
    const flagged = agents.flag(sessionId, stuckFlagReason(agent.name, skips!, new Date(options.clock.now())), null);
    if (flagged.flag !== null) stuckFlags.set(firing.id, { sessionId, flagId: flagged.flag.id, since: skips!.since });
    log(`clock ${firing.id} flagged ${sessionId}: skipped ${skips!.count} times in a row while it was mid-turn`);
  };

  const schedules = createScheduleHost({
    db: options.db,
    clock: options.clock,
    fire,
    afterFire,
    onChange(clockId) {
      const status = schedules.status(clockId);
      if (status !== null) options.broadcast({ type: 'clock.updated', status });
      // The agent it messages shows its schedule, and one it messaged until now shows it has gone.
      const was = joinedAgents.get(clockId);
      const now = joinedOf(clockId);
      if (now === null) joinedAgents.delete(clockId);
      else joinedAgents.set(clockId, now);
      for (const sessionId of new Set([was, now])) {
        if (sessionId != null && agents.get(sessionId) !== undefined) agents.announce(sessionId);
      }
    },
    log,
  });

  const startFresh = async (firing: FiringClock, runId: number, count: number, spawnedBy: string | undefined, join = false) => {
    const { data } = firing;
    const name = freshAgentName(data.prompt, count);
    schedules.updateRun(runId, { agentName: name });
    try {
      // Under the clock, stepped clear of the tiles there: a kept agent's included.
      const tiles = (await call('agent.list', undefined))
        .filter((each) => each.zoneId === firing.zoneId && each.position !== null)
        .map((each) => ({ ...each.position!, ...AGENT_TILE_SIZE }));
      const agent = await agents.spawn(
        {
          zoneId: firing.zoneId,
          position: freeSpotFor({ x: firing.x, y: firing.y + firing.height + FRESH_GAP }, AGENT_TILE_SIZE, tiles),
          harness: data.fresh.harness,
          model: data.fresh.model ?? undefined,
          role: data.fresh.role ?? undefined,
          name,
          prompt: data.prompt,
          ...FRESH_SIZE,
        },
        spawnedBy,
      );
      schedules.updateRun(runId, { sessionId: agent.sessionId, agentName: agent.name });
      log(`clock ${firing.id} started ${agent.name}`);
      // The one change a clock makes to itself as it fires: it messages the agent it started from now on.
      if (join) {
        await call('item.update', { id: firing.id, data: { agent: agent.sessionId, startsAgent: false } }).catch((error: unknown) =>
          log(`clock ${firing.id}: could not join ${agent.name}: ${(error as Error).message}`),
        );
      }
      // It shows as a clock's run now (a question waits for you), and a quick one may have finished before its run knew it.
      agents.announce(agent.sessionId);
      if (agents.finalMessage(agent.sessionId) !== undefined) turnEnded(agent.sessionId);
    } catch (error) {
      schedules.updateRun(runId, { outcome: 'failed', reason: `could not start ${name}: ${(error as Error).message}`, finishedAt: now() });
    }
  };

  const now = () => new Date(options.clock.now()).toISOString();

  /** Sends a fresh agent's result where its clock says, and closes it if it says so. */
  const finish = async (sessionId: string, runId: number, clockId: string) => {
    const agent = agents.get(sessionId);
    const said = agents.finalMessage(sessionId) ?? '';
    const result = cutText(said.trim(), MAX_RESULT);
    // Kept at once, so a daemon stopping before the run is settled doesn't lose it.
    if (result !== '') schedules.updateRun(runId, { result });
    const item = clockOf(clockId);
    const data = item?.data;
    const run = schedules.runOf(sessionId);
    const flag = run === undefined ? null : (runFlag(agent, run) ?? run.flag);
    const notes: string[] = [];
    if (agent !== undefined && data !== undefined && result !== '') {
      if (data.result === 'note') {
        // Where its tile is: it stays once the tile goes.
        const text = cutText(result, MAX_STICKY_TEXT);
        const place = agent.position ?? { x: item!.x, y: item!.y + item!.height + FRESH_GAP };
        await call('item.create', {
          kind: 'agent-note',
          zoneId: agent.zoneId,
          ...place,
          ...agentNoteSize(text),
          data: { ...agentNoteData({ ...agentNoteAuthor(agent), role: roleLabel(agent) }, text) },
        }).catch((error: unknown) => notes.push(`no note: ${(error as Error).message}`));
      } else if (data.result === 'handoff') {
        const to = data.handoffTo === null ? undefined : agents.get(data.handoffTo);
        if (to === undefined) notes.push('no hand-off: the agent to hand it to is gone');
        else {
          const handed = await agents.deliver(sessionId, to.sessionId, 'final message', said).catch((error: unknown) => ({ started: false as const, reason: (error as Error).message }));
          if (!handed.started) notes.push(`not handed to ${to.name}: ${handed.reason}`);
        }
      }
    }
    // Its flag goes with its session: one that flagged you stays up, so the flag stays in Needs you until you look.
    if (agent !== undefined && (data?.fresh.closeWhenDone ?? true)) {
      const kept = flag !== null ? KEPT_FLAGGED : await close(sessionId, 'its clock run finished');
      if (kept !== undefined) notes.push(kept);
    }
    schedules.updateRun(runId, { outcome: 'done', reason: notes.length === 0 ? null : notes.join('; '), result: result === '' ? null : result, finishedAt: now(), flag });
  };

  /**
   * Settles a run whose message's turn has ended: its final message is its result. A clock that hibernates its agent
   * then pauses it, its conversation kept for the next run, unless it flagged you: a pause ends its session, and its
   * flag with it, so it stays up in Needs you until you look.
   */
  const settle = (sessionId: string, run: OpenRun) => {
    const agent = agents.get(sessionId);
    const said = cutText((agents.finalMessage(sessionId) ?? '').trim(), MAX_RESULT);
    // A flag noted during the run stays its own, though the agent has since lost or replaced it.
    const flag = runFlag(agent, run) ?? run.flag;
    const data = clockOf(run.clockId)?.data;
    const hibernates = data !== undefined && clockMode(data) === 'hibernate' && data.agent === sessionId;
    // An agent that set its clock to close it during the run is closed as the run ends, as a fresh one is, unless the
    // clock keeps each run's agent.
    const closes = data?.does === 'fresh' && (data.fresh.closeWhenDone ?? true) && schedules.changesOf(run.runId).some((each) => each.sessionId === sessionId && each.change === 'mode' && each.value === 'close');
    const reason = (hibernates || closes) && flag !== null ? (closes ? KEPT_FLAGGED : 'not paused: it flagged you') : null;
    schedules.updateRun(run.runId, { outcome: 'done', reason, result: said === '' ? null : said, finishedAt: now(), flag });
    flagAtFire.delete(run.runId);
    if (closes && flag === null && agent !== undefined) {
      void close(sessionId, 'its clock now starts a fresh agent each run').then((kept) => {
        if (kept !== undefined) schedules.updateRun(run.runId, { reason: kept });
      });
      return;
    }
    if (!hibernates || flag !== null || agent === undefined) return;
    // A pause it refuses throws as it is called: a background command still running, a line typed at its prompt.
    void Promise.resolve()
      .then(() => agents.pause(sessionId, null, 'its clock hibernates it until its next run'))
      .then(
        () => log(`clock ${run.clockId} paused ${agent.name} until its next run`),
        (error: unknown) => schedules.updateRun(run.runId, { reason: `not paused: ${(error as { reason?: string }).reason ?? (error as Error).message}` }),
      );
  };

  /**
   * Closes a fresh agent once its run is over. Unsaved work is never thrown away: it is stopped instead, and stays for
   * the user; what is returned says so.
   */
  const close = async (sessionId: string, why: string): Promise<string | undefined> => {
    try {
      await agents.delete(sessionId, why, false);
      return undefined;
    } catch (error) {
      await agents.stop(sessionId, why).catch(() => {});
      return `kept: ${(error as Error).message}`;
    }
  };

  /** A run the app stopped during: it says so, not that its agent failed, and its agent is closed as the clock says. */
  const STOPPED_DURING = 'the app stopped during its run';
  const stoppedDuring = async (run: OpenRun, sessionId: string) => {
    schedules.updateRun(run.runId, { outcome: 'failed', reason: STOPPED_DURING, finishedAt: now() });
    if (!(clockOf(run.clockId)?.data.fresh.closeWhenDone ?? true) || ownsRun(run, sessionId)) return;
    const kept = await close(sessionId, 'the app stopped during its clock run');
    if (kept !== undefined) schedules.updateRun(run.runId, { reason: `${STOPPED_DURING}; ${kept}` });
  };

  function turnEnded(sessionId: string) {
    // A stuck turn that ends is no longer stuck.
    for (const [clockId, raised] of stuckFlags) if (raised.sessionId === sessionId) lowerStuck(clockId);
    const run = schedules.runOf(sessionId);
    if (run === undefined || finishing.has(sessionId)) return;
    // A turn that ended asking the user something isn't the end of its work: it waits for them, its run going on.
    if (asksSomething(agents.finalMessage(sessionId))) return;
    // A fresh run's agent the clock joins is the clock's own: its run settles as a message's does.
    if (!run.fresh || ownsRun(run, sessionId)) {
      settle(sessionId, run);
      return;
    }
    finishing.add(sessionId);
    void finish(sessionId, run.runId, run.clockId)
      .catch((error: unknown) => {
        log(`clock ${run.clockId}: could not finish its run: ${(error as Error).message}`);
        schedules.updateRun(run.runId, { outcome: 'failed', reason: (error as Error).message, finishedAt: now() });
      })
      .finally(() => finishing.delete(sessionId));
  }

  /**
   * A message's run whose turn ended with no `Stop` (interrupted, failed, rate limited) fails, saying why: no later turn,
   * perhaps the user's own, settles it, nor hibernates its agent after it.
   */
  function turnCut(sessionId: string, why: string) {
    for (const [clockId, raised] of stuckFlags) if (raised.sessionId === sessionId) lowerStuck(clockId);
    const run = schedules.runOf(sessionId);
    if (run === undefined || (run.fresh && !ownsRun(run, sessionId))) return;
    schedules.updateRun(run.runId, { outcome: 'failed', reason: why, finishedAt: now() });
    flagAtFire.delete(run.runId);
  }

  /** A run whose agent flags you shows it at once, before its turn ends: its card's dot, and its line in history. */
  const noteFlag = (agent: Agent) => {
    if (agent.flag === null) return;
    const run = schedules.runOf(agent.sessionId);
    if (run === undefined) return;
    const flag = runFlag(agent, run);
    if (flag !== null && flag !== run.flag) schedules.updateRun(run.runId, { flag });
  };

  /** A run's agent that failed, or ended or went before its turn did, fails its run. */
  const failIfOver = (sessionId: string, agent: Agent | undefined) => {
    const run = schedules.runOf(sessionId);
    if (run === undefined || finishing.has(sessionId)) return;
    // The app stopping isn't the agent's doing: `resumeRuns` settles that run.
    if (agent?.state === 'stopped-by-restart') return;
    // A messaged agent may still show the failed turn before the one its run started, which a run after a failed turn is.
    const failed = run.fresh && agent?.state === 'failed';
    const why = agent === undefined ? 'its agent was removed' : failed ? `${agent.name} failed` : agent.endedAt !== null ? `${agent.name} ended before it finished` : undefined;
    if (why !== undefined) schedules.updateRun(run.runId, { outcome: 'failed', reason: why, finishedAt: now() });
  };


  /** Where a new clock goes beside an agent's tile: on its left, in its zone, or on its right without room there. */
  const besideTile = (sessionId: string): { zoneId: string | null; x: number; y: number } => {
    const agent = agents.get(sessionId);
    if (agent === undefined) throw invalidParams(`no agent ${sessionId}`);
    const tile = agent.position ?? { x: 0, y: 0 };
    const left = tile.x - CLOCK_GAP - CLOCK_SIZE.width;
    const x = left >= 16 || agent.zoneId === null ? left : tile.x + AGENT_TILE_SIZE.width + CLOCK_GAP;
    return { zoneId: agent.zoneId, x, y: tile.y };
  };

  /** `data` over the template `p.template` names, if it names one. */
  const withTemplate = (p: Record<string, unknown>, data: Partial<ClockData>): Partial<ClockData> => {
    const ref = optionalStringParam(p, 'template');
    if (ref === undefined) return data;
    if (options.templates === undefined) throw invalidParams('this daemon keeps no clock templates');
    return { ...options.templates.dataOf(ref), ...data };
  };

  const add = async (data: Partial<ClockData>, place: ClockPlace): Promise<BoardItem> => {
    const spot = 'beside' in place ? besideTile(place.beside) : place;
    const joined = 'beside' in place ? { agent: place.beside } : {};
    return call('item.create', { kind: 'clock', ...spot, ...CLOCK_SIZE, data: { ...newClockData(), ...joined, ...data } });
  };

  /** The agent's own schedule, as `agent.setSchedule` sets it: the clock that messages it. */
  const setSchedule = async (sessionId: string, spec: ScheduleSpec | null): Promise<Agent> => {
    if (agents.get(sessionId) === undefined) throw invalidParams(`no agent ${sessionId}`);
    const clockId = schedules.forAgent(sessionId)?.clockId;
    if (spec === null) {
      if (clockId !== undefined) await call('item.delete', { id: clockId });
    } else {
      if (spec.prompt.trim() === '') throw invalidParams('the prompt must not be empty');
      const data = { cron: spec.cron.trim(), prompt: spec.prompt.trim(), enabled: spec.enabled ?? true };
      if (clockId === undefined) await add(data, { beside: sessionId });
      else await call('item.update', { id: clockId, data });
    }
    return agents.get(sessionId)!;
  };

  /** The clocks that are the agent's own: those that message it, and the one whose run started it. */
  const ownClocks = (sessionId: string): string[] => {
    const own = new Set(schedules.joinedTo(sessionId).filter((clockId) => messages(clockId, sessionId)));
    const run = schedules.runOf(sessionId);
    if (run !== undefined && clockOf(run.clockId) !== undefined) own.add(run.clockId);
    return [...own];
  };
  /** Who a clock runs, for an agent told it isn't its own. */
  const runsWho = (data: ClockData): string => {
    if (data.does === 'fresh') return 'a fresh agent each run';
    if (data.agent === null) return 'no agent yet';
    return agents.get(data.agent)?.name ?? 'another agent';
  };
  /** When the clock next fires, in words: `15:00`, or `2026-11-13 09:00` on another day. */
  const nextWords = (clockId: string): string | undefined => {
    const next = schedules.status(clockId)?.nextRunAt ?? null;
    return next === null ? undefined : sinceWords(new Date(next), new Date(options.clock.now()));
  };
  /** What `clock.self` tells the agent its clock does now. */
  const selfSaid = (clockId: string, change: ClockMode | 'stop', inRun: boolean): string => {
    if (change === 'stop') return 'Your clock is off. Turn it on again from the board.';
    const next = nextWords(clockId);
    if (change === 'close') {
      const now = inRun ? 'Your clock now closes you after this run.' : 'Your clock now starts a fresh agent for each run, and closes it after.';
      return next === undefined ? now : `${now} ${next} starts a fresh agent.`;
    }
    const now = change === 'hibernate' ? 'Your clock now hibernates you after each run.' : 'Your clock now leaves you idle after each run.';
    return next === undefined ? now : `${now} Its next run is at ${next}.`;
  };

  const changeSelf = async (me: Agent, p: Record<string, unknown>): Promise<{ clock: BoardItem; said: string }> => {
    const why = cutText(stringParam(p, 'why').trim(), MAX_CLOCK_WHY);
    if (why === '') throw invalidParams('say why you are changing your clock');
    const after = optionalStringParam(p, 'after');
    if (after !== undefined && !(CLOCK_MODES as readonly string[]).includes(after)) throw invalidParams(`after must be one of ${CLOCK_MODES.join(', ')}`);
    const stop = optionalBooleanParam(p, 'stop') === true;
    if ((after === undefined) === !stop) throw invalidParams('give one of after or stop');
    const named = optionalStringParam(p, 'clock');
    const own = ownClocks(me.sessionId);
    let clockId: string;
    if (named !== undefined) {
      const item = clockOf(named);
      if (item === undefined) throw invalidParams(`no clock ${named}`);
      if (!own.includes(named)) throw invalidParams(`that clock runs ${runsWho(item.data)}, not you`);
      clockId = named;
    } else if (own.length === 1) clockId = own[0]!;
    else if (own.length === 0) throw invalidParams('you have no clock: add one with `agent-board schedule add --self`');
    else throw invalidParams(`you have ${own.length} clocks: name one of ${own.join(', ')}`);

    const item = clockOf(clockId)!;
    const at = now();
    const mark: ClockMark = { sessionId: me.sessionId, name: me.name, why, at };
    const run = schedules.runOf(me.sessionId);
    const runId = run?.clockId === clockId ? run.runId : null;
    let patch: Partial<ClockData>;
    if (stop) patch = { enabled: false, stoppedBy: mark };
    else if (after === 'close') {
      if (item.zoneId === null) throw invalidParams('your clock is not in a zone, so it has nowhere to start a fresh agent');
      // Its agent stays named: a fresh clock messages no one, and a mode set back to message it joins it again.
      patch = { ...withClockMode('close'), modeSetBy: mark };
    } else patch = { ...withClockMode(after as ClockMode), agent: me.sessionId, modeSetBy: mark };
    const clock = await call('item.update', { id: clockId, data: patch });
    schedules.recordChange(clockId, { runId, at, sessionId: me.sessionId, agentName: me.name, change: stop ? 'stop' : 'mode', value: stop ? null : after!, why });
    log(`clock ${clockId}: ${me.name} ${stop ? 'turned it off' : `set it to ${after}`}: ${why}`);
    return { clock, said: selfSaid(clockId, stop ? 'stop' : (after as ClockMode), runId !== null && !run!.fresh) };
  };

  return {
    schedules,

    handlers<Context>(): RpcHandlers<ClockMethods, Context> {
      return {
        'clock.list': () => schedules.statuses(),
        'clock.add': (params) => {
          const p = paramsObject(params);
          const data = p.data === undefined ? {} : p.data;
          if (!isObject(data)) throw invalidParams('data must be an object');
          return add(withTemplate(p, data as Partial<ClockData>), placeParam(p));
        },
        'agent.setSchedule': (params) => {
          const p = paramsObject(params);
          const sessionId = stringParam(p, 'sessionId');
          if (p.schedule === null) return setSchedule(sessionId, null);
          const schedule = paramsObject(p.schedule);
          return setSchedule(sessionId, {
            cron: stringParam(schedule, 'cron'),
            prompt: stringParam(schedule, 'prompt'),
            enabled: optionalBooleanParam(schedule, 'enabled'),
          });
        },
      };
    },

    orchestratorHandlers<Context extends BoardConnection>(access: OrchestratorAccess, zones: () => Zone[]): RpcHandlers<OrchestratorClockMethods, Context> {
      const outOfScope = (message: string) => new RpcMethodError(BOARD_ERROR.outOfScope, message);
      /** The agent `sessionId` names, which `me` may act on. */
      const reachable = (me: Parameters<OrchestratorAccess['reachesAgent']>[0], sessionId: string) => {
        const agent = agents.get(sessionId);
        if (agent === undefined) throw invalidParams(`no agent ${sessionId}`);
        if (!access.reachesAgent(me, agent)) throw outOfScope(`${agent.name} is outside your scope (${access.scopeText(me)})`);
        return agent;
      };
      return {
        'orchestrator.addClock': (params, connection) => {
          const p = paramsObject(params);
          const me = access.caller('orchestrator.addClock', p, connection);
          const entry = { detail: '' };
          return access.logged(me, 'add-clock', entry, async () => {
            if (!isObject(p.data)) throw invalidParams('data must be an object');
            const data = { ...newClockData(), ...withTemplate(p, p.data as Partial<ClockData>) };
            if (typeof data.prompt !== 'string' || data.prompt.trim() === '') throw invalidParams('give the clock its prompt');
            if (data.handoffTo !== null && data.result === 'handoff') reachable(me, data.handoffTo);
            let item: BoardItem;
            if (data.does === 'message' && (data.agent !== null || data.startsAgent !== true)) {
              if (data.agent === null) throw invalidParams('give the agent the clock messages');
              const agent = reachable(me, data.agent);
              item = await add(data, { beside: agent.sessionId });
              entry.detail = `${cronWords(data.cron)}, messaging ${agent.name}`;
            } else {
              const zoneId = optionalStringParam(p, 'zoneId') ?? me.zoneId;
              const zone = zones().find((each) => each.id === zoneId);
              if (zone === undefined) throw invalidParams(zoneId === null ? 'name the zone its fresh agents start in' : `no zone ${zoneId}`);
              if (!access.reachesZone(me, zone)) throw outOfScope(`${zone.name} is outside your scope (${access.scopeText(me)})`);
              // Beside the caller's own tile in that zone, else at the zone's top-left.
              const own = me.agent !== null && me.agent.zoneId === zone.id ? me.agent.sessionId : undefined;
              item = own === undefined ? await add({ ...data, agent: null }, { zoneId: zone.id, x: CLOCK_GAP, y: CLOCK_GAP }) : await add({ ...data, agent: null }, { beside: own });
              entry.detail = `${cronWords(data.cron)}, starting ${data.does === 'fresh' ? 'a fresh agent' : 'its agent'} in ${zone.name}`;
            }
            markMadeBy.run(me.agent?.sessionId ?? null, item.id);
            (entry as { on?: { id: string; name: string } }).on = { id: item.id, name: `clock ${cronWords(data.cron)}` };
            return item;
          });
        },
        'orchestrator.removeClock': (params, connection) => {
          const p = paramsObject(params);
          const me = access.caller('orchestrator.removeClock', p, connection);
          const entry: { detail: string; on?: { id: string; name: string } } = { detail: '' };
          return access.logged(me, 'remove-clock', entry, async () => {
            const id = stringParam(p, 'id');
            const row = selectMadeBy.get(id) as { made_by: string | null } | undefined;
            if (row === undefined) throw invalidParams(`no clock ${id}`);
            const { data } = clockOf(id)!;
            entry.on = { id, name: `clock ${cronWords(data.cron)}` };
            if (!access.madeByCrew(me, row.made_by)) throw outOfScope('that clock is not one you, or an agent you started, made');
            await call('item.delete', { id });
            return null;
          });
        },
      };
    },

    agentHandlers<Context extends BoardConnection>(sources: BoardCallerSources): RpcHandlers<AgentClockMethods, Context> {
      /** The live agent whose own session holds the call's board token: never a shell's, nor an ended agent's. */
      const caller = (p: Record<string, unknown>, connection: BoardConnection): Agent => {
        const who = boardCaller(sources, stringParam(p, 'token'), connection);
        const me = who.kind === 'agent' ? agents.get(who.tileId) : undefined;
        if (me === undefined || !isOwnLiveSession(me, who.sessionId)) throw invalidParams("only a live agent has a clock of its own, from its own session: not a shell, nor an ended agent's");
        return me;
      };
      return {
        'clock.self': (params, connection) => {
          const p = paramsObject(params);
          return changeSelf(caller(p, connection), p);
        },
        'clock.addSelf': async (params, connection) => {
          const p = paramsObject(params);
          const me = caller(p, connection);
          const from = withTemplate(p, {});
          const prompt = (optionalStringParam(p, 'prompt') ?? from.prompt ?? '').trim();
          if (prompt === '') throw invalidParams('give the clock its prompt: what it sends you');
          const cron = (optionalStringParam(p, 'cron') ?? from.cron)?.trim();
          if (cron === undefined) throw invalidParams("give the clock's cron expression");
          // A template that hibernates its agent hibernates you; any other leaves you idle.
          const after = optionalStringParam(p, 'after') ?? (from.does === 'message' && from.hibernate === true ? 'hibernate' : 'idle');
          if (after !== 'hibernate' && after !== 'idle') throw invalidParams('after must be hibernate or idle: a clock of your own messages you');
          // Made by no one, as the clock the user gives an agent is: its fresh agents, should it start them, are no one's crew.
          const item = await add({ ...from, cron, prompt, ...withClockMode(after), startsAgent: false, agent: me.sessionId }, { beside: me.sessionId });
          log(`clock ${item.id}: ${me.name} added it, messaging itself`);
          return item;
        },
      };
    },

    onEvent(event) {
      if (event.type === 'item.updated' && event.item.kind === 'clock') {
        schedules.replan(event.item.id);
        dropStuck(event.item.id);
      } else if (event.type === 'item.removed') {
        schedules.replan(event.id);
        dropStuck(event.id);
      }
      else if (event.type === 'agent.updated') {
        noteFlag(event.agent);
        failIfOver(event.agent.sessionId, event.agent);
      }
      else if (event.type === 'agent.removed') failIfOver(event.sessionId, undefined);
    },

    turnEnded,
    turnCut,

    resumeRuns() {
      // A run with its result kept is done; one whose agent the app stopped says so, and closes it as its clock says; one whose agent never started, or
      // has ended or gone since, fails; one whose agent is still at work carries on.
      for (const run of schedules.running()) {
        const agent = run.sessionId === null ? undefined : agents.get(run.sessionId);
        if (!run.fresh || (run.sessionId !== null && ownsRun(run, run.sessionId))) {
          // Its agent is the clock's own, never closed: a restart that stopped it ends the run, and Resume all or the next run wakes it.
          if (agent?.state === 'stopped-by-restart') schedules.updateRun(run.runId, { outcome: 'failed', reason: STOPPED_DURING, finishedAt: now() });
          else failIfOver(run.sessionId!, agent);
          continue;
        }
        if (run.result !== null) schedules.updateRun(run.runId, { outcome: 'done', reason: 'the app stopped as it finished', finishedAt: now() });
        else if (run.sessionId === null) schedules.updateRun(run.runId, { outcome: 'failed', reason: 'the app stopped as it started', finishedAt: now() });
        else if (agent?.state === 'stopped-by-restart') {
          void stoppedDuring(run, run.sessionId).catch((error: unknown) => log(`clock ${run.clockId}: could not close its agent: ${(error as Error).message}`));
        } else failIfOver(run.sessionId, agent);
      }
    },

    agentRemoved(sessionId) {
      for (const clockId of schedules.joinedTo(sessionId)) {
        const data = clockOf(clockId)?.data;
        if (data === undefined) continue;
        const patch = { ...(data.agent === sessionId ? { agent: null } : {}), ...(data.handoffTo === sessionId ? { handoffTo: null } : {}) };
        void call('item.update', { id: clockId, data: patch })
          .catch((error: unknown) => log(`clock ${clockId}: could not unjoin it: ${(error as Error).message}`));
      }
    },

    close: () => schedules.close(),
  };
}

function placeParam(p: Record<string, unknown>): ClockPlace {
  const place = p.place;
  if (!isObject(place)) throw invalidParams('place must be { beside } or { zoneId, x, y }');
  if (place.beside !== undefined) return { beside: stringParam(place, 'beside') };
  const zoneId = place.zoneId === null ? null : stringParam(place, 'zoneId');
  return { zoneId, x: finiteNumberParam(place, 'x'), y: finiteNumberParam(place, 'y') };
}
