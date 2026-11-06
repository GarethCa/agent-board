// The memory and queue commands as the CLI and MCP give them (`memory new|ls|read|add|edit|rm|history|restore`, `queue
// new|ls|read|add|edit|rm|history|restore|take|drop|done`): refs and lines turned into the daemon's methods, and what they
// answer with as text and JSON. Every answer names the memory or queue it came from.
import { readFileSync } from 'node:fs';
import { basename, resolve as resolvePath } from 'node:path';
import { agentToken, BoardError, BoardRefs, inZone, readBoard, type BoardSession, type BoardView } from './board-ops.ts';
import {
  MEMORY_OLD_DAYS,
  type BoardItem,
  type HistoryVersion,
  type MemoryChange,
  type MemoryData,
  type MemoryEntry,
  type QueueChange,
  type QueueData,
  type QueueJob,
  type QueueRowKind,
  type StepsWho,
} from './protocol.ts';
import { entryFrom, jobsFrom } from './memory-lines.ts';

/** How many done jobs `queue read` shows, newest first. */
const DONE_SHOWN = 10;

const whoText = (refs: BoardRefs, who: StepsWho) => {
  if (who.kind === 'user') return 'the user';
  const ref = refs.board.agents.some((agent) => agent.sessionId === who.sessionId) ? refs.of('agent', who.sessionId) : `agent:${who.sessionId.slice(0, 8)}`;
  return `${ref} ${who.name}`;
};
const shortId = (id: string) => `#${id.slice(0, 8)}`;
const day = (at: string) => at.slice(0, 10);
const indent = (text: string, by: string) => text.replace(/\n/g, `\n${by}`);
const size = (text: string) => {
  const bytes = Buffer.byteLength(text);
  return bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`;
};
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A memory or queue in a line: its ref, title, what it holds, who made it and where it is. */
function cardLine(refs: BoardRefs, item: BoardItem): string {
  const data = item.data as unknown as MemoryData | QueueData;
  const holds = item.kind === 'memory' ? plural(data.count, 'entry', 'entries') : `${data.count} open${'audience' in data && data.audience === 'user' ? '  for the user' : ''}`;
  return `${refs.of('item', item.id)}  “${data.title}”  ${holds}  by ${whoText(refs, data.madeBy)}  ${inZone(refs, item.zoneId)}`;
}

function entryText(refs: BoardRefs, entry: MemoryEntry, whole: boolean, now: Date): string {
  const old = now.getTime() - Date.parse(entry.updatedAt) > MEMORY_OLD_DAYS * 86_400_000;
  const marks = [entry.pinned ? 'pinned' : null, old ? 'old' : null].filter((mark) => mark !== null);
  const head = marks.length === 0 ? '' : `[${marks.join(', ')}] `;
  const by = `${shortId(entry.id)} · ${whoText(refs, entry.changedBy)} · ${day(entry.updatedAt)}`;
  if (entry.file) {
    if (whole) return `file ${entry.key} (${size(entry.text)}, ${by}):\n${entry.text}`;
    const lines = entry.text.split('\n');
    const preview = lines.slice(0, 3).join('\n    ');
    return `  ${head}file ${entry.key} (${size(entry.text)}, ${plural(lines.length, 'line')})\n    ${preview}${lines.length > 3 ? '\n    …' : ''}\n     ${by}`;
  }
  const value = entry.key === null ? entry.text : `${entry.key}: ${entry.text}`;
  return `  ${head}${indent(value, '    ')}\n     ${by}`;
}

function memoryText(refs: BoardRefs, item: BoardItem, entries: MemoryEntry[], search: string | undefined): string {
  const now = new Date();
  const head = cardLine(refs, item);
  if (entries.length === 0) return `${head}\n  ${search === undefined ? 'Nothing remembered yet.' : `No entry holds “${search}”.`}`;
  const files = entries.some((entry) => entry.file) ? `\n  A file shows its first lines: \`agent-board memory read ${refs.of('item', item.id)} <name>\` prints it whole.` : '';
  return `${head}${search === undefined ? '' : `  holding “${search}”`}\n${entries.map((entry) => entryText(refs, entry, false, now)).join('\n')}${files}`;
}

