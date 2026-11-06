import { createContext, memo, useCallback, useContext, useEffect, useMemo } from 'react';
import { NodeToolbar, Position, useReactFlow, useStore, type NodeProps } from '@xyflow/react';
import { Maximize2, Minimize2, Trash2 } from 'lucide-react';
import { STEPS_CARD_SIZE, STEPS_ICON_SIZE, type Step, type StepsData } from '@agent-board/daemon/protocol';
import { parseSteps } from '@agent-board/daemon/steps-format';
import { useAction } from '../../use-action';
import { errorMessage } from '../../../../shared/errors';
import { IconButton, Kbd } from '../../ui';
import { keyText } from '../../keys/registry';
import { ItemActionsContext, useOnlySelected, type ItemNodeType } from './items';
import { StepsCard, type StepsCardActions } from './StepsCard';
import { zoomLook, type StepsLookup } from './steps-view';

/** What a steps card reads of the board: the agents it names, as they are now. */
export const StepsLookupContext = createContext<StepsLookup>({ live: () => false, name: () => undefined });

/** A steps card's data, as it was saved. */
const stepsData = (data: Record<string, unknown>): StepsData => data as unknown as StepsData;

/** The data of a new, empty card of the user's, for the board's menu and `K`. */
export const newStepsData = (): StepsData => ({ title: 'New steps', madeBy: { kind: 'user' }, answeredBy: { kind: 'user' }, steps: [], sent: null, waits: [], closedAt: null });

/** The steps typed into an empty card, as the user's own: each to-do theirs to tick. Throws, saying why, for lines it can't read. */
function typedSteps(text: string): { title: string | null; steps: Step[] } {
  const { title, steps } = parseSteps(text);
  return {
    title,
    steps: steps.map(({ who, done, ...step }) => {
      if (who !== null && who !== 'me' && who !== 'user') throw new Error(`a list you make is yours to tick: leave @${who} off “${step.text}”`);
      return { ...step, id: crypto.randomUUID().slice(0, 8), who: step.kind === 'todo' ? { kind: 'user' } : null, done: done ? { by: { kind: 'user' }, at: new Date().toISOString() } : null, answer: null };
    }),
  };
}

/**
 * A steps card on the board (`StepsCard`): answered and ticked through the daemon's steps methods, so its maker is told
 * on Send. ↵ on the selected card steps into it, as it types into a shape; esc gives the keys back. It folds to its icon
 * tile from its toolbar, and is drawn as one below about 40% zoom.
 */
export const StepsNode = memo(function StepsNode({ id, data, selected: picked, dragging }: NodeProps<ItemNodeType>) {
  const selected = useOnlySelected(picked);
  const { update, remove } = useContext(ItemActionsContext);
  const lookup = useContext(StepsLookupContext);
  const { updateNodeData, setNodes } = useReactFlow();
  const { item } = data;
  const card = stepsData(item.data);
  const editing = data.editing === true;
  const collapsed = card.collapsed === true;
  const look = useStore((state) => zoomLook(state.transform[2], collapsed));
  const { error, run } = useAction();
  const writing = editing && card.steps.length === 0 && card.madeBy.kind === 'user';
  const steppedIn = editing && !writing;
  // Put down, it gives the keyboard back.
  useEffect(() => {
    if (!selected && editing) updateNodeData(id, { editing: false });
  }, [selected, editing, id, updateNodeData]);

  const leave = useCallback(() => {
    updateNodeData(id, { editing: false });
    // Back to the board, with the card still selected.
    (document.querySelector(`.react-flow__node[data-id="${CSS.escape(id)}"]`) as HTMLElement | null)?.focus();
  }, [id, updateNodeData]);

  // Folded, its frame is its icon tile's, so it selects and moves by what is drawn.
  const fold = (folded: boolean) => update({ id: item.id, ...(folded ? STEPS_ICON_SIZE : STEPS_CARD_SIZE), data: { collapsed: folded } });

  const asks = window.agentBoard.asks;
  const actions = useMemo<StepsCardActions>(
    () => ({
      answer: (stepId, answer) => run(() => asks.answerStep(item.id, stepId, answer)),
      tick: (stepId, done) => run(() => asks.tickStep(item.id, stepId, done)),
      send: () => run(() => asks.sendSteps(item.id)),
      // Its button may be pressed with the card not yet selected: it is, alone, as it takes the keys.
      stepIn: () =>
        setNodes((nodes) => nodes.map((node) => (node.id === id ? { ...node, selected: true, data: { ...node.data, editing: true } } : node.selected === true ? { ...node, selected: false } : node))),
      leave,
      // Saved by the daemon before the card shows them: a list it refuses stays in the field, saying why. Once its
      // steps come back, it is no longer empty, so the card is stepped into them, its keys its own until esc.
      write: async (text) => {
        try {
          const typed = typedSteps(text);
          await window.agentBoard.items.update({ id: item.id, data: { ...card, title: typed.title ?? card.title, steps: typed.steps } });
          return undefined;
        } catch (failure) {
          return errorMessage(failure);
        }
      },
    }),
    [asks, item.id, card, run, update, updateNodeData, setNodes, id, leave],
  );

  return (
    <div
      className="steps-node"
      data-look={look}
      onDoubleClick={(event) => {
        // Not a new note on the board behind it.
        event.stopPropagation();
        if (collapsed) fold(false);
        else if (card.steps.length === 0 && card.madeBy.kind === 'user') updateNodeData(id, { editing: true });
      }}
    >
      <NodeToolbar isVisible={selected && !dragging && !writing} position={Position.Top} className="sticky-toolbar">
        <IconButton
          icon={collapsed ? <Maximize2 /> : <Minimize2 />}
          size="sm"
          aria-label={collapsed ? 'Unfold it' : 'Fold it to its icon'}
          tooltip={collapsed ? 'Unfold it' : 'Fold it to its icon'}
          onClick={() => fold(!collapsed)}
        />
        <IconButton
          icon={<Trash2 />}
          size="sm"
          aria-label="Take it off the board"
          tooltip={
            <>
              Take it off the board
              <Kbd>{keyText('edit.delete')}</Kbd>
            </>
          }
          onClick={() => remove(item.id)}
        />
      </NodeToolbar>
      <StepsCard data={card} lookup={lookup} look={look} selected={selected} steppedIn={steppedIn} writing={writing} actions={actions} error={error} />
    </div>
  );
});
