// The queue commands as the CLI and MCP give them (`queue new|ls|read|add|edit|rm|history|restore|take|drop|done`): refs
// and lines turned into the daemon's methods, and what they answer with as text and JSON. Every answer names the queue it
// came from.
import { plural } from './text-words.ts';
import { agentToken, BoardError, BoardRefs, faceOf, itemPlace, readCards, type BoardSession, type BoardView, type ReadFace } from './board-ops.ts';
import {
  type BoardItem,
  type HistoryVersion,
  QUEUE_ADD_KINDS,
  QUEUE_ROW_KINDS,
  type QueueAddKind,
  type QueueChange,
  type QueueData,
  type QueueJob,
  type StepsWho,
  isPutOff,
  isQueueWork,
  QUEUE_LATER,
} from './protocol.ts';
import { jobParts, jobsFrom, rowNamed } from './queue-lines.ts';


const whoText = (refs: BoardRefs, who: StepsWho) => {
  if (who.kind === 'user') return 'the user';
  const ref = refs.board.agents.some((agent) => agent.sessionId === who.sessionId) ? refs.of('agent', who.sessionId) : `agent:${who.sessionId.slice(0, 8)}`;
  return `${ref} ${who.name}`;
};
const shortId = (id: string) => `#${id.slice(0, 8)}`;
const day = (at: string) => at.slice(0, 10);
const indent = (text: string, by: string) => text.replace(/\n/g, `\n${by}`);
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

/** A queue in a line: its ref, title, what it holds, who made it and where it is. */
function cardLine(refs: BoardRefs, item: BoardItem): string {
  const data = item.data as unknown as QueueData;
  const holds = `${data.count} open${data.audience === 'user' ? '  for the user' : ''}`;
  return `${refs.of('item', item.id)}  “${data.title}”  ${holds}  by ${whoText(refs, data.madeBy)}  ${itemPlace(refs, item)}`;
}

/**
 * A job as a row: its place, id, kind and state, then its text, link and result. `short`, its headline alone, marked
 * `[more]` when it has a body, and no result: as `queue read` lists a queue.
 */
function jobLine(refs: BoardRefs, job: QueueJob, place: number | null, short = false): string {
  const lead = place === null ? '  ✓ ' : isQueueWork(job.kind) ? `  ${place}. ` : '  - ';
  const state = !isQueueWork(job.kind)
    ? 'to read, not to take'
    : job.state === 'taken'
      ? `taken by ${whoText(refs, job.takenBy!)}`
      : job.state === 'done'
        ? `done by ${whoText(refs, job.doneBy!)} ${day(job.doneAt!)}`
        : job.hiddenUntil === QUEUE_LATER
          ? 'later (no take starts it until moved up)'
          : job.hiddenUntil !== null && isPutOff(job, new Date().toISOString())
            ? `put off until ${job.hiddenUntil.slice(0, 16).replace('T', ' ')}`
            : 'queued';
  const drops = job.drops === 0 ? '' : `  dropped ${job.drops === 1 ? 'once' : `${job.drops} times`}`;
  const link = job.link === null ? '' : `\n     -> ${job.link}`;
  const result = job.result === null || short ? '' : `\n     result: ${indent(job.result, '     ')}`;
  const parts = jobParts(job.text);
  const text = short ? `${parts.headline}${parts.body === '' ? '' : '  [more]'}` : indent(job.text, '     ');
  return `${lead}${shortId(job.id)}  ${job.kind}  ${state}${drops}\n     ${text}${link}${result}`;
}

/** How to read one job of the queue `ref` whole, on `face`. */
function readOneHint(ref: string, face: ReadFace): string {
  return face === 'mcp' ? '`queue_read` with `job` and `whole: true`' : `\`agent-board queue read ${ref} <job>\``;
}

