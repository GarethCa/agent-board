// The memory and queue commands as the CLI and MCP give them (`memory new|ls|read|add|edit|rm|history|restore`, `queue
// new|ls|read|add|edit|rm|history|restore|take|drop|done`): refs and lines turned into the daemon's methods, and what they
// answer with as text and JSON. Every answer names the memory or queue it came from.
import { readFileSync } from 'node:fs';
import { basename, resolve as resolvePath } from 'node:path';
import { agentToken, BoardError, BoardRefs, inZone, readBoard, type BoardSession, type BoardView } from './board-ops.ts';
import {
  MAX_MEMORY_KEY,
  MEMORY_OLD_DAYS,
  type BoardItem,
  type HistoryVersion,
  type MemoryChange,
  type MemoryData,
  type MemoryEntry,
  type MemoryReaders,
  type MemoryView,
  type QueueAddKind,
  type QueueChange,
  type QueueData,
  type QueueJob,
  type StepsWho,
  isQueueWork,
} from './protocol.ts';
import { entryFrom, jobParts, jobsFrom } from './memory-lines.ts';

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
const sizeOf = (bytes: number) => (bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`);
const size = (text: string) => sizeOf(Buffer.byteLength(text));
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** A queue row of each kind, as an answer counts it: "2 tasks", "1 thing to read". */
const ROW_NOUNS: Record<QueueJob['kind'], [string, string]> = {
  task: ['task', 'tasks'],
  request: ['request', 'requests'],
  prompt: ['prompt', 'prompts'],
  info: ['info row', 'info rows'],
  review: ['review', 'reviews'],
  questions: ['set of questions', 'sets of questions'],
  backlog: ['backlog item', 'backlog items'],
  read: ['thing to read', 'things to read'],
};

/** A memory or queue in a line: its ref, title, what it holds, who made it and where it is. */
function cardLine(refs: BoardRefs, item: BoardItem): string {
  const data = item.data as unknown as MemoryData | QueueData;
  const holds = item.kind === 'memory' ? plural(data.count, 'entry', 'entries') : `${data.count} open${'audience' in data && data.audience === 'user' ? '  for the user' : ''}`;
  return `${refs.of('item', item.id)}  “${data.title}”  ${holds}  by ${whoText(refs, data.madeBy)}  ${inZone(refs, item.zoneId)}`;
}

const isStale = (entry: MemoryEntry, now: Date) => now.getTime() - Date.parse(entry.updatedAt) > MEMORY_OLD_DAYS * 86_400_000;
const readersText = (readers: MemoryReaders | undefined) =>
  readers === undefined || readers.last === null ? '' : `read by ${plural(readers.count, 'agent')}, last ${readers.last.name} ${day(readers.last.at)}`;

/** An entry: a fact or note in full; a document by its title and size, or, `whole`, in full. */
function entryText(refs: BoardRefs, entry: MemoryEntry, whole: boolean, now: Date): string {
  const marks = [entry.pinned ? 'pinned' : null, isStale(entry, now) ? 'stale' : null].filter((mark) => mark !== null);
  const head = marks.length === 0 ? '' : `[${marks.join(', ')}] `;
  const by = `${shortId(entry.id)} · ${whoText(refs, entry.changedBy)} · ${day(entry.updatedAt)}`;
  if (entry.file) {
    const { bytes, lines } = entry.listed ?? { bytes: Buffer.byteLength(entry.text), lines: entry.text.split('\n').length };
    const about = `document “${entry.key}” (${sizeOf(bytes)}, ${plural(lines, 'line')}`;
    return whole ? `${head}${about}, ${by}):\n${entry.text}` : `  ${head}${about})\n     ${by}`;
  }
  const value = entry.key === null ? entry.text : `${entry.key}: ${entry.text}`;
  return `  ${head}${indent(value, '    ')}\n     ${by}`;
}

function memoryText(refs: BoardRefs, view: MemoryView, search: string | undefined): string {
  const { item, entries } = view;
  const now = new Date();
  const ref = refs.of('item', item.id);
  const read = readersText(view.readers.memory);
  const head = `${cardLine(refs, item)}${read === '' ? '' : `  ${read}`}`;
  const first = `Nothing remembered yet: \`agent-board memory add ${ref} key: value\` adds the first.`;
  if (entries.length === 0) return `${head}\n  ${search === undefined ? first : `No entry holds “${search}”.`}`;
  const hints = [
    entries.some((entry) => entry.file) ? `A document shows its title alone: \`agent-board memory read ${ref} "<title>"\` prints it whole.` : null,
    entries.some((entry) => isStale(entry, now)) ? `Stale: untouched for ${MEMORY_OLD_DAYS} days. \`agent-board memory confirm ${ref} <entry>\` if one is still true; edit or rm it if not.` : null,
  ].filter((hint) => hint !== null);
  // Facts and notes first, then the documents: those are what an agent reads now, these what it may open.
  const ordered = [...entries.filter((entry) => !entry.file), ...entries.filter((entry) => entry.file)];
  return `${head}${search === undefined ? '' : `  holding “${search}”`}\n${ordered.map((entry) => entryText(refs, entry, false, now)).join('\n')}${hints.map((hint) => `\n  ${hint}`).join('')}`;
}

