// To-do lists: reminders for the user, a board item of their own kind. An agent adds lines to its own list
// (`board.remind`), which its first line makes under its tile; the user makes lists of their own, and adds, edits,
// ticks, moves and takes off any line (`todo.change`). Nothing is automated: a tick is saved with who and when, and no
// one is told, so an agent that wants to know reads its list (`board.readTodos`). Every change to a list goes through
// one queue, so a line an agent adds while the user ticks another is never lost.
import { randomUUID } from 'node:crypto';
import { boardCaller, connectionAgent, isOwnLiveSession, type BoardCallerSources, type BoardConnection } from './board.ts';
import { readsItem, type ReachesZone } from './item-scope.ts';
import { isObject } from './json.ts';
import { keyedQueue } from './keyed-queue.ts';
import type { DaemonCall } from './orchestrator-layout.ts';
import { invalidParams, paramsObject, stringParam } from './params.ts';
import {
  BOARD_ERROR,
  MAX_TODO_LINES,
  MAX_TODO_TEXT,
  TODO_CARD_SIZE,
  type AgentTodoChange,
  type Agent,
  type BoardItem,
  type BoardPlace,
  type DaemonMethods,
  type StepsWho,
  type TodoChange,
  type TodoData,
  type TodoLine,
} from './protocol.ts';
import { RpcMethodError, type RpcHandlers } from './rpc.ts';
import type { AgentHost } from './agents.ts';

type TodoMethods = Pick<DaemonMethods, 'board.remind' | 'board.readTodos' | 'board.changeTodo' | 'todo.change'>;

export interface TodoHostOptions extends BoardCallerSources {
  agents: Pick<AgentHost, 'get' | 'fallbackOwner'>;
  /** The daemon's own methods: a to-do list is a board item, made and changed through them. */
  call: DaemonCall;
  /** Where an agent's new list goes: under its tile. */
  place(sessionId: string, size: { width: number; height: number }): Promise<BoardPlace | undefined>;
  reachesZone: ReachesZone;
  now?: () => Date;
}

const USER: StepsWho = { kind: 'user' };
const agentWho = (agent: Pick<Agent, 'sessionId' | 'name'>): StepsWho => ({ kind: 'agent', sessionId: agent.sessionId, name: agent.name });
const isAgentWho = (who: StepsWho, sessionId: string) => who.kind === 'agent' && who.sessionId === sessionId;
const isWho = (who: unknown): who is StepsWho =>
  isObject(who) && (who.kind === 'user' || (who.kind === 'agent' && typeof who.sessionId === 'string' && typeof who.name === 'string'));
const isLine = (line: unknown): line is TodoLine =>
  isObject(line) &&
  typeof line.id === 'string' &&
  typeof line.text === 'string' &&
  line.text.trim() !== '' &&
  line.text.length <= MAX_TODO_TEXT &&
  isWho(line.by) &&
  typeof line.at === 'string' &&
  (line.done === null || (isObject(line.done) && isWho(line.done.by) && typeof line.done.at === 'string'));

/** Checks a to-do list's data, as `item.create` and `item.update` save it. */
export function checkTodoData(data: Record<string, unknown>): void {
  const fail = (what: string) => invalidParams(`a to-do list's ${what}`);
  if (!isWho(data.owner)) throw fail("owner must be { kind: 'user' } or { kind: 'agent', sessionId, name }");
  const lines = data.lines;
  if (!Array.isArray(lines)) throw fail('lines must be a list');
  if (lines.length > MAX_TODO_LINES) throw fail(`lines are over ${MAX_TODO_LINES}`);
  for (const [at, line] of lines.entries()) {
    if (!isLine(line)) throw fail(`line ${at + 1} must be { id, text (1 to ${MAX_TODO_TEXT} characters), by, at, done }`);
  }
  if (new Set(lines.map((line) => (line as TodoLine).id)).size !== lines.length) throw fail('lines must each have an id of their own');
  if (data.folded !== undefined && typeof data.folded !== 'boolean') throw fail('folded must be true or false');
}

/** A line's text as kept: on one line, its ends trimmed; refused if empty or too long. */
function todoText(raw: unknown): string {
  if (typeof raw !== 'string') throw invalidParams('a to-do must be text');
  const text = raw.replace(/\s*[\r\n]+\s*/g, ' ').trim();
  if (text === '') throw invalidParams('a to-do needs some text');
  if (text.length > MAX_TODO_TEXT) throw invalidParams(`a to-do is at most ${MAX_TODO_TEXT} characters`);
  return text;
}

