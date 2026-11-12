// The schedule commands as the CLI and MCP give them (`schedule add|list|remove|set|stop|template`): refs and words turned into the
// daemon's clock methods, and their results as text and JSON (ADR-0010's one API, two faces).
import { BoardError, BoardRefs, inZone, readBoard, resolveAgent, type BoardSession, type BoardView } from './board-ops.ts';
import { cronWords, lastRunWords, parseCron } from './cron.ts';
import {
  CLOCK_MODES,
  CLOCK_RESULTS,
  HARNESSES,
  clockMode,
  withClockMode,
  type BoardItem,
  type ClockData,
  type ClockMode,
  type ClockResult,
  type ClockStatus,
  type ClockTemplate,
  type ClockFreshAgent,
  type Harness,
} from './protocol.ts';

/** What `schedule add` takes, as typed. */
export interface ScheduleOptions {
  /** Empty for the template's, with `template`. */
  cron: string;
  prompt: string;
  /** The saved template it starts from, by name: the options given override its fields. */
  template?: string;
  /** The agent it messages: a ref. */
  to?: string;
  /** Messages the caller itself: a clock of its own, which any agent may add. */
  self?: boolean;
  /** What a clock of its own does with the caller after each run: hibernate or idle. */
  after?: string;
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
  const template = options.template !== undefined;
  if (!template || options.cron.trim() !== '') checkCron(options.cron);
  if (!template && options.prompt.trim() === '') throw new BoardError('give the schedule its prompt: what it sends, or a fresh agent its task');
  const targets = [options.to !== undefined, options.fresh === true, options.self === true].filter(Boolean).length;
  if (targets > 1 || (targets === 0 && !template)) throw new BoardError('give --to <agent> to message one, --self to message you, or --fresh to start one each run');
  if (options.after !== undefined && options.self !== true) throw new BoardError('--after is only for --self: `schedule set` changes a clock you have');
  if (options.after !== undefined && options.after !== 'hibernate' && options.after !== 'idle') throw new BoardError('--after must be hibernate or idle: a clock of your own messages you');
  // A template's own clock, with no --to, --self or --fresh, goes in a zone too: a fresh agent's, or one it starts.
  const zoned = template && targets === 0;
  const freshOnly = (['zone', 'harness', 'model', 'role', 'keep', 'result', 'handoffTo'] as const).find((key) => options[key] !== undefined && !(key === 'zone' && zoned));
  if (options.fresh !== true && freshOnly !== undefined) throw new BoardError(`--${freshOnly === 'handoffTo' ? 'handoff-to' : freshOnly} is only for --fresh`);
  if (options.harness !== undefined && !(HARNESSES as readonly string[]).includes(options.harness)) throw new BoardError(`--harness must be ${HARNESSES.join(' or ')}`);
  if (options.result !== undefined && !(CLOCK_RESULTS as readonly string[]).includes(options.result)) throw new BoardError(`--result must be ${CLOCK_RESULTS.join(', ')}`);
  if ((options.result === 'handoff') !== (options.handoffTo !== undefined)) throw new BoardError('--result handoff goes with --handoff-to <agent>');
}

function checkCron(cron: string): void {
  try {
    parseCron(cron);
  } catch (error) {
    throw new BoardError(`the schedule can't be used: ${(error as Error).message}`);
  }
}

/** A fresh agent's settings, as typed, over `from`'s (a template's) or a new clock's. */
function freshOf(options: Pick<ScheduleOptions, 'harness' | 'model' | 'role' | 'keep'>, from?: ClockFreshAgent): ClockFreshAgent {
  return {
    harness: (options.harness ?? from?.harness ?? 'claude') as Harness,
    model: options.model ?? from?.model ?? null,
    role: options.role ?? from?.role ?? null,
    closeWhenDone: options.keep === true ? false : (from?.closeWhenDone ?? true),
  };
}

/** A clock in a line: its ref, its schedule in words, what it does, when it next runs and how its last run went. */
function clockLine(refs: BoardRefs, data: ClockData, status: ClockStatus | undefined, id: string): string {
  const agentName = (sessionId: string | null) =>
    sessionId === null ? 'no agent' : `${refs.of('agent', sessionId)} ${refs.board.agents.find((each) => each.sessionId === sessionId)?.name ?? '(gone)'}`;
  const does = data.does === 'message' ? `messages ${agentName(data.agent)}${data.hibernate === true ? ', hibernating it after each run' : ''}` : `starts a fresh ${data.fresh.role ?? 'agent'}${data.result === 'handoff' ? `, handing its result to ${agentName(data.handoffTo)}` : ''}`;
  const next = !data.enabled ? 'off' : status?.nextRunAt == null ? 'not set' : `next ${status.nextRunAt}`;
  const last = status === undefined ? undefined : lastRunWords(status, new Date());
  return `${refs.of('item', id)}  ${cronWords(data.cron)} (${data.cron})  ${does}  ${next}${last === undefined ? '' : `  ${last}`}\n    ${JSON.stringify(data.prompt)}`;
}