function jobLine(refs: BoardRefs, job: QueueJob, place: number | null): string {
  const lead = place === null ? '  ✓ ' : isQueueWork(job.kind) ? `  ${place}. ` : '  - ';
  const state = !isQueueWork(job.kind)
    ? 'to read, not to take'
    : job.state === 'taken'
      ? `taken by ${whoText(refs, job.takenBy!)}`
      : job.state === 'done'
        ? `done by ${whoText(refs, job.doneBy!)} ${day(job.doneAt!)}`
        : 'queued';
  const drops = job.drops === 0 ? '' : `  dropped ${job.drops === 1 ? 'once' : `${job.drops} times`}`;
  const link = job.link === null ? '' : `\n     -> ${job.link}`;
  const result = job.result === null ? '' : `\n     result: ${indent(job.result, '     ')}`;
  return `${lead}${shortId(job.id)}  ${job.kind}  ${state}${drops}\n     ${indent(job.text, '     ')}${link}${result}`;
}

function queueText(refs: BoardRefs, item: BoardItem, jobs: QueueJob[]): string {
  const head = cardLine(refs, item);
  const open = jobs.filter((job) => job.state !== 'done');
  const done = jobs.filter((job) => job.state === 'done');
  if (jobs.length === 0) return `${head}\n  No jobs yet.`;
  let place = 0;
  const lines = open.map((job) => jobLine(refs, job, isQueueWork(job.kind) ? ++place : 0));
  if (done.length > 0) {
    const more = done.length - DONE_SHOWN;
    lines.push(`  Done${more > 0 ? `, the last ${DONE_SHOWN} of ${done.length}` : ''}:`, ...done.slice(0, DONE_SHOWN).map((job) => jobLine(refs, job, null)));
  }
  return `${head}\n${lines.join('\n')}`;
}