function jobLine(refs: BoardRefs, job: QueueJob, place: number | null): string {
  const lead = place === null ? '  ✓ ' : job.kind === 'note' ? '  - ' : `  ${place}. `;
  const state =
    job.kind === 'note'
      ? 'note'
      : job.state === 'taken'
        ? `taken by ${whoText(refs, job.takenBy!)}`
        : job.state === 'done'
          ? `done by ${whoText(refs, job.doneBy!)} ${day(job.doneAt!)}`
          : 'queued';
  const drops = job.drops === 0 ? '' : `  dropped ${job.drops === 1 ? 'once' : `${job.drops} times`}`;
  return `${lead}${shortId(job.id)}  ${state}${drops}\n     ${indent(job.text, '     ')}${job.link === null ? '' : `\n     -> ${job.link}`}`;
}

function queueText(refs: BoardRefs, item: BoardItem, jobs: QueueJob[]): string {
  const head = cardLine(refs, item);
  const open = jobs.filter((job) => job.state !== 'done');
  const done = jobs.filter((job) => job.state === 'done');
  if (jobs.length === 0) return `${head}\n  No jobs yet.`;
  let place = 0;
  const lines = open.map((job) => jobLine(refs, job, job.kind === 'job' ? ++place : 0));
  if (done.length > 0) {
    const more = done.length - DONE_SHOWN;
    lines.push(`  Done${more > 0 ? `, the last ${DONE_SHOWN} of ${done.length}` : ''}:`, ...done.slice(0, DONE_SHOWN).map((job) => jobLine(refs, job, null)));
  }
  return `${head}\n${lines.join('\n')}`;
}

function historyText<Row extends MemoryEntry | QueueJob>(refs: BoardRefs, item: BoardItem, what: string, versions: HistoryVersion<Row>[]): string {
  const title = (item.data as unknown as MemoryData).title;
  const lines = versions.map((version) => {
    const value = version.value === null ? '(removed)' : 'kind' in version.value ? `${version.value.state}: ${version.value.text}` : version.value.text;
    const shown = value.length > 200 ? `${value.slice(0, 200)}…` : value;
    return `  v${version.version}  ${version.action}  by ${whoText(refs, version.by)}  ${version.at.slice(0, 16).replace('T', ' ')}\n     ${indent(shown, '     ')}`;
  });
  const restore = `\`agent-board ${item.kind} restore ${refs.of('item', item.id)} ${what} <version>\` puts one back.`;
  return `History of ${what} in “${title}” (${refs.of('item', item.id)}), newest first:\n${lines.join('\n')}\n${restore}`;
}

/** The memory or queue `ref` names: a ref, or its title (any case). */
async function cardFor(session: BoardSession, kind: 'memory' | 'queue', ref: string): Promise<{ refs: BoardRefs; item: BoardItem }> {
  const refs = new BoardRefs(await readBoard(session.client));
  const ofKind = refs.board.items.filter((item) => item.kind === kind);
  const byTitle = ofKind.filter((item) => (item.data as unknown as MemoryData).title.toLowerCase() === ref.trim().toLowerCase());
  if (byTitle.length === 1) return { refs, item: byTitle[0]! };
  let object;
  try {
    object = refs.resolve(ref, session.caller);
  } catch (error) {
    if (byTitle.length > 1) throw new BoardError(`${byTitle.length} ${kind === 'memory' ? 'memories' : 'queues'} are called “${ref}”: give one's ref (${byTitle.map((item) => refs.of('item', item.id)).join(', ')})`);
    throw error;
  }
  if (object.kind !== 'item' || object.item.kind !== kind) throw new BoardError(`${ref} is not a ${kind}: \`agent-board ${kind} ls\` lists them`);
  return { refs, item: object.item };
}

// ---- memory ----

/** `memory new`: a memory beside the caller's tile. */
export async function newMemory(session: BoardSession, title: string): Promise<BoardView> {
  const item = await session.client.call('board.newMemory', { token: agentToken(session, 'make a memory'), title });
  const refs = new BoardRefs(await readBoard(session.client));
  return { text: `Put ${cardLine(refs, item)} beside your tile. \`agent-board memory add ${refs.of('item', item.id)} key: value\` remembers something.`, json: item };
}

