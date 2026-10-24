import { createContext, memo, useContext, useEffect, useState } from 'react';
import { NodeToolbar, Position, useStore, type NodeProps } from '@xyflow/react';
import { Trash2 } from 'lucide-react';
import type { Agent, PlanCardData } from '@agent-board/daemon/protocol';
import { useBoardCommands } from '../commands';
import { HarnessMark } from '../HarnessMark';
import { tileNodeId } from '../tiles';
import { Button, IconButton, Kbd, Popover } from '../../ui';
import { keyText } from '../../keys/registry';
import { PlanDecisionBar } from '../../plan/PlanTab';
import { planCardMeta, planCardStamp } from '../../plan/plan-view';
import { ItemActionsContext, useOnlySelected, type ItemNodeType } from './items';

/** What a plan card reads of the board: its agent as it is now, and how to open the agent's Plan tab. */
export interface PlanCards {
  /** The agent, while it is on the board. */
  find(sessionId: string): Agent | undefined;
  /** Opens the agent's Plan tab in its window. */
  open(agent: Agent): void;
}

export const PlanCardsContext = createContext<PlanCards>({ find: () => undefined, open: () => {} });

/** A plan card's data, as it was saved. */
const planCardData = (data: Record<string, unknown>): PlanCardData => data as unknown as PlanCardData;

/**
 * An agent's plan on the board: a page with a PLAN tag, its file, its title and version, tethered to its agent, showing
 * the agent's latest plan as it is now. While the agent waits on it, Review plan opens the decision the inbox has
 * (comments, Reject, Request changes, Approve) beside the card; once decided, a stamp says how. The plan is read and
 * edited in its Plan tab (Open, or double-click), never on the card.
 */
export const PlanNode = memo(function PlanNode({ data, selected: picked, dragging }: NodeProps<ItemNodeType>) {
  const selected = useOnlySelected(picked);
  const { remove } = useContext(ItemActionsContext);
  const cards = useContext(PlanCardsContext);
  const { focusSession } = useBoardCommands();
  const [reviewing, setReviewing] = useState(false);
  const { item } = data;
  const card = planCardData(item.data);
  const agent = cards.find(card.agent.sessionId);
  const plan = agent?.plan ?? null;
  const tileShown = useStore((state) => state.nodeLookup.has(tileNodeId('agent', card.agent.sessionId)));
  const stamp = plan === null ? undefined : planCardStamp(plan);
  const open = () => agent !== undefined && cards.open(agent);
  const waiting = plan !== null && plan.decision === null;
  // Decided, the review goes: the agent's next version waits with it closed.
  useEffect(() => {
    if (!waiting) setReviewing(false);
  }, [waiting]);

  return (
    <div
      className="doc-card plan-card"
      data-testid="plan-card"
      data-tone={stamp?.tone}
      data-outcome={plan?.decision?.outcome ?? (plan === null ? undefined : 'pending')}
      data-gone={plan === null || undefined}
      onDoubleClick={(event) => {
        // Not a new note on the board behind it.
        event.stopPropagation();
        open();
      }}
    >
      <NodeToolbar isVisible={selected && !dragging} position={Position.Top} className="sticky-toolbar">
        <IconButton
          icon={<Trash2 />}
          size="sm"
          aria-label="Take it off the board"
          tooltip={
            <>
              Take it off the board; the plan stays in its agent’s Plan tab
              <Kbd>{keyText('edit.delete')}</Kbd>
            </>
          }
          onClick={() => remove(item.id)}
        />
      </NodeToolbar>
      <div className="doc-card-head">
        <span className="doc-card-type plan-card-type">PLAN</span>
        <span className="doc-card-file">{plan?.path?.split(/[\\/]/).at(-1) ?? ''}</span>
        {stamp !== undefined && (
          <span className="plan-card-stamp" data-testid="plan-card-stamp" data-tone={stamp.tone}>
            {stamp.label}
          </span>
        )}
      </div>
      <div className="doc-card-title plan-card-title">{plan?.title ?? card.title}</div>
      <div className="plan-card-meta" data-testid="plan-card-meta">
        {plan === null ? 'Its plans are gone with it' : planCardMeta(plan)}
      </div>
      <div className="doc-card-foot">
        <button
          type="button"
          className="doc-card-agent nodrag"
          title={tileShown ? 'Select its tile' : `${card.agent.name} is no longer on the board`}
          disabled={!tileShown}
          onClick={() => focusSession(card.agent.sessionId)}
        >
          <HarnessMark harness={card.agent.harness} className="doc-card-mark" />
          <span>{card.agent.name}</span>
        </button>
        {agent !== undefined && waiting ? (
          <Popover
            aria-label={`Review ${agent.name}'s plan`}
            open={reviewing}
            onOpenChange={setReviewing}
            side="right"
            className="plan-card-review"
            content={
              <div className="plan-card-review-body" data-testid="plan-card-review">
                <div className="plan-card-review-head">
                  Plan v{plan.version} · {plan.title}
                </div>
                <PlanDecisionBar agent={agent} plan={plan} compact />
                <button
                  type="button"
                  className="plan-card-edit"
                  onClick={() => {
                    setReviewing(false);
                    open();
                  }}
                >
                  {plan.format === 'markdown' ? '✎ Edit in the Plan tab · Open ↗' : 'Open ↗'}
                </button>
              </div>
            }
          >
            <Button size="sm" variant="primary" className="plan-card-review-button nodrag" data-testid="plan-card-review-button">
              Review plan ▸
            </Button>
          </Popover>
        ) : (
          <button type="button" className="doc-card-open nodrag" disabled={agent === undefined || plan === null} onClick={open}>
            Open ↗
          </button>
        )}
      </div>
    </div>
  );
});
