import { createContext, memo, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useReactFlow, type NodeProps } from '@xyflow/react';
import { TODO_CARD_SIZE, TODO_PILL_SIZE } from '@agent-board/daemon/protocol';
import { requestTab } from '../../session/tab-request';
import { todoSurfaceOf } from '../../session/tabs';
import { useBoardCommands } from '../commands';
import { ItemActionsContext, useOnlySelected, type ItemNodeType } from './items';
import { ListCardToolbar, useZone } from './ListCardNodeParts';
import { TodoCardView, TodoPillView, type TodoCardActions } from './TodoCard';
import { useTodoLook } from './todo-look';
import { listAgent, NO_LOOKUP, todoData, type TodoLookup } from './todo-view';
import { useTodoChanges } from './use-todo-changes';

/** What a to-do list reads of the board: the agents that wrote its lines, as they are now. */
export const TodoLookupContext = createContext<TodoLookup>(NO_LOOKUP);

/**
 * A to-do list on the board: the user ticks, edits, adds, moves and deletes its lines in place, each saved as the user's
 * through the daemon, and none of it tells an agent. ↵ on the selected list steps into it, for its keys; esc gives them
 * back. It folds to a pill from its toolbar or its head's menu. An agent's list opens from that menu as the To do tab of
 * the agent's window too.
 */
export const TodoNode = memo(function TodoNode({ id: nodeId, data, selected: picked, dragging }: NodeProps<ItemNodeType>) {
  const selected = useOnlySelected(picked);
  const { update, remove } = useContext(ItemActionsContext);
  const lookup = useContext(TodoLookupContext);
  const look = useTodoLook();
  const commands = useBoardCommands();
  const { updateNodeData } = useReactFlow();
  const { item } = data;
  const list = todoData(item.data);
  const folded = list.folded === true;
  const zone = useZone(item.zoneId);
  // A list the user just made opens with its add field focused, once; ↵ on a list later steps into its lines.
  const [addFirst] = useState(() => data.editing === true && list.lines.length === 0);
  useEffect(() => {
    if (addFirst) updateNodeData(nodeId, { editing: false });
  }, [addFirst, nodeId, updateNodeData]);
  const steppedIn = data.editing === true && !addFirst;

  // Put down, it gives the keyboard back.
  useEffect(() => {
    if (!selected && data.editing === true) updateNodeData(nodeId, { editing: false });
  }, [selected, data.editing, nodeId, updateNodeData]);

  const leave = useCallback(() => {
    updateNodeData(nodeId, { editing: false });
    (document.querySelector(`.react-flow__node[data-id="${CSS.escape(nodeId)}"]`) as HTMLElement | null)?.focus();
  }, [nodeId, updateNodeData]);

  const changes = useTodoChanges(item.id, list.lines);
  const fold = useCallback((next: boolean) => update({ id: item.id, data: { folded: next }, ...(next ? TODO_PILL_SIZE : TODO_CARD_SIZE) }), [item.id, update]);
  const agentId = listAgent(list);

  const actions = useMemo<TodoCardActions>(
    () => ({
      ...changes,
      showAgent: (sessionId) => commands.focusSession(sessionId),
      // Only while its agent is on the board: a gone agent has no window to open.
      ...(agentId === undefined || lookup.name(agentId) === undefined
        ? {}
        : {
            openInWindow: () => {
              requestTab(agentId, todoSurfaceOf(agentId));
              commands.openSession(agentId);
            },
          }),
      fold,
      deleteList: () => remove(item.id),
      leave,
    }),
    [agentId, changes, commands, fold, item.id, leave, lookup, remove],
  );

  const toolbar = <ListCardToolbar visible={selected && !dragging} folded={folded} onFold={fold} noun="to-do list" onDelete={() => remove(item.id)} />;

  return (
    <div className="todo-node" data-folded={folded || undefined}>
      {folded ? (
        <TodoPillView data={list} lookup={lookup} onOpen={() => fold(false)} onClear={changes.clear}>
          {toolbar}
        </TodoPillView>
      ) : (
        <TodoCardView data={list} lookup={lookup} zoneName={zone.name} look={look} steppedIn={steppedIn} addFirst={addFirst} actions={actions}>
          {toolbar}
        </TodoCardView>
      )}
    </div>
  );
});