/** `memory ls`: the memories the caller reads. */
export async function listMemories(session: BoardSession): Promise<BoardView> {
  const items = await session.client.call('board.listMemories', { token: agentToken(session, 'list memories') });
  const refs = new BoardRefs(await readBoard(session.client));
  return { text: items.length === 0 ? 'No memories you can read.' : items.map((item) => cardLine(refs, item)).join('\n'), json: items };
}

/** `memory read`: a memory's entries, or one entry whole (a file in full). */
export async function readMemory(session: BoardSession, ref: string, options: { entry?: string; search?: string }): Promise<BoardView> {
  const token = agentToken(session, 'read a memory');
  const { refs, item } = await cardFor(session, 'memory', ref);
  if (options.entry !== undefined && options.search !== undefined) throw new BoardError('give an entry or a search, not both');
  const view = await session.client.call('board.readMemory', { token, id: item.id, ...(options.search === undefined ? {} : { search: options.search }), ...(options.entry === undefined ? {} : { entry: options.entry }) });
  if (options.entry === undefined) return { text: memoryText(refs, view.item, view.entries, options.search), json: view };
  const entry = view.entries[0]!;
  return { text: `${cardLine(refs, view.item)}\n${entryText(refs, entry, true, new Date())}`, json: entry };
}

/** What `memory add|edit|rm|restore` does, as typed; `path` a file to keep whole, from `cwd`. */
export type MemoryUpdate =
  | { action: 'add'; text?: string; key?: string; note?: boolean; path?: string }
  | { action: 'edit'; entry: string; text?: string; key?: string; note?: boolean; pinned?: boolean }
  | { action: 'remove'; entry: string }
  | { action: 'restore'; entry: string; version: number };

/** The text file at `path`, from `cwd`; refused for one that isn't text (a NUL, or bytes that aren't UTF-8). */
const readFile = (path: string, cwd: string) => {
  let text: string;
  try {
    text = readFileSync(resolvePath(cwd, path), 'utf8');
  } catch (error) {
    throw new BoardError(`can't read ${path}: ${(error as Error).message}`);
  }
  if (/[\0\uFFFD]/.test(text)) throw new BoardError(`${path} isn't a text file: a memory keeps only text files`);
  return text;
};

/** `memory add|edit|rm|restore`: changes the memory `ref` names, and says what it did. */
export async function updateMemory(session: BoardSession, ref: string, update: MemoryUpdate, cwd: string): Promise<BoardView> {
  const token = agentToken(session, 'change a memory');
  const { refs, item } = await cardFor(session, 'memory', ref);
  let change: MemoryChange;
  switch (update.action) {
    case 'add': {
      if (update.path !== undefined) {
        if (update.text !== undefined && update.text.trim() !== '') throw new BoardError('give the text or a file, not both');
        change = { action: 'add', key: update.key?.trim() || basename(update.path), text: readFile(update.path, cwd), file: true };
      } else {
        if (update.text === undefined || update.text.trim() === '') throw new BoardError('give the text to remember: `key: value`, or a note');
        change = { action: 'add', ...entryFrom(update.text, update) };
      }
      break;
    }
    case 'edit':
      change = { action: 'edit', entry: update.entry, ...(update.text === undefined ? {} : { text: update.text }), ...(update.note === true ? { key: null } : update.key === undefined ? {} : { key: update.key }), ...(update.pinned === undefined ? {} : { pinned: update.pinned }) };
      break;
    default:
      change = update;
  }
  const { item: changed, entry } = await session.client.call('board.changeMemory', { token, id: item.id, change });
  const title = `“${(changed.data as unknown as MemoryData).title}” (${refs.of('item', changed.id)})`;
  const name = entry === null ? update.action === 'add' ? '' : (update as { entry: string }).entry : entry.key ?? shortId(entry.id);
  // A key set again replaces its value: say what it was, and how to put it back.
  let replaced = '';
  if (update.action === 'add' && entry !== null && entry.key !== null) {
    const [, before] = await session.client.call('board.memoryHistory', { token, id: item.id, entry: entry.id });
    if (before !== undefined && before.value !== null) {
      const was = before.value.file ? `a file of ${size(before.value.text)}` : `“${before.value.text.length > 80 ? `${before.value.text.slice(0, 80)}…` : before.value.text}”`;
      replaced = `Replaced ${name} in ${title}: it was ${was}. \`agent-board memory restore ${refs.of('item', item.id)} ${name.includes(' ') ? `"${name}"` : name} v${before.version}\` puts it back; --no-key keeps text as a note instead.`;
    }
  }
  const said = {
    add: replaced || `Remembered ${name} in ${title}.`,
    edit: `Changed ${name} in ${title}.`,
    remove: `Removed ${name} from ${title}: \`memory history\` and \`memory restore\` can put it back.`,
    restore: `Put back ${name} in ${title}.`,
  }[update.action];
  return { text: entry === null ? said : `${said}\n${entryText(refs, entry, false, new Date())}`, json: { item: changed, entry } };
}