/** A queue as `queue read` gives it: its open rows in order, each its headline, then how many are done and how to read them. */
function queueText(refs: BoardRefs, item: BoardItem, jobs: QueueJob[], face: ReadFace): string {
  const head = cardLine(refs, item);
  const ref = refs.of('item', item.id);
  const open = jobs.filter((job) => job.state !== 'done');
  const done = jobs.filter((job) => job.state === 'done');
  if (jobs.length === 0) return `${head}\n  No jobs yet.`;
  let place = 0;
  const lines = open.length === 0 ? ['  No open jobs.'] : open.map((job) => jobLine(refs, job, isQueueWork(job.kind) ? ++place : 0, true));
  if (open.some((job) => jobParts(job.text).body !== '')) lines.push(`  ${readOneHint(ref, face)} shows one whole.`);
  if (done.length > 0) {
    const hint = face === 'mcp' ? `\`queue_read\` with \`done: true\`` : `\`agent-board queue read ${ref} --done\``;
    lines.push(`  ${plural(done.length, 'job')} done: ${hint} lists them.`);
  }
  return `${head}\n${lines.join('\n')}`;
}

/** A queue's done jobs, newest first: each its headline and what its finisher said was done. */
function doneText(refs: BoardRefs, item: BoardItem, done: QueueJob[], face: ReadFace): string {
  const title = (item.data as unknown as QueueData).title;
  if (done.length === 0) return `No job is done yet on “${title}” (${refs.of('item', item.id)}).`;
  const lines = done.map((job) => {
    const row = jobLine(refs, job, null, true);
    return job.result === null ? row : `${row}\n     result: ${indent(job.result, '     ')}`;
  });
  const more = done.some((job) => jobParts(job.text).body !== '') ? `\n  ${readOneHint(refs.of('item', item.id), face)} shows one whole.` : '';
  return `Done on “${title}” (${refs.of('item', item.id)}), newest first:\n${lines.join('\n')}${more}`;
}

function historyText(refs: BoardRefs, item: BoardItem, what: string, versions: HistoryVersion<QueueJob>[]): string {
  const title = (item.data as unknown as QueueData).title;
  const lines = versions.map((version) => {
    const value = version.value === null ? '(removed)' : `${version.value.state}: ${version.value.text}`;
    const shown = value.length > 200 ? `${value.slice(0, 200)}…` : value;
    return `  v${version.version}  ${version.action}  by ${whoText(refs, version.by)}  ${version.at.slice(0, 16).replace('T', ' ')}\n     ${indent(shown, '     ')}`;
  });
  const restore = `\`agent-board ${item.kind} restore ${refs.of('item', item.id)} ${what} <version>\` puts one back.`;
  return `History of ${what} in “${title}” (${refs.of('item', item.id)}), newest first:\n${lines.join('\n')}\n${restore}`;
}

/** The queue `ref` names: a ref, or its title (any case). */
async function cardFor(session: BoardSession, kind: 'queue', ref: string): Promise<{ refs: BoardRefs; item: BoardItem }> {
  const refs = new BoardRefs(await readCards(session));
  const ofKind = refs.board.items.filter((item) => item.kind === kind);
  const byTitle = ofKind.filter((item) => (item.data as unknown as QueueData).title.toLowerCase() === ref.trim().toLowerCase());
  if (byTitle.length === 1) return { refs, item: byTitle[0]! };
  let object;
  try {
    object = refs.resolve(ref, session.caller);
  } catch (error) {
    if (byTitle.length > 1) throw new BoardError(`${byTitle.length} queues are called “${ref}”: give one's ref (${byTitle.map((item) => refs.of('item', item.id)).join(', ')})`);
    throw error;
  }
  if (object.kind !== 'item' || object.item.kind !== kind) throw new BoardError(`${ref} is not a ${kind}: \`agent-board ${kind} ls\` lists them`);
  return { refs, item: object.item };
}