/** The lines after `change`, made by `by` at `at`: a pure function of the list, so the app's undo and the daemon agree. */
export function changeTodoLines(lines: readonly TodoLine[], change: TodoChange, by: StepsWho, at: string, newId: () => string = randomUUID): TodoLine[] {
  const placeOf = (id: unknown) => {
    const place = lines.findIndex((line) => line.id === id);
    if (place === -1) throw invalidParams(`the list has no line ${String(id)}`);
    return place;
  };
  const roomFor = (adding: number) => {
    if (lines.length + adding > MAX_TODO_LINES) throw invalidParams(`a to-do list holds at most ${MAX_TODO_LINES} lines: clear the ticked ones first`);
  };
  switch (change.action) {
    case 'add': {
      roomFor(1);
      const line: TodoLine = { id: newId(), text: todoText(change.text), by, at, done: null };
      const after = change.after === undefined || change.after === null ? lines.length - 1 : placeOf(change.after);
      return [...lines.slice(0, after + 1), line, ...lines.slice(after + 1)];
    }
    case 'edit': {
      const place = placeOf(change.line);
      const text = todoText(change.text);
      return lines.map((line, at_) => (at_ === place ? { ...line, text } : line));
    }
    case 'tick': {
      const place = placeOf(change.line);
      if (typeof change.done !== 'boolean') throw invalidParams('done must be true or false');
      return lines.map((line, at_) => (at_ !== place ? line : { ...line, done: change.done ? (line.done ?? { by, at }) : null }));
    }
    case 'remove': {
      const place = placeOf(change.line);
      return lines.filter((_, at_) => at_ !== place);
    }
    case 'clear':
      return lines.filter((line) => line.done === null);
    case 'move': {
      const place = placeOf(change.line);
      if (!Number.isInteger(change.to) || change.to < 0 || change.to >= lines.length) throw invalidParams(`to must be a place from 0 to ${lines.length - 1}`);
      const rest = lines.filter((_, at_) => at_ !== place);
      return [...rest.slice(0, change.to), lines[place]!, ...rest.slice(change.to)];
    }
    case 'restore': {
      if (!isLine(change.line)) throw invalidParams('restore needs the line as it was');
      if (lines.some((line) => line.id === change.line.id)) return [...lines];
      roomFor(1);
      const place = Number.isInteger(change.at) ? Math.max(0, Math.min(change.at, lines.length)) : lines.length;
      return [...lines.slice(0, place), change.line, ...lines.slice(place)];
    }
  }
}

const CHANGES = ['add', 'edit', 'tick', 'remove', 'clear', 'move', 'restore'];

function todoChange(value: unknown): TodoChange {
  if (!isObject(value) || !CHANGES.includes(value.action as string)) throw invalidParams(`change.action must be one of ${CHANGES.join(', ')}`);
  return value as unknown as TodoChange;
}

function agentTodoChange(value: unknown): AgentTodoChange {
  if (!isObject(value) || (value.action !== 'tick' && value.action !== 'remove') || typeof value.line !== 'string') {
    throw invalidParams("change must be { action: 'tick', line, done } or { action: 'remove', line }");
  }
  return value as unknown as AgentTodoChange;
}

export interface TodoHost {
  /** The items an agent's connection sees: only the to-do lists in its scope. */
  visible(items: BoardItem[], connection: BoardConnection): BoardItem[];
  handlers<Context extends BoardConnection>(): RpcHandlers<TodoMethods, Context>;
}