/** `memory history`: an entry's versions, newest first, removed ones too. */
export async function memoryHistory(session: BoardSession, ref: string, entry: string): Promise<BoardView> {
  const token = agentToken(session, 'read a memory');
  const { refs, item } = await cardFor(session, 'memory', ref);
  const versions = await session.client.call('board.memoryHistory', { token, id: item.id, entry });
  return { text: historyText(refs, item, entry, versions), json: versions };
}

// ---- queue ----

/** `queue new`: a queue beside the caller's tile, for agents or, with `forUser`, the user. */
export async function newQueue(session: BoardSession, title: string, forUser: boolean): Promise<BoardView> {
  const item = await session.client.call('board.newQueue', { token: agentToken(session, 'make a queue'), title, audience: forUser ? 'user' : 'agents' });
  const refs = new BoardRefs(await readBoard(session.client));
  return { text: `Put ${cardLine(refs, item)} beside your tile. \`agent-board queue add ${refs.of('item', item.id)} <job>\` queues a job.`, json: item };
}

/** `queue ls`: the queues the caller reads. */
export async function listQueues(session: BoardSession): Promise<BoardView> {
  const items = await session.client.call('board.listQueues', { token: agentToken(session, 'list queues') });
  const refs = new BoardRefs(await readBoard(session.client));
  return { text: items.length === 0 ? 'No queues you can read.' : items.map((item) => cardLine(refs, item)).join('\n'), json: items };
}

/** `queue read`: a queue's jobs and notes in order, then those done. */
export async function readQueue(session: BoardSession, ref: string): Promise<BoardView> {
  const token = agentToken(session, 'read a queue');
  const { refs, item } = await cardFor(session, 'queue', ref);
  const view = await session.client.call('board.readQueue', { token, id: item.id });
  return { text: queueText(refs, view.item, view.jobs), json: view };
}

/** What `queue add|edit|rm|restore|take|drop|done` does, as typed. */
export type QueueUpdate =
  | { action: 'add'; text: string; kind?: QueueRowKind; front?: boolean; link?: string }
  | { action: 'edit'; job: string; text?: string; link?: string }
  | { action: 'remove' | 'drop' | 'done'; job: string }
  | { action: 'take'; job?: string }
  | { action: 'restore'; job: string; version: number }
  /** `to`: the open job to put it just before, `top` or `last`. */
  | { action: 'move'; job: string; to: string }
  | { action: 'drain'; on: boolean; most?: number };

