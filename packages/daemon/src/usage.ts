// Usage pacing: the newest plan usage reading, which Claude agents' status lines post (never asked of anyone, so no
// tokens are spent reading it); the user's priorities and thresholds; and the budget hold the Captain may place, only
// while the user lets it, within those thresholds.
import type { DatabaseSync } from 'node:sqlite';
import type { AgentHost } from './agents.ts';
import type { BoardConnection } from './board.ts';
import type { Orchestrator, OrchestratorAccess } from './orchestrators.ts';
import { invalidParams, paramsObject, stringParam } from './params.ts';
import {
  BOARD_ERROR,
  USAGE_STALE_MS,
  usagePace,
  type Agent,
  type DaemonEvent,
  type DaemonMethods,
  type DaemonSettings,
  type UsagePace,
  type UsageReading,
  type UsageWindow,
  type Zone,
} from './protocol.ts';
import { RpcMethodError, type RpcHandlers } from './rpc.ts';
import type { ZoneTable } from './zones.ts';

type UsageMethods = Pick<DaemonMethods, 'usage.get' | 'usage.priorities' | 'orchestrator.hold' | 'orchestrator.release' | 'orchestrator.usagePause'>;

/** How often a reading whose percentages haven't changed is written and told again: it is still the newest. */
const SAME_READING_MS = 60_000;

interface ReadingRow {
  five_hour_used: number | null;
  five_hour_resets_at: number | null;
  seven_day_used: number | null;
  seven_day_resets_at: number | null;
  read_at: string;
}

export interface UsageHostOptions {
  db: DatabaseSync;
  settings(): DaemonSettings;
  zones: Pick<ZoneTable, 'list' | 'find' | 'setUsageHold'>;
  agents: Pick<AgentHost, 'get' | 'pause'>;
  /** Hears a zone's budget hold lifted: what waited on it goes on. */
  released(zoneId: string): void;
  broadcast(event: DaemonEvent): void;
  log(message: string): void;
  now?: () => number;
}

export interface UsageHost {
  /**
   * Takes what Claude Code passed an agent's status line (its JSON): its `rate_limits` become the newest reading. One
   * without them (an API-key session, an older Claude Code) changes nothing.
   */
  record(statusLine: unknown): void;
  reading(): UsageReading;
  /** Why a hand-off to the agent waits: it is paused for usage, or its zone is held; undefined otherwise. */
  heldFor(sessionId: string): string | undefined;
  handlers<Context extends BoardConnection>(access: OrchestratorAccess): RpcHandlers<UsageMethods, Context>;
  /** Stops telling clients when the reading goes stale. */
  close(): void;
}

