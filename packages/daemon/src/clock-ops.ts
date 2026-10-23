// The schedule commands as the CLI and MCP give them (`schedule add|list|remove`): refs and words turned into the
// daemon's clock methods, and their results as text and JSON (ADR-0010's one API, two faces).
import { BoardError, BoardRefs, inZone, readBoard, resolveAgent, type BoardSession, type BoardView } from './board-ops.ts';
import { cronWords, parseCron } from './cron.ts';
import { CLOCK_RESULTS, HARNESSES, type ClockData, type ClockResult, type ClockStatus, type Harness } from './protocol.ts';

/** What `schedule add` takes, as typed. */
export interface ScheduleOptions {
  cron: string;
  prompt: string;
  /** The agent it messages: a ref. */
  to?: string;
  /** Starts a fresh agent instead. */
  fresh?: boolean;
  /** A fresh agent's zone: a ref. */
  zone?: string;
  harness?: string;
  model?: string;
  role?: string;
  /** Leaves a fresh agent open once its run is over. */
  keep?: boolean;
  result?: string;
  /** The agent a fresh agent's result is handed to: a ref. */
  handoffTo?: string;
}

/** Checks `schedule add`'s options before anything connects. */
export function checkSchedule(options: ScheduleOptions): void {
  try {
    parseCron(options.cron);
  } catch (error) {
    throw new BoardError(`the schedule can't be used: ${(error as Error).message}`);
  }
  if (options.prompt.trim() === '') throw new BoardError('give the schedule its prompt: what it sends, or a fresh agent its task');
  if ((options.to === undefined) === (options.fresh !== true)) throw new BoardError('give --to <agent> to message one, or --fresh to start one each run');
  const freshOnly = (['zone', 'harness', 'model', 'role', 'keep', 'result', 'handoffTo'] as const).find((key) => options[key] !== undefined);
  if (options.fresh !== true && freshOnly !== undefined) throw new BoardError(`--${freshOnly === 'handoffTo' ? 'handoff-to' : freshOnly} is only for --fresh`);
  if (options.harness !== undefined && !(HARNESSES as readonly string[]).includes(options.harness)) throw new BoardError(`--harness must be ${HARNESSES.join(' or ')}`);
  if (options.result !== undefined && !(CLOCK_RESULTS as readonly string[]).includes(options.result)) throw new BoardError(`--result must be ${CLOCK_RESULTS.join(', ')}`);
  if ((options.result === 'handoff') !== (options.handoffTo !== undefined)) throw new BoardError('--result handoff goes with --handoff-to <agent>');
}

/** A clock in a line: its ref, its schedule in words, what it does, when it next runs and how its last run went. */
function clockLine(refs: BoardRefs, data: ClockData, status: ClockStatus | undefined, id: string): string {
  const agentName = (sessionId: string | null) =>
    sessionId === null ? 'no agent' : `${refs.of('agent', sessionId)} ${refs.board.agents.find((each) => each.sessionId === sessionId)?.name ?? '(gone)'}`;
  const does = data.does === 'message' ? `messages ${agentName(data.agent)}` : `starts a fresh ${data.fresh.role ?? 'agent'}${data.result === 'handoff' ? `, handing its result to ${agentName(data.handoffTo)}` : ''}`;
  const next = !data.enabled ? 'off' : status?.nextRunAt == null ? 'not set' : `next ${status.nextRunAt}`;
  const last = status?.runs[0];
  return `${refs.of('item', id)}  ${cronWords(data.cron)} (${data.cron})  ${does}  ${next}${last === undefined ? '' : `  last ${last.outcome}`}\n    ${JSON.stringify(data.prompt)}`;
}

/** `schedule add`: a clock that messages an agent, or starts a fresh one each run, marked as made by the caller. */
export async function addSchedule(session: BoardSession, options: ScheduleOptions): Promise<BoardView> {
  checkSchedule(options);
  const refs = new BoardRefs(await readBoard(session.client));
  const agentId = (ref: string) => resolveAgent(refs, ref, session.caller).sessionId;
  // A zone, whatever else shares its name.
  const zone = options.zone === undefined ? undefined : refs.resolve(options.zone.includes(':') ? options.zone : `zone:${options.zone}`, session.caller);
  if (zone !== undefined && zone.kind !== 'zone') throw new BoardError(`${options.zone} is a ${zone.kind}, not a zone`);
  const data: Partial<ClockData> = {
    cron: options.cron.trim(),
    prompt: options.prompt.trim(),
    does: options.fresh === true ? 'fresh' : 'message',
    ...(options.to === undefined ? {} : { agent: agentId(options.to) }),
    ...(options.fresh === true
      ? {
          fresh: { harness: (options.harness ?? 'claude') as Harness, model: options.model ?? null, role: options.role ?? null, closeWhenDone: options.keep !== true },
          result: (options.result ?? 'history') as ClockResult,
          handoffTo: options.handoffTo === undefined ? null : agentId(options.handoffTo),
        }
      : {}),
  };
  const item = await session.client.call('orchestrator.addClock', { token: session.token, data, ...(zone?.kind === 'zone' ? { zoneId: zone.zone.id } : {}) });
  const fresh = new BoardRefs(await readBoard(session.client));
  const status = (await session.client.call('clock.list')).find((each) => each.id === item.id);
  return { text: `Added ${clockLine(fresh, item.data as unknown as ClockData, status, item.id)}\n  ${inZone(fresh, item.zoneId)}.`, json: { item, status } };
}

/** `schedule list`: every clock on the board. */
export async function listSchedules(session: BoardSession): Promise<BoardView> {
  const refs = new BoardRefs(await readBoard(session.client));
  const statuses = await session.client.call('clock.list');
  const clocks = refs.board.items.filter((item) => item.kind === 'clock');
  const lines = clocks.map((item) => clockLine(refs, item.data as unknown as ClockData, statuses.find((status) => status.id === item.id), item.id));
  return {
    text: lines.length === 0 ? 'No schedules on the board. `agent-board schedule add` makes one.' : lines.join('\n'),
    json: clocks.map((item) => ({ item, status: statuses.find((status) => status.id === item.id) ?? null })),
  };
}

/** `schedule remove`: deletes a clock the caller (or its crew) made. */
export async function removeSchedule(session: BoardSession, ref: string): Promise<BoardView> {
  const refs = new BoardRefs(await readBoard(session.client));
  const object = refs.resolve(ref, session.caller);
  if (object.kind !== 'item' || object.item.kind !== 'clock') throw new BoardError(`${ref} is not a schedule: \`agent-board schedule list\` lists them`);
  await session.client.call('orchestrator.removeClock', { token: session.token, id: object.item.id });
  return { text: `Removed ${refs.of('item', object.item.id)}.`, json: null };
}
