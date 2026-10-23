// A clock as the board draws it: its schedule in words, what it does, when it next runs and how its last runs went;
// and the tethers that join it to the agent it messages, or to the fresh agent its run started.
import type { Edge, Node } from '@xyflow/react';
import { cronWords, parseCron } from '@agent-board/daemon/cron';
import { CLOCK_ACTIONS, CLOCK_RESULTS, HARNESSES, type ClockData, type ClockRun, type ClockStatus } from '@agent-board/daemon/protocol';
import { isItemNode, type ItemNodeType } from './items/items';
import { TETHER_EDGE_TYPE } from './items/agent-note-tethers';
import { whenLabel } from './schedule';
import { tileNodeId } from './tiles';

/** How many runs a clock's strip shows. */
const STRIP_RUNS = 10;
const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
const CLOCK_TETHER_PREFIX = 'clock-tether:';

/** A clock's data, with a new clock's defaults for anything missing or of the wrong type. */
export function clockData(data: Record<string, unknown>): ClockData {
  const fresh = (typeof data.fresh === 'object' && data.fresh !== null ? data.fresh : {}) as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === 'string' ? value : null);
  return {
    cron: typeof data.cron === 'string' ? data.cron : '0 9 * * 1-5',
    enabled: data.enabled !== false,
    does: CLOCK_ACTIONS.find((action) => action === data.does) ?? 'message',
    agent: text(data.agent),
    prompt: typeof data.prompt === 'string' ? data.prompt : '',
    fresh: {
      harness: HARNESSES.find((harness) => harness === fresh.harness) ?? 'claude',
      model: text(fresh.model),
      role: text(fresh.role),
      closeWhenDone: fresh.closeWhenDone !== false,
    },
    result: CLOCK_RESULTS.find((result) => result === data.result) ?? 'history',
    handoffTo: text(data.handoffTo),
    folded: data.folded === true,
  };
}

/** How one run reads in a clock's strip: green done, red failed, grey skipped, accent still going. */
export type RunMark = 'ok' | 'fail' | 'skip' | 'run';

const MARKS: Record<ClockRun['outcome'], RunMark> = { started: 'ok', done: 'ok', failed: 'fail', skipped: 'skip', running: 'run' };

/** What a clock's card and pill say. */
export interface ClockCard {
  /** The schedule in words: `Weekdays 09:00`. */
  words: string;
  /** What it does and when: `→ Nightly deps check · next 09:00`, `✦ fresh implementer · running`. */
  detail: string;
  /** The pill's short line: `in 2h 40m`, `running`, `off`, `not set`. */
  soon: string;
  /** Its last runs, oldest first. */
  runs: RunMark[];
  /** Whether a fresh agent of its is at work. */
  running: boolean;
}

/** The fresh agent a clock's run is waiting on, if one is. */
export function runningAgent(status: ClockStatus | undefined): string | undefined {
  const run = status?.runs.find((each) => each.outcome === 'running');
  return run?.sessionId ?? undefined;
}

/** When `at` is from `now`: `in 2h 40m`, `in 5 min`, or its day and time when further off than a day. */
function until(at: Date, now: Date): string {
  const ms = at.getTime() - now.getTime();
  if (ms >= DAY_MS) return whenLabel(at, now);
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `in ${minutes} min`;
  return `in ${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** What a clock says, given its status and the names of the agents on the board. */
export function clockCard(data: ClockData, status: ClockStatus | undefined, agentName: (sessionId: string) => string | undefined, now: Date): ClockCard {
  const runs = (status?.runs ?? []).slice(0, STRIP_RUNS).map((run) => MARKS[run.outcome]).reverse();
  const running = status?.runs.some((run) => run.outcome === 'running') ?? false;
  const doer = data.does === 'message' ? `→ ${data.agent === null ? '' : (agentName(data.agent) ?? 'an agent no longer here')}` : `✦ fresh ${data.fresh.role ?? 'agent'}`;
  const words = cronWords(data.cron);
  const lacking = data.prompt.trim() === '' ? 'nothing to send' : data.does === 'message' && data.agent === null ? 'join it to an agent' : undefined;
  if (running) return { words, detail: `${doer} · running`, soon: 'running', runs, running };
  if (!data.enabled) return { words, detail: `${doer} · off`, soon: 'off', runs, running };
  if (lacking !== undefined) return { words, detail: `not set: ${lacking}`, soon: 'not set', runs, running };
  const next = status?.nextRunAt == null ? undefined : new Date(status.nextRunAt);
  // In a zone, for a fresh agent: the scheduler plans none in no zone.
  if (next === undefined) return { words, detail: `${doer} · not set: put it in a zone`, soon: 'not set', runs, running };
  return { words, detail: `${doer} · next ${whenLabel(next, now)}`, soon: until(next, now), runs, running };
}

/** The editor's quick choices of when a clock fires. */
export const CLOCK_PRESETS = [
  { id: 'hourly', label: 'Hourly' },
  { id: 'daily', label: 'Daily' },
  { id: 'weekdays', label: 'Weekdays' },
  { id: 'weekly', label: 'Weekly' },
] as const;
export type ClockPreset = (typeof CLOCK_PRESETS)[number]['id'];

/** The cron expression of `preset`, at the time `current` fires at (one minute of one hour), else at 09:00. */
export function presetCron(preset: ClockPreset, current: string): string {
  if (preset === 'hourly') return '0 * * * *';
  let time = '0 9';
  try {
    const cron = parseCron(current);
    if (cron.minutes.size === 1 && cron.hours.size === 1) time = `${[...cron.minutes][0]} ${[...cron.hours][0]}`;
  } catch {
    // Not one it can read: nine o'clock.
  }
  return `${time} * * ${preset === 'daily' ? '*' : preset === 'weekdays' ? '1-5' : '1'}`;
}

const isClock = (node: Node): node is ItemNodeType => isItemNode(node) && node.data.item.kind === 'clock';

/**
 * A tether from each clock to the tile of the agent it messages, or of the fresh agent its run is waiting on, while
 * that tile is on the board. Derived, never stored, as an agent note's is.
 */
export function clockTethers(nodes: readonly Node[], statuses: ReadonlyMap<string, ClockStatus>): Edge[] {
  const onBoard = new Set(nodes.map((node) => node.id));
  return nodes.filter(isClock).flatMap((clock) => {
    const data = clockData(clock.data.item.data);
    const subject = data.does === 'message' ? data.agent : runningAgent(statuses.get(clock.data.item.id));
    if (subject == null) return [];
    const tile = tileNodeId('agent', subject);
    if (!onBoard.has(tile)) return [];
    return [
      {
        id: `${CLOCK_TETHER_PREFIX}${clock.id}`,
        type: TETHER_EDGE_TYPE,
        source: clock.id,
        // As an agent note's tether: the edge joins the sides that face each other, whatever these say.
        sourceHandle: 'right',
        target: tile,
        targetHandle: 'left',
        data: { tab: false, look: 'clock' },
        selectable: false,
        deletable: false,
        focusable: false,
        zIndex: 0,
      },
    ];
  });
}