export function createUsageHost(options: UsageHostOptions): UsageHost {
  const { db, zones, agents } = options;
  const now = options.now ?? Date.now;
  const select = db.prepare('SELECT * FROM usage_reading WHERE id = 1');
  const upsert = db.prepare(
    `INSERT INTO usage_reading (id, five_hour_used, five_hour_resets_at, seven_day_used, seven_day_resets_at, read_at)
     VALUES (1, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET five_hour_used = excluded.five_hour_used, five_hour_resets_at = excluded.five_hour_resets_at,
       seven_day_used = excluded.seven_day_used, seven_day_resets_at = excluded.seven_day_resets_at, read_at = excluded.read_at`,
  );

  const reading = (): UsageReading => {
    const row = select.get() as ReadingRow | undefined;
    if (row === undefined) return { fiveHour: null, sevenDay: null, readAt: null, stale: true };
    const at = now();
    const fiveHour = usageWindow(row.five_hour_used, row.five_hour_resets_at);
    const sevenDay = usageWindow(row.seven_day_used, row.seven_day_resets_at);
    // A window that has reset since is back near 0, whatever the reading said.
    const reset = [row.five_hour_resets_at, row.seven_day_resets_at].some((resets) => resets !== null && resets * 1000 <= at);
    return { fiveHour, sevenDay, readAt: row.read_at, stale: reset || at - Date.parse(row.read_at) > USAGE_STALE_MS };
  };

  /** Tells clients once the reading goes stale, as no newer one will. */
  let staleTimer: NodeJS.Timeout | undefined;
  const announce = () => {
    options.broadcast({ type: 'usage.updated', usage: reading() });
    armStale();
  };
  /** Sets the timer that tells clients once the reading goes stale: on each reading, and on a start with one kept. */
  const armStale = () => {
    const usage = reading();
    clearTimeout(staleTimer);
    if (usage.stale || usage.readAt === null) return;
    const row = select.get() as unknown as ReadingRow;
    const resets = [row.five_hour_resets_at, row.seven_day_resets_at].filter((each): each is number => each !== null).map((each) => each * 1000);
    const staleAt = Math.min(Date.parse(usage.readAt) + USAGE_STALE_MS + 1, ...resets);
    staleTimer = setTimeout(announce, Math.max(0, staleAt - now()));
    staleTimer.unref();
  };

  const record = (statusLine: unknown) => {
    const limits = isObject(statusLine) ? statusLine.rate_limits : undefined;
    if (!isObject(limits)) return;
    const five = windowOf(limits.five_hour);
    const seven = windowOf(limits.seven_day);
    if (five === undefined && seven === undefined) return;
    const was = select.get() as ReadingRow | undefined;
    const values = [five?.used ?? null, five?.resetsAt ?? null, seven?.used ?? null, seven?.resetsAt ?? null] as const;
    const same =
      was !== undefined &&
      [was.five_hour_used, was.five_hour_resets_at, was.seven_day_used, was.seven_day_resets_at].every((value, index) => value === values[index]);
    // Status lines run every few seconds: the same reading again is written, and told, at most once a minute.
    if (same && now() - Date.parse(was.read_at) < SAME_READING_MS) return;
    upsert.run(...values, new Date(now()).toISOString());
    announce();
  };

  // A reading kept from before a restart still goes stale in its clients' eyes.
  armStale();

  const paceOf = (zone: Zone): UsagePace => usagePace(reading(), zone.priority, options.settings().usageThresholds);

  /**
   * Throws unless `me` may place a budget hold in `zone` now, returning why it may: the Captain or the user's side, with
   * the user's switch on, a fresh reading, and the zone past the threshold `which` names.
   */
  const checkPacer = (me: Orchestrator) => {
    if (me.agent !== null && !me.agent.master) throw refused('only the Captain paces work by usage');
  };

  const checkHold = (me: Orchestrator, zone: Zone, which: keyof UsagePace): string => {
    checkPacer(me);
    if (!options.settings().usagePacing) {
      throw refused("the user hasn't let the Captain pace work by usage: it is off in Settings › Usage, and only the user turns it on");
    }
    const usage = reading();
    if (usage.stale) throw refused(usage.readAt === null ? 'there is no usage reading yet' : 'the usage reading is stale: a Claude agent updates it as it runs');
    const reason = paceOf(zone)[which];
    if (reason === null) {
      const what = which === 'holdStarts' ? 'hold its starts' : 'pause its idle agents';
      throw refused(`${zone.name} (${zone.priority} priority) is within the user's thresholds: they don't let you ${what} now`);
    }
    return reason;
  };

  const zoneParam = (p: Record<string, unknown>): Zone => {
    const id = stringParam(p, 'zoneId');
    const zone = zones.find(id);
    if (zone === undefined) throw invalidParams(`no zone ${id}`);
    return zone;
  };

  return {
    record,
    reading,
    heldFor(sessionId) {
      const agent = agents.get(sessionId);
      // Paused for usage, it waits for the Captain or the user, as its zone's hold would have it wait.
      if (agent?.hibernated?.reason !== undefined) return `held: paused for usage, ${agent.hibernated.reason}`;
      const hold = agent?.zoneId == null ? null : (zones.find(agent.zoneId)?.usageHold ?? null);
      return hold === null ? undefined : `held: ${hold.reason}`;
    },
    handlers: <Context extends BoardConnection>(access: OrchestratorAccess): RpcHandlers<UsageMethods, Context> => ({
      'usage.get': () => reading(),
      'usage.priorities': () => {
        const { usagePacing, usageThresholds } = options.settings();
        return {
          pacing: usagePacing,
          thresholds: usageThresholds,
          zones: zones.list().map((zone) => ({ id: zone.id, name: zone.name, priority: zone.priority, hold: zone.usageHold, pace: paceOf(zone) })),
        };
      },
      'orchestrator.hold': (params, connection) => {
        const p = paramsObject(params);
        const me = access.caller('orchestrator.hold', p, connection);
        const entry: { detail: string; on?: { id: string; name: string } } = { detail: '' };
        return access.logged(me, 'hold', entry, () => {
          const zone = zoneParam(p);
          entry.on = { id: zone.id, name: zone.name };
          const reason = checkHold(me, zone, 'holdStarts');
          entry.detail = reason;
          zones.setUsageHold(zone.id, reason);
          options.log(`held zone ${zone.id} for usage: ${reason}`);
          return zones.find(zone.id)!;
        });
      },
      'orchestrator.release': (params, connection) => {
        const p = paramsObject(params);
        const me = access.caller('orchestrator.release', p, connection);
        const entry: { detail: string; on?: { id: string; name: string } } = { detail: '' };
        return access.logged(me, 'release', entry, () => {
          const zone = zoneParam(p);
          entry.on = { id: zone.id, name: zone.name };
          // Lifting a hold is the Captain's, or the user's Override: never the held zone's own lead's.
          checkPacer(me);
          if (zone.usageHold === null) throw invalidParams(`${zone.name} is not held`);
          zones.setUsageHold(zone.id, null);
          options.log(`released zone ${zone.id}'s budget hold`);
          options.released(zone.id);
          return zones.find(zone.id)!;
        });
      },
      'orchestrator.usagePause': (params, connection) => {
        const p = paramsObject(params);
        const me = access.caller('orchestrator.usagePause', p, connection);
        const entry: { detail: string; on?: { id: string; name: string } } = { detail: '' };
        return access.logged(me, 'pause', entry, (): Promise<Agent> => {
          const sessionId = stringParam(p, 'sessionId');
          const agent = agents.get(sessionId);
          if (agent === undefined) throw invalidParams(`no agent ${sessionId}`);
          entry.on = { id: agent.sessionId, name: agent.name };
          if (!access.reachesAgent(me, agent)) throw new RpcMethodError(BOARD_ERROR.outOfScope, `${agent.name} is outside your scope (${access.scopeText(me)})`);
          const zone = agent.zoneId === null ? undefined : zones.find(agent.zoneId);
          if (zone === undefined) throw refused(`${agent.name} is in no zone, so no priority holds it`);
          const reason = checkHold(me, zone, 'pauseIdle');
          entry.detail = `for usage: ${reason}`;
          const by = me.agent === null ? null : me.sessionId;
          return agents.pause(agent.sessionId, by, `a pause for usage (${reason})`, reason);
        });
      },
    }),
    close: () => clearTimeout(staleTimer),
  };
}

/** A budget hold the rules don't allow: said to the caller as why. */
function refused(message: string): RpcMethodError {
  return new RpcMethodError(BOARD_ERROR.notAllowed, message);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A status line's `rate_limits` window: its used percentage and when it resets, in epoch seconds. */
function windowOf(value: unknown): { used: number; resetsAt: number | null } | undefined {
  if (!isObject(value)) return undefined;
  const used = value.used_percentage;
  if (typeof used !== 'number' || !Number.isFinite(used) || used < 0) return undefined;
  const resetsAt = typeof value.resets_at === 'number' && Number.isFinite(value.resets_at) ? Math.round(value.resets_at) : null;
  return { used: Math.min(used, 100), resetsAt };
}

function usageWindow(used: number | null, resetsAt: number | null): UsageWindow | null {
  if (used === null) return null;
  return { usedPercent: used, remainingPercent: Math.max(0, 100 - used), resetsAt: resetsAt === null ? null : new Date(resetsAt * 1000).toISOString() };
}