/** `queue add|edit|…`: changes the queue `ref` names, and says what it did. */
export async function updateQueue(session: BoardSession, ref: string, update: QueueUpdate): Promise<BoardView> {
  const token = agentToken(session, 'change a queue');
  const { refs, item } = await cardFor(session, 'queue', ref);
  const call = (change: QueueChange) => session.client.call('board.changeQueue', { token, id: item.id, change });
  const title = () => `“${(item.data as unknown as QueueData).title}” (${refs.of('item', item.id)})`;
  if (update.action === 'add') {
    const lines = jobsFrom(update.text);
    if (lines.length === 0) throw new BoardError('give the jobs to queue, one a line');
    if (update.link !== undefined && lines.length > 1) throw new BoardError('--link is for one job: put " -> link" at the end of each line instead');
    // Put at the front in the order given: the last line first.
    const ordered = update.front === true ? [...lines].reverse() : lines;
    const added: QueueJob[] = [];
    let changed = item;
    for (const line of ordered) {
      try {
        const result = await call({ action: 'add', kind: update.kind ?? 'job', text: line.text, link: update.link ?? line.link, front: update.front === true });
        changed = result.item;
        added.push(result.job!);
      } catch (error) {
        if (added.length === 0) throw error;
        const went = added.map((job) => `${shortId(job.id)} ${job.text.split('\n')[0]!.slice(0, 60)}`).join('; ');
        throw new BoardError(`queued ${plural(added.length, 'line')} on ${title()} (${went}), then: ${(error as Error).message}`);
      }
    }
    const what = plural(added.length, update.kind === 'note' ? 'note' : 'job');
    return { text: `Queued ${what} ${update.front === true ? 'at the front of' : 'on'} ${title()}: ${added.map((job) => shortId(job.id)).join(', ')}.`, json: { item: changed, jobs: added } };
  }
  if (update.action === 'move') return moveJob(session, token, refs, item, title(), update);
  if (update.action === 'drain') {
    const changed = await session.client.call('board.drainQueue', { token, id: item.id, on: update.on, ...(update.most === undefined ? {} : { most: update.most }) });
    const most = (changed.data as unknown as QueueData).drain?.most;
    return {
      text: update.on ? `The board now starts agents for ${title()}: at most ${String(most)} at once, each taking the next waiting job, closed once it is done.` : `The board starts no more agents for ${title()}.`,
      json: { item: changed },
    };
  }
  const { item: changed, job } = await call(update.action === 'edit' ? { action: 'edit', job: update.job, ...(update.text === undefined ? {} : { text: update.text }), ...(update.link === undefined ? {} : { link: update.link === '' ? null : update.link }) } : update);
  const name = job === null ? (update as { job: string }).job : shortId(job.id);
  const said = {
    edit: `Changed ${name} on ${title()}.`,
    remove: `Removed ${name} from ${title()}: \`queue history\` and \`queue restore\` can put it back.`,
    restore: `Put back ${name} on ${title()}.`,
    take: `You have job ${name} from ${title()}: \`queue done\` once it is done, or \`queue drop\` to put it back. If your session ends first it goes back on its own.`,
    drop: `Put ${name} back at the front of ${title()}.`,
    done: `Done: ${name} on ${title()}.`,
  }[update.action];
  return { text: job === null ? said : `${said}\n${jobLine(refs, job, job.state === 'done' ? null : 1)}`, json: { item: changed, job } };
}

/** `queue move`: a job (or note) put just before another open one, at the top, or last. */
async function moveJob(session: BoardSession, token: string, refs: BoardRefs, item: BoardItem, title: string, update: { job: string; to: string }): Promise<BoardView> {
  let before: string | null = update.to === 'last' ? null : update.to;
  if (update.to === 'top') {
    const { jobs } = await session.client.call('board.readQueue', { token, id: item.id });
    const first = jobs.find((each) => each.state !== 'done');
    if (first === undefined) throw new BoardError(`${title} has no open job to move`);
    before = first.id;
  }
  const { item: changed, job } = await session.client.call('board.changeQueue', { token, id: item.id, change: { action: 'move', job: update.job, before } });
  const where = update.to === 'top' ? 'to the top of' : update.to === 'last' ? 'to the end of' : `before ${update.to} on`;
  return { text: `Moved ${shortId(job!.id)} ${where} ${title}.\n${jobLine(refs, job!, 1)}`, json: { item: changed, job } };
}

/** `queue history`: a job's versions, newest first. */
export async function queueHistory(session: BoardSession, ref: string, job: string): Promise<BoardView> {
  const token = agentToken(session, 'read a queue');
  const { refs, item } = await cardFor(session, 'queue', ref);
  const versions = await session.client.call('board.queueHistory', { token, id: item.id, job });
  return { text: historyText(refs, item, job, versions), json: versions };
}
