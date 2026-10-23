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
  roleLabel,
  type Agent,
  type BoardItem,
  type ClockData,
  type ClockPlace,
  type DaemonEvent,
  type DaemonMethods,
  type ScheduleSpec,
  type Zone,
  BOARD_ERROR,
} from './protocol.ts';
import type { BoardConnection } from './board.ts';
import type { OrchestratorAccess } from './orchestrators.ts';
import { RpcMethodError, type RpcHandlers } from './rpc.ts';
import { cronWords } from './cron.ts';
import { createScheduleHost, type FiringClock, type Fired, type ScheduleHost } from './schedules.ts';
import { cutText } from './text-cut.ts';
import { isObject } from './json.ts';
import { asksSomething } from './hook-states.ts';
import { AGENT_TILE_SIZE, freeSpotFor } from './board-layout.ts';

type ClockMethods = Pick<DaemonMethods, 'clock.list' | 'clock.add' | 'agent.setSchedule'>;
type OrchestratorClockMethods = Pick<DaemonMethods, 'orchestrator.addClock' | 'orchestrator.removeClock'>;

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

/** A new clock's data: weekdays at nine, on, messaging, with nothing to say yet. */
function newClockData(): ClockData {
  return {
    cron: '0 9 * * 1-5',
    enabled: true,
    does: 'message',
    agent: null,
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
  agents: Pick<AgentHost, 'get' | 'runScheduled' | 'spawn' | 'finalMessage' | 'delete' | 'stop' | 'deliver' | 'announce'>;
  /** The daemon's own methods: clocks, notes and their changes are made as the board makes them. */
  call: DaemonCall;
  broadcast(event: DaemonEvent): void;
  log(message: string): void;
}

export interface ClockHost {
  /** The scheduler, for the agents' own schedules (`Agent.schedule`) and keeping the daemon up. */
  schedules: Pick<ScheduleHost, 'forAgent' | 'runOf' | 'hasEnabled'>;
  handlers<Context>(): RpcHandlers<ClockMethods, Context>;
  /** The orchestrator's clock methods: `schedule add` and `schedule remove`, in its scope, logged. */
  orchestratorHandlers<Context extends BoardConnection>(access: OrchestratorAccess, zones: () => Zone[]): RpcHandlers<OrchestratorClockMethods, Context>;
  /** Hears every event the daemon broadcasts: a clock changed, or a fresh agent failed or ended. */
  onEvent(event: DaemonEvent): void;
  /** The agent's turn ended: a fresh agent's run is over, unless its turn ended asking the user something. */
  turnEnded(sessionId: string): void;
  /** Settles the runs a stopped daemon left going, once the agents are there to ask. */
  resumeRuns(): void;
  /** The agent is being deleted: the clocks joined to it are left unjoined. */
  agentRemoved(sessionId: string): void;
  /** Stops firing. */
  close(): void;
}

export function createClockHost(options: ClockHostOptions): ClockHost {
  const { agents, call, log } = options;
  /** Fresh agents' runs being finished, so a second turn end doesn't finish one twice. */
  const finishing = new Set<string>();

  const fire = (firing: FiringClock, count: number): Fired => {
    const { data } = firing;
    if (data.does === 'message') {
      const agent = agents.get(data.agent!);
      if (agent === undefined) return { started: false, reason: 'its agent is gone' };
      return { ...agents.runScheduled(agent.sessionId, data.prompt), sessionId: agent.sessionId, agentName: agent.name };
    }
    // An orchestrator's clock starts its agents in its crew, so they are no shallower than it could start them.
    const maker = (selectMadeBy.get(firing.id) as { made_by: string | null } | undefined)?.made_by ?? null;
    if (maker !== null && agents.get(maker) === undefined) return { started: false, reason: 'the orchestrator that made it is gone' };
    const onBoard = (selectRunAgents.all(firing.id) as { session_id: string }[]).filter((row) => agents.get(row.session_id) !== undefined).length;
    if (onBoard >= MAX_FRESH_ON_BOARD) return { started: false, reason: `${onBoard} agents it started are still on the board` };
    return { running: true, start: (runId) => void startFresh(firing, runId, count, maker ?? undefined) };
  };
  const selectRunAgents = options.db.prepare('SELECT DISTINCT session_id FROM clock_runs WHERE clock_id = ? AND session_id IS NOT NULL');

  const selectClock = options.db.prepare("SELECT data, x, y, height FROM board_items WHERE kind = 'clock' AND id = ?");
  /** The clock's data and where it is, as stored now; undefined once it is deleted. */
  const clockOf = (clockId: string): { data: ClockData; x: number; y: number; height: number } | undefined => {
    const row = selectClock.get(clockId) as { data: string; x: number; y: number; height: number } | undefined;
    return row === undefined ? undefined : { ...row, data: JSON.parse(row.data) as ClockData };
  };
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
  const schedules = createScheduleHost({
    db: options.db,
    clock: options.clock,
    fire,
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

  const startFresh = async (firing: FiringClock, runId: number, count: number, spawnedBy: string | undefined) => {
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
    if (agent !== undefined && (data?.fresh.closeWhenDone ?? true)) {
      const kept = await close(sessionId, 'its clock run finished');
      if (kept !== undefined) notes.push(kept);
    }
    schedules.updateRun(runId, { outcome: 'done', reason: notes.length === 0 ? null : notes.join('; '), result: result === '' ? null : result, finishedAt: now() });
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
  const stoppedDuring = async (runId: number, clockId: string, sessionId: string) => {
    schedules.updateRun(runId, { outcome: 'failed', reason: STOPPED_DURING, finishedAt: now() });
    if (!(clockOf(clockId)?.data.fresh.closeWhenDone ?? true)) return;
    const kept = await close(sessionId, 'the app stopped during its clock run');
    if (kept !== undefined) schedules.updateRun(runId, { reason: `${STOPPED_DURING}; ${kept}` });
  };

  function turnEnded(sessionId: string) {
    const run = schedules.runOf(sessionId);
    if (run === undefined || finishing.has(sessionId)) return;
    // A turn that ended asking the user something isn't the end of its work: it waits for them, its run going on.
    if (asksSomething(agents.finalMessage(sessionId))) return;
    finishing.add(sessionId);
    void finish(sessionId, run.runId, run.clockId)
      .catch((error: unknown) => {
        log(`clock ${run.clockId}: could not finish its run: ${(error as Error).message}`);
        schedules.updateRun(run.runId, { outcome: 'failed', reason: (error as Error).message, finishedAt: now() });
      })
      .finally(() => finishing.delete(sessionId));
  }

  /** A fresh agent that failed, or ended or went before its turn did, fails its run. */
  const failIfOver = (sessionId: string, agent: Agent | undefined) => {
    const run = schedules.runOf(sessionId);
    if (run === undefined || finishing.has(sessionId)) return;
    // The app stopping isn't the agent's doing: `resumeRuns` settles that run.
    if (agent?.state === 'stopped-by-restart') return;
    const why = agent === undefined ? 'its agent was removed' : agent.state === 'failed' ? `${agent.name} failed` : agent.endedAt !== null ? `${agent.name} ended before it finished` : undefined;
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

  return {
    schedules,

    handlers<Context>(): RpcHandlers<ClockMethods, Context> {
      return {
        'clock.list': () => schedules.statuses(),
        'clock.add': (params) => {
          const p = paramsObject(params);
          const data = p.data === undefined ? {} : p.data;
          if (!isObject(data)) throw invalidParams('data must be an object');
          return add(data as Partial<ClockData>, placeParam(p));
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
            const data = { ...newClockData(), ...(p.data as Partial<ClockData>) };
            if (typeof data.prompt !== 'string' || data.prompt.trim() === '') throw invalidParams('give the clock its prompt');
            if (data.handoffTo !== null && data.result === 'handoff') reachable(me, data.handoffTo);
            let item: BoardItem;
            if (data.does === 'message') {
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
              entry.detail = `${cronWords(data.cron)}, starting a fresh agent in ${zone.name}`;
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

    onEvent(event) {
      if (event.type === 'item.updated' && event.item.kind === 'clock') schedules.replan(event.item.id);
      else if (event.type === 'item.removed') schedules.replan(event.id);
      else if (event.type === 'agent.updated') failIfOver(event.agent.sessionId, event.agent);
      else if (event.type === 'agent.removed') failIfOver(event.sessionId, undefined);
    },

    turnEnded,

    resumeRuns() {
      // A run with its result kept is done; one whose agent the app stopped says so, and closes it as its clock says; one whose agent never started, or
      // has ended or gone since, fails; one whose agent is still at work carries on.
      for (const run of schedules.running()) {
        const agent = run.sessionId === null ? undefined : agents.get(run.sessionId);
        if (run.result !== null) schedules.updateRun(run.runId, { outcome: 'done', reason: 'the app stopped as it finished', finishedAt: now() });
        else if (run.sessionId === null) schedules.updateRun(run.runId, { outcome: 'failed', reason: 'the app stopped as it started', finishedAt: now() });
        else if (agent?.state === 'stopped-by-restart') {
          void stoppedDuring(run.runId, run.clockId, run.sessionId).catch((error: unknown) => log(`clock ${run.clockId}: could not close its agent: ${(error as Error).message}`));
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