export function createTodoHost(options: TodoHostOptions): TodoHost {
  const now = () => (options.now?.() ?? new Date()).toISOString();
  // One queue for every list: a list's read and its save never interleave with another change, nor two first lines of
  // one agent make it two lists.
  const queue = keyedQueue();
  const one = <T>(task: () => Promise<T>) => queue('todo', task);

  const dataOf = (item: BoardItem) => item.data as unknown as TodoData;
  const lists = async () => (await options.call('item.list', undefined)).filter((item) => item.kind === 'todo');
  const listOf = async (id: string) => {
    const found = (await lists()).find((item) => item.id === id);
    if (found === undefined) throw invalidParams(`no to-do list ${id}`);
    return found;
  };
  const ownList = async (sessionId: string) => (await lists()).find((item) => isAgentWho(dataOf(item).owner, sessionId));
  const save = (item: BoardItem, lines: TodoLine[]) => options.call('item.update', { id: item.id, data: { lines } });

  const reads = (agent: Agent, item: BoardItem) => readsItem(agent, item, isAgentWho(dataOf(item).owner, agent.sessionId), options.reachesZone);

  /** The agent whose board token the call holds; with `live`, only its own live session. */
  const caller = (p: Record<string, unknown>, connection: BoardConnection, live: boolean): Agent => {
    const who = boardCaller(options, stringParam(p, 'token'), connection);
    const me = who.kind === 'agent' ? options.agents.get(who.tileId) : undefined;
    if (me === undefined) throw invalidParams('only an agent keeps a to-do list for the user: not a shell');
    if (live && !isOwnLiveSession(me, who.sessionId)) throw invalidParams("only a live agent adds to its to-do list, from its own session: not an ended agent's");
    return me;
  };

  const remind = async (me: Agent, texts: unknown) => {
    if (!Array.isArray(texts) || texts.length === 0) throw invalidParams('text must be a list of one or more to-dos');
    const clean = texts.map(todoText);
    return one(async () => {
      const at = now();
      const by = agentWho(me);
      let item = await ownList(me.sessionId);
      if (item === undefined) {
        const spot = (await options.place(me.sessionId, TODO_CARD_SIZE)) ?? { zoneId: me.zoneId, x: 0, y: 0 };
        const data: TodoData = { owner: by, lines: [] };
        item = await options.call('item.create', { kind: 'todo', ...spot, ...TODO_CARD_SIZE, data: { ...data } });
      }
      let lines = dataOf(item).lines;
      if (lines.length + clean.length > MAX_TODO_LINES) {
        throw invalidParams(`your to-do list holds at most ${MAX_TODO_LINES} lines and has ${lines.length}: the user clears the ticked ones`);
      }
      const added: TodoLine[] = [];
      for (const text of clean) {
        lines = changeTodoLines(lines, { action: 'add', text }, by, at);
        added.push(lines.at(-1)!);
      }
      return { item: await save(item, lines), added };
    });
  };

  return {
    visible(items, connection) {
      const me = connectionAgent(options, connection);
      if (me === undefined) return items;
      if (me === null) return items.filter((item) => item.kind !== 'todo');
      return items.filter((item) => item.kind !== 'todo' || reads(me, item));
    },

    handlers<Context extends BoardConnection>(): RpcHandlers<TodoMethods, Context> {
      return {
        'board.remind': async (params, connection) => {
          const p = paramsObject(params);
          return remind(caller(p, connection, true), p.text);
        },
        'board.readTodos': async (params, connection) => {
          const p = paramsObject(params);
          const me = caller(p, connection, false);
          if (p.mine !== undefined && typeof p.mine !== 'boolean') throw invalidParams('mine must be true or false');
          return (await lists()).filter((item) => (p.mine === true ? isAgentWho(dataOf(item).owner, me.sessionId) : reads(me, item)));
        },
        'board.changeTodo': async (params, connection) => {
          const p = paramsObject(params);
          const me = caller(p, connection, true);
          const change = agentTodoChange(p.change);
          return one(async () => {
            const item = await ownList(me.sessionId);
            if (item === undefined) throw invalidParams('you have no to-do list yet: `agent-board remind "<text>"` makes one');
            const line = dataOf(item).lines.find((each) => each.id === change.line);
            if (line === undefined) throw invalidParams(`your to-do list has no line ${change.line}`);
            if (!isAgentWho(line.by, me.sessionId)) throw new RpcMethodError(BOARD_ERROR.outOfScope, "the user wrote that line: it is theirs to tick or take off");
            return save(item, changeTodoLines(dataOf(item).lines, change, agentWho(me), now()));
          });
        },
        'todo.change': async (params) => {
          const p = paramsObject(params);
          const id = stringParam(p, 'id');
          const change = todoChange(p.change);
          return one(async () => {
            const item = await listOf(id);
            return save(item, changeTodoLines(dataOf(item).lines, change, USER, now()));
          });
        },
      };
    },
  };
}
