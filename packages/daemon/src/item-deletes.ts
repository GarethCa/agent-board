// An agent deletes a board item (`orchestrator.deleteItem`): any kind but a running crew's card, one it or its crew
// made by itself, one made by anyone else only as the user allows in a remove ask. The item goes as the user's own
// Delete takes it, as one step the board's undo puts back, and work still open on it is kept unless the agent forces it.
import type { DatabaseSync } from 'node:sqlite';
import type { BoardConnection } from './board.ts';
import { itemMaker } from './item-makers.ts';
import { notReadBecause } from './item-scope.ts';
import type { ActivityEntry, OrchestratorAccess } from './orchestrator-types.ts';
import { invalidParams, optionalBooleanParam, optionalCountParam, paramsObject, stringParam } from './params.ts';
import {
  BOARD_ERROR,
  DEFAULT_ASK_WAIT_MS,
  MAX_ASK_WAIT_MS,
  type BoardItem,
  type DaemonCall,
  type DaemonMethods,
  type ItemDeleteResult,
  type RemoveAskResult,
  type StepsData,
  type TodoData,
} from './protocol.ts';
import type { RemoveAskEnd, RemoveAskStore } from './remove-asks.ts';
import { RpcMethodError, type RpcHandlers } from './rpc.ts';
import { cutText, plural } from './text-words.ts';

type ItemDeleteMethods = Pick<DaemonMethods, 'orchestrator.deleteItem'>;

export interface ItemDeletesOptions {
  db: DatabaseSync;
  access: OrchestratorAccess;
  call: DaemonCall;
  removeAsks: Pick<RemoveAskStore, 'ask'>;
  /** Of `list`, the items `connection` reads: a card on a ticket's board or in a zone only where its audience takes it in. */
  visible: (list: BoardItem[], connection: BoardConnection) => BoardItem[];
}

const outOfScope = (message: string) => new RpcMethodError(BOARD_ERROR.outOfScope, message);

/** What each kind is called in a reply, where its plain kind reads badly. */
const KIND_NAMES: Partial<Record<BoardItem['kind'], string>> = {
  'agent-note': 'agent note',
  steps: 'steps card',
  crew: 'crew card',
  todo: 'to-do list',
  'done-line': 'done line',
  stages: 'stage board',
};

/** What the board calls `item` in a reply or a remove ask: its kind, and its title or text when it has one. */
export function deletedName(item: BoardItem): string {
  const kind = KIND_NAMES[item.kind] ?? item.kind;
  const words = [item.data.title, item.data.text, item.data.label, item.data.url].find((each) => typeof each === 'string' && each.trim() !== '');
  return typeof words === 'string' ? `${kind} “${cutText(words.trim(), 40)}”` : kind;
}


/** The work still open on `item`, which a delete keeps unless forced: a queue's open jobs, a list's open lines. */
export interface OpenWork {
  count: number;
  /** "open job": what each is, in a refusal. */
  what: string;
}

/** What is open on `item`, `openJobs` being a queue's jobs not done; null when nothing is. */
export function openWork(item: BoardItem, openJobs: number): OpenWork | null {
  const open = (count: number, what: string): OpenWork | null => (count > 0 ? { count, what } : null);
  switch (item.kind) {
    case 'queue':
      return open(openJobs, 'open job');
    case 'todo':
      return open((item.data as unknown as TodoData).lines.filter((line) => line.done === null).length, 'open line');
    case 'steps': {
      const data = item.data as unknown as StepsData;
      if (data.closedAt !== null) return null;
      return open(data.steps.filter((step) => (step.kind === 'todo' ? step.done === null : step.answer === null)).length, 'open step');
    }
    default:
      return null;
  }
}

/** How a remove ask for one item ended, as the agent is told it, when it ended in no Allow: an item is never held back, so Allow takes it, whatever `include` holds. */
function askEnded(id: string, name: string, end: RemoveAskEnd): ItemDeleteResult | null {
  if (end === null) return { outcome: 'kept', id, name, why: 'the ask was withdrawn before the user answered' };
  if (end === 'timed-out') return { outcome: 'timed-out', id, name, why: 'the user did not answer in time' };
  if (!end.allow) return { outcome: 'denied', id, name, why: 'the user said no' };
  return null;
}

