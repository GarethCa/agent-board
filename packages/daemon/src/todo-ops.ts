// The to-do commands as the CLI and MCP give them (`remind "<text>"`, `remind ls [--mine]`, `remind done|undo|rm <n>`):
// lines for the user to do, added to the caller's own to-do list, and the lists it reads, with who ticked each line
// and when. A line is named by its place in the caller's own list, as `remind ls --mine` numbers it.
import { agentToken, BoardError, BoardRefs, inZone, readBoard, type BoardSession, type BoardView } from './board-ops.ts';
import type { BoardItem, StepsWho, TodoData, TodoLine } from './protocol.ts';

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** A time as the user's clock shows it: `14:06` today, `2026-11-10 14:06` before. */
export function clockText(at: string, now = new Date()): string {
  const when = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  const time = `${pad(when.getHours())}:${pad(when.getMinutes())}`;
  const sameDay = when.getFullYear() === now.getFullYear() && when.getMonth() === now.getMonth() && when.getDate() === now.getDate();
  return sameDay ? time : `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} ${time}`;
}

function whoText(refs: BoardRefs, who: StepsWho, me: string | undefined): string {
  if (who.kind === 'user') return 'you';
  if (who.sessionId === me) return 'this agent';
  const ref = refs.board.agents.some((agent) => agent.sessionId === who.sessionId) ? `${refs.of('agent', who.sessionId)} ` : '';
  return `${ref}${who.name}`;
}

/** A list's head: its ref, whose it is, how many lines are open, and where it is. */
function listHead(refs: BoardRefs, item: BoardItem, me: string | undefined): string {
  const data = item.data as unknown as TodoData;
  const open = data.lines.filter((line) => line.done === null).length;
  const whose = data.owner.kind === 'user' ? "the user's own" : data.owner.sessionId === me ? 'yours' : `${whoText(refs, data.owner, me)}'s`;
  const count = data.lines.length === 0 ? 'empty' : open === 0 ? `all ${data.lines.length} done` : `${open} to do of ${data.lines.length}`;
  return `${refs.of('item', item.id)}  To do, ${whose}  ${count}  ${inZone(refs, item.zoneId)}`;
}

/** A line: its place, its tick, its text, who ticked it and when, and who wrote it when not the list's owner. */
function lineText(refs: BoardRefs, owner: StepsWho, line: TodoLine, place: number, me: string | undefined): string {
  const by = owner.kind === line.by.kind && (owner.kind === 'user' || (line.by.kind === 'agent' && owner.sessionId === line.by.sessionId)) ? '' : `  (written by ${whoText(refs, line.by, me)})`;
  const done = line.done === null ? '' : ` · ${whoText(refs, line.done.by, me)}, ${clockText(line.done.at)}`;
  return `  ${place}. [${line.done === null ? ' ' : 'x'}] ${line.text}${done}${by}`;
}

function listText(refs: BoardRefs, item: BoardItem, me: string | undefined): string {
  const data = item.data as unknown as TodoData;
  const lines = data.lines.map((line, at) => lineText(refs, data.owner, line, at + 1, me));
  return [listHead(refs, item, me), ...(lines.length === 0 ? ['  Nothing to do.'] : lines)].join('\n');
}

const NO_LIST = 'You have no to-do list yet: `agent-board remind "<text>"` makes one under your tile.';

/** `remind "<text>" …`: adds lines to the caller's to-do list for the user, making it under its tile if it has none. */
export async function remind(session: BoardSession, texts: string[]): Promise<BoardView> {
  const lines = texts.flatMap((text) => text.split('\n')).filter((text) => text.trim() !== '');
  if (lines.length === 0) throw new BoardError('give the to-do: `agent-board remind "<what the user must do>"`');
  const { item, added } = await session.client.call('board.remind', { token: agentToken(session, 'add a to-do for the user'), text: lines });
  const refs = new BoardRefs(await readBoard(session.client));
  const open = (item.data as unknown as TodoData).lines.filter((line) => line.done === null).length;
  return {
    text:
      `Added ${plural(added.length, 'to-do')} to your list ${refs.of('item', item.id)} under your tile: ${open} open for the user. ` +
      'Nothing tells you when the user ticks one: `agent-board remind ls --mine` shows which are done.',
    json: { item, added },
  };
}

/** `remind ls [--mine]`: the to-do lists the caller reads, or only its own. */
export async function readTodos(session: BoardSession, mine: boolean): Promise<BoardView> {
  const items = await session.client.call('board.readTodos', { token: agentToken(session, 'read to-do lists'), mine });
  const refs = new BoardRefs(await readBoard(session.client));
  const me = session.caller?.kind === 'agent' ? session.caller.sessionId : undefined;
  if (items.length === 0) return { text: mine ? NO_LIST : 'No to-do lists you can read.', json: items };
  return { text: items.map((item) => listText(refs, item, me)).join('\n\n'), json: items };
}

/** `remind done|undo|rm <n>`: ticks, unticks or takes off line n of the caller's own list, one it wrote. */
export async function changeTodo(session: BoardSession, action: 'done' | 'undo' | 'rm', place: number): Promise<BoardView> {
  const token = agentToken(session, 'change its to-do list');
  const [item] = await session.client.call('board.readTodos', { token, mine: true });
  if (item === undefined) throw new BoardError(NO_LIST);
  const lines = (item.data as unknown as TodoData).lines;
  const line = Number.isInteger(place) && place >= 1 ? lines[place - 1] : undefined;
  if (line === undefined) throw new BoardError(lines.length === 0 ? 'your to-do list is empty' : `give a line from 1 to ${lines.length}, as \`agent-board remind ls --mine\` numbers them`);
  const change = action === 'rm' ? ({ action: 'remove', line: line.id } as const) : ({ action: 'tick', line: line.id, done: action === 'done' } as const);
  const changed = await session.client.call('board.changeTodo', { token, change });
  const refs = new BoardRefs(await readBoard(session.client));
  const did = action === 'rm' ? 'Took off' : action === 'done' ? 'Ticked' : 'Unticked';
  return { text: `${did} “${line.text}”.\n${listText(refs, changed, session.caller?.kind === 'agent' ? session.caller.sessionId : undefined)}`, json: changed };
}
