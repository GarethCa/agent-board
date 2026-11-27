import { memo, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useReactFlow, type NodeProps } from '@xyflow/react';
import { TODO_CARD_MIN_SIZE, TODO_CARD_SIZE, TODO_PILL_SIZE } from '@agent-board/daemon/protocol';
import { requestTab } from '../../session/tab-request';
import { todoSurfaceOf } from '../../session/tabs';
import { useBoardCommands } from '../commands';
import { CardResizer, FoldedPicture } from './CardSizing';
import { foldTo } from './card-size';
import { ItemActionsContext, useOnlySelected, type ItemNodeType } from './items';
import { ListCardPeekPopover, ListCardToolbar, useFullKey, useZone } from './ListCardNodeParts';
import { useNow } from '../../inbox/use-now';
import { TodoFull } from './TodoFull';
import { TodoPeek } from './ZoneTodoPopover';
import { TodoCardView, TodoPillView, type TodoCardActions } from './TodoCard';
import { useTodoLook } from './todo-look';
import { listAgent, todoData } from './todo-view';
import { TodoLookupContext } from './todo-lookup';
import { useTodoChanges } from './use-todo-changes';

/**
 * A to-do list on the board: the user ticks, edits, adds, moves and deletes its lines in place, each saved as the user's
 * through the daemon, and none of it tells an agent. ↵ on the selected list steps into it, for its keys; esc gives them
 * back. It folds to a pill from its toolbar or its head's menu. An agent's list opens from that menu as the To do tab of
 * the agent's window too. One click on the pill opens its peek beside it; a double-click on the pill, or on the card's
 * head, foot or the space between its lines, or ⌘↵ while it is selected, opens it full screen.
 */
export const TodoNode = memo(function TodoNode({ id: nodeId, data, selected: picked, dragging, width, height }: NodeProps<ItemNodeType>) {
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
  const [peek, setPeek] = useState(false);
  const [full, setFull] = useState(false);
  const openFull = useCallback(() => {
    setPeek(false);
    setFull(true);
  }, []);
  useFullKey(selected, full, openFull);
  const now = new Date(useNow(false));
  // Folded, it keeps the size it had open, which the user may have given it, and opens to that again.
  const fold = useCallback(
    (next: boolean) => {
      const { size, kept } = foldTo(item, next, { folded: TODO_PILL_SIZE, open: TODO_CARD_SIZE });
      update({ id: item.id, data: { folded: next, ...kept }, ...size });
    },
    [item, update],
  );
  const agentId = listAgent(list);

  const actions = useMemo<TodoCardActions>(
    () => ({
      ...changes,
      // From full screen, it goes first, so the board it moves to shows.
      showAgent: (sessionId) => {
        setFull(false);
        commands.focusSession(sessionId);
      },
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
      openFull,
      deleteList: () => remove(item.id),
      leave,
    }),
    [agentId, changes, commands, fold, item.id, leave, lookup, openFull, remove],
  );

  const toolbar = <ListCardToolbar visible={selected && !dragging} folded={folded} onFold={fold} noun="to-do list" onDelete={() => remove(item.id)} />;

  return (
    <div className="todo-node" data-folded={folded || undefined}>
      <CardResizer
        visible={selected}
        least={TODO_CARD_MIN_SIZE}
        picture={folded ? TODO_PILL_SIZE : undefined}
        onResized={(frame) => update({ id: item.id, ...frame })}
      />
      {folded ? (
        <ListCardPeekPopover
          anchor={
            <div className="listcard-anchor">
              <FoldedPicture picture={TODO_PILL_SIZE} width={width} height={height} item={item}>
                <TodoPillView data={list} lookup={lookup} onOpen={() => setPeek(true)} onFull={openFull} onUnfold={() => fold(false)} onClear={changes.clear}>
                  {toolbar}
                </TodoPillView>
              </FoldedPicture>
            </div>
          }
          open={peek}
          onOpenChange={setPeek}
          aria-label="To do: its lines"
          className="todo-peek-popover"
        >
          <TodoPeek data={list} changes={changes} onFull={openFull} />
        </ListCardPeekPopover>
      ) : (
        <TodoCardView data={list} lookup={lookup} zoneName={zone.name} look={look} steppedIn={steppedIn} addFirst={addFirst} actions={actions}>
          {toolbar}
        </TodoCardView>
      )}
      {full && (
        <TodoFull
          data={list}
          lookup={lookup}
          zoneName={zone.name}
          now={now}
          actions={actions}
          onClose={() => setFull(false)}
          object={() => document.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(nodeId)}"]`)}
        />
      )}
    </div>
  );
});