/** A version to put back, as history lists it: a whole number from 1, or its digits as typed (`v3` or `3`). */
export function versionNumber(value: unknown): number {
  const digits = typeof value === 'string' ? /^v?(\d+)$/.exec(value)?.[1] : undefined;
  const version = digits === undefined ? value : Number(digits);
  if (!Number.isInteger(version) || (version as number) < 1) throw new BoardError('give the version to put back, as history lists it');
  return version as number;
}

// ---- queue ----

/** `queue new`: a queue beside the caller's tile, for agents or, with `forUser`, the user. */
export async function newQueue(session: BoardSession, title: string, forUser: boolean): Promise<BoardView> {
  const item = await session.client.call('board.newQueue', { token: agentToken(session, 'make a queue'), title, audience: forUser ? 'user' : 'agents' });
  const refs = new BoardRefs(await readCards(session));
  const add = faceOf(session) === 'mcp' ? '`queue_update` with `action: "add"`' : `\`agent-board queue add ${refs.of('item', item.id)} <job>\``;
  return { text: `Put ${cardLine(refs, item)} beside your tile. ${add} queues a job.`, json: item };
}

/** `queue ls`: the queues the caller reads. */
export async function listQueues(session: BoardSession): Promise<BoardView> {
  const items = await session.client.call('board.listQueues', { token: agentToken(session, 'list queues') });
  const refs = new BoardRefs(await readCards(session));
  const make = faceOf(session) === 'mcp' ? '`queue_new` with `title`' : '`agent-board queue new "<title>"`';
  const none = `No queues you can read. ${make} puts one beside your tile: in a zone, for its agents; on the open board, for all.`;
  return { text: items.length === 0 ? none : items.map((item) => cardLine(refs, item)).join('\n'), json: items };
}

/** What `queue read` shows besides its open rows: one job whole, or the done jobs. */
export type QueueReadOf = { job: string } | { done: true };

/**
 * `queue read`: a queue's open jobs and notes in order, each its headline, and a count of those done; with `of`, one
 * job whole (its text, link and result), or the done jobs, newest first.
 */
export async function readQueue(session: BoardSession, ref: string, of?: QueueReadOf): Promise<BoardView> {
  const token = agentToken(session, 'read a queue');
  const { refs, item } = await cardFor(session, 'queue', ref);
  const view = await session.client.call('board.readQueue', { token, id: item.id });
  if (of === undefined) return { text: queueText(refs, view.item, view.jobs, faceOf(session)), json: view };
  if ('done' in of) {
    const done = view.jobs.filter((job) => job.state === 'done');
    return { text: doneText(refs, view.item, done, faceOf(session)), json: { item: view.item, jobs: done } };
  }
  const job = jobNamed(view.jobs, of.job, (view.item.data as unknown as QueueData).title);
  const open = view.jobs.filter((each) => each.state !== 'done' && isQueueWork(each.kind));
  const place = job.state === 'done' ? null : isQueueWork(job.kind) ? open.indexOf(job) + 1 : 0;
  return { text: `From “${(view.item.data as unknown as QueueData).title}” (${refs.of('item', item.id)}):\n${jobLine(refs, job, place)}`, json: { item: view.item, job } };
}

