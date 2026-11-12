import type { StepsWho, TodoData, TodoLine } from '@agent-board/daemon/protocol';
import { TODO_CARD_SIZE, TODO_PILL_SIZE } from '@agent-board/daemon/protocol';
import { TodoCardView, TodoPillView, type TodoCardActions, type TodoEditing } from './TodoCard';
import type { TodoLook, TodoLookup } from './todo-view';

const AT = '2026-01-01T00:00:00.000Z';
const USER: StepsWho = { kind: 'user' };
const agent = (name: string): StepsWho => ({ kind: 'agent', sessionId: `gallery-${name}`, name });
const FIXER = agent('fixer');

let next = 0;
const line = (text: string, by: StepsWho = FIXER, done = false): TodoLine => ({ id: `t${next++}`, text, by, at: AT, done: done ? { by: USER, at: AT } : null });

const OPEN: TodoData = {
  owner: FIXER,
  lines: [
    line('Send #214 off for approval'),
    line('Try the new board on the demo laptop', USER),
    line('Rotate the staging key', FIXER, true),
    line('Read the cache plan and pick a store', agent('planner')),
  ],
};
const DONE: TodoData = { owner: FIXER, lines: OPEN.lines.map((each) => ({ ...each, done: { by: USER, at: AT } })) };
const EMPTY: TodoData = { owner: USER, lines: [] };
const [FIRST, SECOND] = OPEN.lines as [TodoLine, TodoLine];

const LOOKUP: TodoLookup = { name: (sessionId) => sessionId.replace(/^gallery-/, ''), harness: (sessionId) => (sessionId === 'gallery-planner' ? 'codex' : 'claude') };
const ACTIONS: TodoCardActions = {
  add: async () => undefined,
  edit: () => {},
  tick: () => {},
  remove: () => {},
  clear: () => {},
  move: () => {},
  showAgent: () => {},
  copy: () => {},
  fold: () => {},
  deleteList: () => {},
  leave: () => {},
};

type Initial = { editing?: TodoEditing; draft?: string; cursor?: string; hot?: string };

/** Each look of a to-do card, by the name its screenshot gives it. */
const CARDS: { name: string; data: TodoData; initial?: Initial; steppedIn?: boolean; look?: TodoLook }[] = [
  { name: 'Lines left', data: OPEN },
  { name: 'A line under the pointer', data: OPEN, initial: { hot: SECOND.id } },
  { name: 'Stepped in, the keys on a line', data: OPEN, steppedIn: true, initial: { cursor: FIRST.id } },
  { name: 'Editing a line', data: OPEN, initial: { editing: { line: FIRST.id }, draft: FIRST.text } },
  { name: 'Adding one', data: OPEN, initial: { editing: { add: true, after: null }, draft: 'Book the release slot' } },
  { name: 'All done', data: DONE },
  { name: 'Empty', data: EMPTY },
  { name: 'Clipboard, lines left', data: OPEN, look: 'clipboard' },
  { name: 'Clipboard, a line under the pointer', data: OPEN, look: 'clipboard', initial: { hot: SECOND.id } },
  { name: 'Clipboard, all done', data: DONE, look: 'clipboard' },
  { name: 'Clipboard, empty', data: EMPTY, look: 'clipboard' },
];

const PILLS: { name: string; data: TodoData }[] = [
  { name: 'Folded, lines left', data: OPEN },
  { name: 'Folded, all done', data: DONE },
  { name: 'Folded, empty', data: EMPTY },
];

/** Every look of a to-do list, from data alone: for the visual shots, and to see them all at once. */
export function TodoGallery() {
  return (
    <section className="gallery-todo" data-testid="todo-gallery">
      {CARDS.map(({ name, data, initial, steppedIn = false, look }) => (
        <figure key={name} className="gallery-todo-cell">
          <div style={{ width: TODO_CARD_SIZE.width, height: TODO_CARD_SIZE.height }}>
            <TodoCardView data={data} lookup={LOOKUP} zoneName="agent-board" look={look} steppedIn={steppedIn} actions={ACTIONS} initial={initial} />
          </div>
          <figcaption>{name}</figcaption>
        </figure>
      ))}
      {PILLS.map(({ name, data }) => (
        <figure key={name} className="gallery-todo-cell">
          <div style={{ width: TODO_PILL_SIZE.width, height: TODO_PILL_SIZE.height }}>
            <TodoPillView data={data} lookup={LOOKUP} onOpen={() => {}} onClear={() => {}} />
          </div>
          <figcaption>{name}</figcaption>
        </figure>
      ))}
    </section>
  );
}
