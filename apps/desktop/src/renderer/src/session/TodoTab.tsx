// The To do tab of an agent's window: the agent's own to-do list, the one its reminders go to, ticked and edited here
// as on the board. The list is read live, as any window has the board's items.
import { useEffect, useMemo, useState } from 'react';
import { SquareCheckBig } from 'lucide-react';
import type { Agent, BoardItem } from '@agent-board/daemon/protocol';
import { TodoCardView, type TodoCardActions } from '../board/items/TodoCard';
import { useTodoLook } from '../board/items/todo-look';
import { agentTodoList, todoData, type TodoLookup } from '../board/items/todo-view';
import { useTodoChanges } from '../board/items/use-todo-changes';
import { useDirectoryAgents } from './use-live-board';

const NO_LINES: never[] = [];

/** The agent's own list as it is now: undefined while the board's items are read, null for an agent with none. */
function useAgentTodoList(sessionId: string): BoardItem | null | undefined {
  const [list, setList] = useState<BoardItem | null>();
  useEffect(() => {
    let current = true;
    // A change heard before the items arrive is newer than they are: the items don't put it back.
    let changed = false;
    // Nor does an item removed before they arrive.
    const gone = new Set<string>();
    const items = window.agentBoard.items;
    void items.list().then((all) => {
      if (current && !changed) setList(agentTodoList(all.filter((item) => !gone.has(item.id)), sessionId) ?? null);
    });
    const stop = items.onChanged((change) => {
      if (change.type === 'item.updated') {
        const { item } = change;
        if (item.kind !== 'todo') return;
        const its = agentTodoList([item], sessionId) !== undefined;
        setList((was) => {
          if (its) return item;
          // The list it had stopped being its own.
          return was?.id === item.id ? null : was;
        });
        if (its) changed = true;
      } else if (change.type === 'item.removed') {
        setList((was) => (was?.id === change.id ? null : was));
        gone.add(change.id);
      }
    });
    return () => {
      current = false;
      stop();
    };
  }, [sessionId]);
  return list;
}

/** The tab: the agent's list in the look picked in Settings, or a word on how one gets here. */
export function TodoTab({ agent }: { agent: Agent }) {
  const list = useAgentTodoList(agent.sessionId);
  const look = useTodoLook();
  const { agents } = useDirectoryAgents(NO_LINES);
  const lookup = useMemo<TodoLookup>(
    () => ({
      name: (sessionId) => (sessionId === agent.sessionId ? agent.name : agents?.find((each) => each.sessionId === sessionId)?.name),
      harness: (sessionId) => (sessionId === agent.sessionId ? agent.harness : agents?.find((each) => each.sessionId === sessionId)?.harness),
    }),
    [agent.harness, agent.name, agent.sessionId, agents],
  );
  const data = list ? todoData(list.data) : undefined;
  const changes = useTodoChanges(list?.id ?? '', data?.lines ?? NO_LINES);
  // Its keys are the window's: nothing here steps in, so there is nothing to give back.
  const actions = useMemo<TodoCardActions>(() => ({ ...changes, leave: () => {} }), [changes]);
  return (
    <div className="todo-tab" data-testid="todo-tab">
      {list === undefined ? (
        <p className="todo-tab-note">Reading its list…</p>
      ) : data === undefined ? (
        <div className="todo-empty todo-tab-none">
          <span className="todo-empty-icon" aria-hidden>
            <SquareCheckBig />
          </span>
          <b>Nothing to do</b>
          <span>
            When {agent.name} reminds you with <code>remind</code>, it shows here.
          </span>
        </div>
      ) : (
        <TodoCardView data={data} lookup={lookup} steppedIn={false} actions={actions} look={look} />
      )}
    </div>
  );
}