/** `schedule add`: a clock that messages an agent, or starts a fresh one each run, marked as made by the caller; or one of the caller's own (`--self`), made by no one. */
export async function addSchedule(session: BoardSession, options: ScheduleOptions): Promise<BoardView> {
  checkSchedule(options);
  const template = options.template === undefined ? undefined : await findTemplate(session, options.template);
  // What was typed, over the template's.
  const typed = {
    ...(options.cron.trim() === '' ? {} : { cron: options.cron.trim() }),
    ...(options.prompt.trim() === '' ? {} : { prompt: options.prompt.trim() }),
    ...(template === undefined ? {} : { template: template.id }),
  };
  if (options.self === true) {
    const after = options.after as 'hibernate' | 'idle' | undefined;
    const item = await session.client.call('clock.addSelf', { token: session.token, ...typed, ...(after === undefined ? {} : { after }) });
    return addedView(session, item);
  }
  const refs = new BoardRefs(await readBoard(session.client));
  const agentId = (ref: string) => resolveAgent(refs, ref, session.caller).sessionId;
  // A zone, whatever else shares its name.
  const zone = options.zone === undefined ? undefined : refs.resolve(options.zone.includes(':') ? options.zone : `zone:${options.zone}`, session.caller);
  if (zone !== undefined && zone.kind !== 'zone') throw new BoardError(`${options.zone} is a ${zone.kind}, not a zone`);
  const { template: templateId, ...given } = typed;
  const data: Partial<ClockData> = {
    ...given,
    // A template's mode stands unless --to or --fresh says otherwise; one that messages its agent takes --to's.
    ...(options.to === undefined ? {} : { does: 'message', agent: agentId(options.to), startsAgent: false, ...(template?.data.does === 'fresh' ? { hibernate: false } : {}) }),
    ...(options.fresh === true
      ? {
          does: 'fresh',
          fresh: freshOf(options, template?.data.fresh),
          result: (options.result ?? template?.data.result ?? 'history') as ClockResult,
          handoffTo: options.handoffTo === undefined ? null : agentId(options.handoffTo),
        }
      : {}),
  };
  const item = await session.client.call('orchestrator.addClock', {
    token: session.token,
    data,
    ...(templateId === undefined ? {} : { template: templateId }),
    ...(zone?.kind === 'zone' ? { zoneId: zone.zone.id } : {}),
  });
  return addedView(session, item);
}