function historyText<Row extends MemoryEntry | QueueJob>(refs: BoardRefs, item: BoardItem, what: string, versions: HistoryVersion<Row>[]): string {
  const title = (item.data as unknown as MemoryData).title;
  const lines = versions.map((version) => {
    const value = version.value === null ? (version.action === 'confirm' ? '(still true)' : '(removed)') : 'kind' in version.value ? `${version.value.state}: ${version.value.text}` : version.value.text;
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
  const none = 'No memories you can read. `agent-board memory new "<title>"` puts one beside your tile: in a zone, for its agents; on the open board, for all.';
  return { text: items.length === 0 ? none : items.map((item) => cardLine(refs, item)).join('\n'), json: items };
}

/** `memory read`: a memory's entries, or one entry whole (a file in full). */
export async function readMemory(session: BoardSession, ref: string, options: { entry?: string; search?: string }): Promise<BoardView> {
  const token = agentToken(session, 'read a memory');
  const { refs, item } = await cardFor(session, 'memory', ref);
  if (options.entry !== undefined && options.search !== undefined) throw new BoardError('give an entry or a search, not both');
  const view = await session.client.call('board.readMemory', { token, id: item.id, ...(options.search === undefined ? {} : { search: options.search }), ...(options.entry === undefined ? {} : { entry: options.entry }) });
  if (options.entry === undefined) return { text: memoryText(refs, view, options.search), json: view };
  const entry = view.entries[0]!;
  const read = readersText(view.readers.entries[entry.id]);
  return { text: `${cardLine(refs, view.item)}\n${entryText(refs, entry, true, new Date())}${read === '' ? '' : `\n  ${read}`}`, json: entry };
}

/**
 * What `memory add|edit|rm|restore|confirm` does, as typed; `path` a file to keep whole, from `cwd`, and `document` the
 * title to keep `text` whole under, as a document.
 */
export type MemoryUpdate =
  | { action: 'add'; text?: string; key?: string; note?: boolean; path?: string; document?: string }
  | { action: 'edit'; entry: string; text?: string; key?: string; note?: boolean; pinned?: boolean }
  | { action: 'remove'; entry: string }
  | { action: 'restore'; entry: string; version: number }
  | { action: 'confirm'; entry: string };

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

/** `memory add|edit|rm|restore|confirm`: changes the memory `ref` names, and says what it did. */
export async function updateMemory(session: BoardSession, ref: string, update: MemoryUpdate, cwd: string): Promise<BoardView> {
  const token = agentToken(session, 'change a memory');
  const { refs, item } = await cardFor(session, 'memory', ref);
  let change: MemoryChange;
  switch (update.action) {
    case 'add': {
      if (update.document !== undefined) {
        if (update.path !== undefined || update.key !== undefined || update.note === true) throw new BoardError('a document is its title and text: leave out the file, key and no-key');
        if (update.text === undefined || update.text.trim() === '') throw new BoardError('give the document its text');
        const title = update.document.trim();
        if (title === '' || title.length > MAX_MEMORY_KEY || /[\r\n]/.test(title)) throw new BoardError(`a document's title is one line of 1 to ${MAX_MEMORY_KEY} characters`);
        change = { action: 'add', key: title, text: update.text, file: true };
      } else if (update.path !== undefined) {
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
    // The version before this one; a confirm is none.
    const before = (await session.client.call('board.memoryHistory', { token, id: item.id, entry: entry.id })).slice(1).find((version) => version.action !== 'confirm');
    if (before !== undefined && before.value !== null) {
      const was = before.value.file ? `a document of ${size(before.value.text)}` : `“${before.value.text.length > 80 ? `${before.value.text.slice(0, 80)}…` : before.value.text}”`;
      replaced = `Replaced ${name} in ${title}: it was ${was}. \`agent-board memory restore ${refs.of('item', item.id)} ${name.includes(' ') ? `"${name}"` : name} v${before.version}\` puts it back; --no-key keeps text as a note instead.`;
    }
  }
  const said = {
    add: replaced || `Remembered ${name} in ${title}.`,
    edit: `Changed ${name} in ${title}.`,
    remove: `Removed ${name} from ${title}: \`memory history\` and \`memory restore\` can put it back.`,
    restore: `Put back ${name} in ${title}.`,
    confirm: `Confirmed ${name} in ${title}: still true as of today.`,
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
  const none = 'No queues you can read. `agent-board queue new "<title>"` puts one beside your tile: in a zone, for its agents; on the open board, for all.';
  return { text: items.length === 0 ? none : items.map((item) => cardLine(refs, item)).join('\n'), json: items };
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
  /** With `body`, `text` is one job's headline (a " -> link" at its end its link); without, each line of it is a job. */
  | { action: 'add'; text: string; body?: string; kind?: QueueAddKind; front?: boolean; link?: string }
  | { action: 'edit'; job: string; text?: string; link?: string }
  | { action: 'remove' | 'drop'; job: string }
  /** `result`: what was done, for whoever reads the queue next. */
  | { action: 'done'; job: string; result?: string }
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
  if (update.action === 'add' && update.body !== undefined) {
    // The headline is read as a line is: its " -> link" is its link, unless --link gives one.
    const lines = jobsFrom(update.text);
    if (lines.length !== 1) throw new BoardError('with a body, give one headline: the body holds the rest');
    const link = update.link ?? lines[0]!.link;
    const { item: changed, job } = await call({
      action: 'add',
      ...(update.kind === undefined ? {} : { kind: update.kind }),
      headline: lines[0]!.text,
      body: update.body,
      ...(link === null ? {} : { link }),
      front: update.front === true,
    });
    return { text: `Queued ${shortId(job!.id)} ${update.front === true ? 'at the front of' : 'on'} ${title()}.\n${jobLine(refs, job!, 1)}`, json: { item: changed, jobs: [job!] } };
  }
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
        const result = await call({ action: 'add', ...(update.kind === undefined ? {} : { kind: update.kind }), text: line.text, link: update.link ?? line.link, front: update.front === true });
        changed = result.item;
        added.push(result.job!);
      } catch (error) {
        if (added.length === 0) throw error;
        const went = added.map((job) => `${shortId(job.id)} ${jobParts(job.text).headline}`).join('; ');
        throw new BoardError(`queued ${plural(added.length, 'line')} on ${title()} (${went}), then: ${(error as Error).message}`);
      }
    }
    const what = plural(added.length, ...ROW_NOUNS[added[0]!.kind]);
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
  const left = update.action === 'done' ? await waiting(session, token, item) : '';
  const said = {
    edit: `Changed ${name} on ${title()}.`,
    remove: `Removed ${name} from ${title()}: \`queue history\` and \`queue restore\` can put it back.`,
    restore: `Put back ${name} on ${title()}.`,
    take: `You have job ${name} from ${title()}: \`queue done\` once it is done, or \`queue drop\` to put it back. If your session ends first it goes back on its own.`,
    drop: `Put ${name} back at the front of ${title()}.`,
    done: left === '' ? `Done: ${name} on ${title()}.` : `Done: ${name} on ${title()}. ${left}`,
  }[update.action];
  return { text: job === null ? said : `${said}\n${jobLine(refs, job, job.state === 'done' ? null : 1)}`, json: { item: changed, job } };
}

/**
 * After a job is done: how many jobs wait (info aside), and the next one's headline. The job is done already, so a
 * read that fails says nothing rather than an error the agent could take for a failed `done` and retry.
 */
async function waiting(session: BoardSession, token: string, item: BoardItem): Promise<string> {
  let jobs;
  try {
    ({ jobs } = await session.client.call('board.readQueue', { token, id: item.id }));
  } catch {
    return '';
  }
  const queued = jobs.filter((job) => isQueueWork(job.kind) && job.state === 'queued');
  if (queued.length === 0) return 'No job waiting.';
  const next = queued[0]!;
  return `${plural(queued.length, 'job')} waiting; next: “${jobParts(next.text).headline}” (${shortId(next.id)}).`;
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