/** The job `said` names, by its #id or the start of it (at least 4 characters), as the daemon reads one. */
function jobNamed(jobs: QueueJob[], said: string, title: string): QueueJob {
  const { ref, row, starts } = rowNamed(jobs, said);
  if (ref === '') throw new BoardError('give the job: its #id');
  if (starts > 1) throw new BoardError(`#${ref} names ${starts} jobs: give more of its id`);
  if (row === undefined) throw new BoardError(`“${title}” has no job ${said.trim()}`);
  return row;
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
  /** `later` marks a waiting job Later, which no take without a job starts until `up` moves it up. */
  | { action: 'later'; job: string }
  | { action: 'up'; job: string }
  | { action: 'drain'; on: boolean; most?: number };

/** What a queue update is given, by the CLI or the MCP, before it is read. */
export interface QueueUpdateInput {
  action: string | undefined;
  job?: string;
  text?: string;
  /** For add: one job's detail, with `text` its headline. */
  body?: string;
  kind?: string;
  front?: boolean;
  link?: string;
  result?: string;
  to?: string;
  /** For restore, as typed or sent. */
  version?: unknown;
  on?: boolean;
  /** For drain, as typed or sent. */
  most?: unknown;
}

/** The one reading of a queue update, the CLI's and the MCP's alike. */
export function queueUpdate(input: QueueUpdateInput): QueueUpdate {
  const job = () => {
    if (input.job === undefined || input.job.trim() === '') throw new BoardError('give the job: its #id');
    return input.job;
  };
  const link = input.link === undefined ? {} : { link: input.link };
  switch (input.action) {
    case 'add': {
      const { kind, text = '' } = input;
      if (kind !== undefined && !(QUEUE_ADD_KINDS as readonly string[]).includes(kind)) throw new BoardError(`kind is one of ${QUEUE_ROW_KINDS.join(', ')} (or job, note)`);
      if (text.trim() === '') throw new BoardError('give the jobs to queue, one a line');
      if (input.body !== undefined && /[\r\n]/.test(text.trim())) throw new BoardError('with a body, give one headline: the body holds the rest');
      return {
        action: 'add',
        text,
        ...(input.body === undefined ? {} : { body: input.body }),
        ...(kind === undefined ? {} : { kind: kind as QueueAddKind }),
        front: input.front === true,
        ...link,
      };
    }
    case 'take':
      return { action: 'take', ...(input.job === undefined ? {} : { job: input.job }) };
    case 'edit': {
      const which = job();
      if ((input.text === undefined || input.text === '') && input.link === undefined) throw new BoardError('give the new text, or a link');
      return { action: 'edit', job: which, ...(input.text === undefined || input.text === '' ? {} : { text: input.text }), ...link };
    }
    case 'done':
      return { action: 'done', job: job(), ...(input.result === undefined ? {} : { result: input.result }) };
    case 'rm':
    case 'remove':
      return { action: 'remove', job: job() };
    case 'drop':
    case 'later':
    case 'up':
      return { action: input.action, job: job() };
    case 'restore':
      return { action: 'restore', job: job(), version: versionNumber(input.version) };
    case 'move': {
      const which = job();
      if (input.to === undefined || input.to.trim() === '') throw new BoardError('give where to move it: the #id of the job to put it before, top or last');
      return { action: 'move', job: which, to: input.to };
    }
    case 'drain': {
      if (input.on === undefined) throw new BoardError('give drain on or off');
      const most = typeof input.most === 'string' && /^\d+$/.test(input.most) ? Number(input.most) : input.most;
      if (most !== undefined && (!Number.isInteger(most) || (most as number) < 1 || (most as number) > 3)) throw new BoardError('most is 1, 2 or 3');
      return { action: 'drain', on: input.on, ...(most === undefined ? {} : { most: most as number }) };
    }
    default:
      throw new BoardError('the queue updates are add, take, drop, done, edit, move, later, up, remove, restore and drain');
  }
}

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
  if (update.action === 'later' || update.action === 'up') {
    const { item: changed, job } = await call({ action: 'later', job: update.job, ...(update.action === 'up' ? { until: null } : {}) });
    const said = update.action === 'later' ? `Marked ${shortId(job!.id)} Later on ${title()}: no take without a job starts it until \`queue up\` moves it up.` : `Moved ${shortId(job!.id)} up on ${title()}: it waits in its place again.`;
    return { text: `${said}\n${jobLine(refs, job!, 1)}`, json: { item: changed, job } };
  }
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
  const at = new Date().toISOString();
  const queued = jobs.filter((job) => isQueueWork(job.kind) && job.state === 'queued' && !isPutOff(job, at));
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