export function itemDeleteHandlers<Context extends BoardConnection>(options: ItemDeletesOptions): RpcHandlers<ItemDeleteMethods, Context> {
  const { db, access, call, removeAsks, visible } = options;
  const madeByOf = db.prepare('SELECT made_by FROM board_items WHERE id = ?');
  const openJobsOf = db.prepare('SELECT COUNT(*) AS n FROM queue_jobs WHERE item_id = ? AND done_at IS NULL');

  const itemNamed = async (id: string) => (await call('item.list', { allBoards: true })).find((each) => each.id === id);
  const openOn = (item: BoardItem) => openWork(item, (openJobsOf.get(item.id) as { n: number }).n);
  const take = (item: BoardItem) => call('item.delete', { id: item.id, undoable: true });

  /** On the user's Allow, takes the item as it is now: kept, saying why, if it went, or if work opened on it while the ask waited and the delete wasn't forced, or if its asker may no longer act on the board. */
  const takeAllowed = async (requester: string, id: string, name: string, force: boolean): Promise<ItemDeleteResult> => {
    const kept = (why: string): ItemDeleteResult => ({ outcome: 'kept', id, name, why });
    const now = await itemNamed(id);
    if (now === undefined) return kept('it was gone already');
    if (!access.mayOrchestrate(requester)) return kept('you may not act on the board now');
    const open = openOn(now);
    if (open !== null && !force) return kept(`it has ${plural(open.count, open.what)} now: add --force to delete it with them`);
    await take(now);
    return { outcome: 'deleted', id, name, why: null };
  };

  return {
    'orchestrator.deleteItem': async (params, connection) => {
      const p = paramsObject(params);
      const me = access.caller('orchestrator.deleteItem', p, connection);
      const entry: ActivityEntry = { detail: '' };
      return access.logged(me, 'delete-item', entry, async (): Promise<ItemDeleteResult> => {
        const id = stringParam(p, 'id');
        const force = optionalBooleanParam(p, 'force') ?? false;
        const ask = optionalBooleanParam(p, 'ask') ?? false;
        const timeoutMs = optionalCountParam(p, 'timeoutMs');
        const item = await itemNamed(id);
        if (item === undefined) throw invalidParams(`no board item ${id}`);
        const name = deletedName(item);
        entry.on = { id: item.id, name };
        if (visible([item], connection).length === 0) throw outOfScope(notReadBecause(`that ${KIND_NAMES[item.kind] ?? item.kind}`, item));
        if (item.kind === 'crew') throw invalidParams("that is a crew's card: it goes when its crew is stopped and its tiles removed");

        const open = openOn(item);
        if (open !== null && !force) {
          throw invalidParams(`${name} has ${plural(open.count, open.what)}: finish or remove them first, or add --force to delete it with them`);
        }
        if (open !== null) entry.detail = `forced, with ${plural(open.count, open.what)}`;

        const maker = itemMaker(item, (madeByOf.get(item.id) as { made_by: string | null } | undefined)?.made_by ?? null);
        if (access.madeByCrew(me, maker)) {
          await take(item);
          return { outcome: 'deleted', id: item.id, name, why: null };
        }
        if (!ask) {
          const whose = maker === null ? 'not marked as made by you or your crew' : 'made by another agent';
          throw outOfScope(`${name} is ${whose}: add --ask to ask the user to delete it`);
        }
        const requester = me.agent!;
        const ms = Math.min(timeoutMs ?? DEFAULT_ASK_WAIT_MS, MAX_ASK_WAIT_MS);
        const signal = connection.closed ?? new AbortController().signal;
        let told: ItemDeleteResult | undefined;
        const finish = async (end: RemoveAskEnd): Promise<RemoveAskResult> => {
          told = askEnded(item.id, name, end) ?? (await takeAllowed(requester.sessionId, item.id, name, force));
          const tile = { sessionId: item.id, name };
          if (told.outcome === 'deleted') return { outcome: 'allowed', removed: [tile], kept: [] };
          return { outcome: told.outcome === 'timed-out' ? 'timed-out' : told.outcome === 'denied' ? 'denied' : 'allowed', removed: [], kept: [{ ...tile, why: told.why ?? '' }] };
        };
        entry.detail = entry.detail === '' ? 'asked the user' : `${entry.detail}; asked the user`;
        await removeAsks.ask(requester.sessionId, [{ sessionId: item.id, name, held: null }], ms, finish, signal, true);
        return told!;
      });
    },
  };
}