async function addedView(session: BoardSession, item: BoardItem): Promise<BoardView> {
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

/** What `schedule set` and `schedule stop` take, as typed: a clock's ref, or none for the caller's own. */
export interface OwnScheduleOptions {
  ref?: string;
  after?: string;
  stop?: boolean;
  why: string;
}

/** Checks `schedule set`'s and `schedule stop`'s options before anything connects. */
export function checkOwnSchedule(options: OwnScheduleOptions): void {
  if (options.why.trim() === '') throw new BoardError('say why with --why "…": the user sees it on the clock');
  if (options.stop === true) {
    if (options.after !== undefined) throw new BoardError('--after is for `schedule set`, not `schedule stop`');
    return;
  }
  if (options.after === undefined) throw new BoardError(`give --after ${CLOCK_MODES.join('|')}`);
  if (!(CLOCK_MODES as readonly string[]).includes(options.after)) throw new BoardError(`--after must be ${CLOCK_MODES.join(', ')}`);
}

/** `schedule set` and `schedule stop`: the caller changes its own clock's mode, or turns it off. */
export async function setOwnSchedule(session: BoardSession, options: OwnScheduleOptions): Promise<BoardView> {
  checkOwnSchedule(options);
  let clock: string | undefined;
  if (options.ref !== undefined) {
    const refs = new BoardRefs(await readBoard(session.client));
    const object = refs.resolve(options.ref, session.caller);
    if (object.kind !== 'item' || object.item.kind !== 'clock') throw new BoardError(`${options.ref} is not a schedule: \`agent-board schedule list\` lists them`);
    clock = object.item.id;
  }
  const change = options.stop === true ? { stop: true } : { after: options.after as ClockMode };
  const set = await session.client.call('clock.self', { token: session.token, ...(clock === undefined ? {} : { clock }), ...change, why: options.why.trim() });
  return { text: set.said, json: set };
}

/** What `schedule template save` takes, as typed: a clock to save, or the template's own fields. */
export interface TemplateOptions {
  name: string;
  /** A clock's ref, to save that clock. */
  from?: string;
  cron: string;
  prompt: string;
  after?: string;
  harness?: string;
  model?: string;
  role?: string;
  keep?: boolean;
  result?: string;
}

/** Checks `schedule template save`'s options before anything connects. */
export function checkTemplate(options: TemplateOptions): void {
  if (options.name.trim() === '') throw new BoardError('give the template a name');
  const fields = (['after', 'harness', 'model', 'role', 'keep', 'result'] as const).find((key) => options[key] !== undefined);
  if (options.from !== undefined) {
    if (options.cron !== '' || options.prompt.trim() !== '' || fields !== undefined) throw new BoardError('give --from <clock>, or the template\'s cron, prompt and options, not both');
    return;
  }
  checkCron(options.cron);
  if (options.prompt.trim() === '') throw new BoardError('give the template its prompt: what it sends, or a fresh agent its task');
  if (options.after !== undefined && !(CLOCK_MODES as readonly string[]).includes(options.after)) throw new BoardError(`--after must be ${CLOCK_MODES.join(', ')}`);
  const freshOnly = (['harness', 'model', 'role', 'keep', 'result'] as const).find((key) => options[key] !== undefined);
  if (freshOnly !== undefined && options.after !== 'close') throw new BoardError(`--${freshOnly} is only for --after close: a fresh agent each run`);
  if (options.harness !== undefined && !(HARNESSES as readonly string[]).includes(options.harness)) throw new BoardError(`--harness must be ${HARNESSES.join(' or ')}`);
  if (options.result !== undefined && options.result !== 'history' && options.result !== 'note') throw new BoardError('a template\'s --result must be history or note: it names no agent to hand off to');
}

/** `text` with A to Z folded to lower case, and no other letter: as the daemon's names are matched (SQLite's NOCASE). */
const asciiFolded = (text: string) => text.replace(/[A-Z]/g, (letter) => letter.toLowerCase());

/** The template `ref` names, by id or name: its very name first, then one in another case of A to Z, as the daemon matches. */
async function findTemplate(session: BoardSession, ref: string): Promise<ClockTemplate> {
  const templates = await session.client.call('clockTemplate.list', { token: session.token });
  const name = ref.trim();
  const found = templates.find((each) => each.id === ref || each.name === name) ?? templates.find((each) => asciiFolded(each.name) === asciiFolded(name));
  if (found === undefined) throw new BoardError(`no clock template ${ref}: \`agent-board schedule template list\` lists them`);
  return found;
}

/** A template in a line: its name, schedule, what it does and who saved it, then its prompt. */
function templateLine(refs: BoardRefs, template: ClockTemplate): string {
  const mode = clockMode(template.data);
  const does =
    mode === 'close'
      ? `starts a fresh ${template.data.fresh.role ?? 'agent'} each run`
      : `${mode === 'hibernate' ? 'hibernates' : 'leaves idle'} ${template.data.startsAgent === true ? 'the agent it starts' : 'its agent'} after each run`;
  const by = template.madeBy === null ? 'the user' : (refs.board.agents.find((each) => each.sessionId === template.madeBy)?.name ?? 'an agent now gone');
  return `${JSON.stringify(template.name)}  ${cronWords(template.data.cron)} (${template.data.cron})  ${does}  saved by ${by}\n    ${JSON.stringify(template.data.prompt)}`;
}

/** `schedule template save`: saves a clock, or the fields given, as a template, replacing one of that name. */
export async function saveTemplate(session: BoardSession, options: TemplateOptions): Promise<BoardView> {
  checkTemplate(options);
  const refs = new BoardRefs(await readBoard(session.client));
  let source: { fromClock: string } | { data: Partial<ClockData> };
  if (options.from !== undefined) {
    const object = refs.resolve(options.from, session.caller);
    if (object.kind !== 'item' || object.item.kind !== 'clock') throw new BoardError(`${options.from} is not a schedule: \`agent-board schedule list\` lists them`);
    source = { fromClock: object.item.id };
  } else {
    const mode = (options.after ?? 'idle') as ClockMode;
    source = {
      data: {
        cron: options.cron.trim(),
        prompt: options.prompt.trim(),
        ...withClockMode(mode),
        ...(mode === 'close' ? { fresh: freshOf(options), result: (options.result ?? 'history') as ClockResult } : {}),
      },
    };
  }
  const template = await session.client.call('clockTemplate.save', { token: session.token, name: options.name.trim(), ...source });
  return { text: `Saved ${templateLine(refs, template)}`, json: template };
}

/** `schedule template list`: every saved template. */
export async function listTemplates(session: BoardSession): Promise<BoardView> {
  const refs = new BoardRefs(await readBoard(session.client));
  const templates = await session.client.call('clockTemplate.list', { token: session.token });
  return {
    text: templates.length === 0 ? 'No clock templates. `agent-board schedule template save <name> --from <clock>` saves one.' : templates.map((each) => templateLine(refs, each)).join('\n'),
    json: templates,
  };
}

/** `schedule template remove`: removes a template the caller saved (the user, any). */
export async function removeTemplate(session: BoardSession, ref: string): Promise<BoardView> {
  // The daemon finds it, as it matches names.
  await session.client.call('clockTemplate.remove', { token: session.token, template: ref.trim() });
  return { text: `Removed the template ${JSON.stringify(ref.trim())}.`, json: null };
}
