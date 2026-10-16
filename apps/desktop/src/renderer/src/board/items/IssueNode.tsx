import { createContext, memo, useContext } from 'react';
import { NodeResizer, NodeToolbar, Position, type NodeProps } from '@xyflow/react';
import { ExternalLink, Play, Trash2 } from 'lucide-react';
import { issueCardData, shortIssueId, type BoardItem, type IssueCardData } from '@agent-board/daemon/protocol';
import { Button, IconButton, Kbd, Tag } from '../../ui';
import { ItemActionsContext, type ItemNodeType } from './items';
import { keyText } from '../../keys/registry';

export const ISSUE_CARD_SIZE = { width: 240, height: 112 };
const MIN_ISSUE_CARD_SIZE = { width: 180, height: 84 };

/** What an issue card can do on the board: start an agent from its issue. */
export interface IssueCardActions {
  /** Why no agent can start from the card now (its zone is unbound, or cloning), or undefined if one can. */
  whyNoStart(item: BoardItem): string | undefined;
  /** Whether an agent on the board is linked to the card's issue: its brief edge shows that, so Start agent hides. */
  hasAgent(card: IssueCardData): boolean;
  /** Starts an agent from the card's issue, in the card's zone. */
  start(item: BoardItem): void;
}

export const IssueCardContext = createContext<IssueCardActions>({
  whyNoStart: () => 'Not on a board',
  hasAgent: () => false,
  start: () => {},
});

/**
 * An issue card: a tracker issue as it was when picked, with its ID, title and state. Until an agent works on
 * it, it offers to start one; then the "issue brief" edge joins it to the agent.
 */
export const IssueNode = memo(function IssueNode({ data, selected, dragging }: NodeProps<ItemNodeType>) {
  const { update, remove, openLink } = useContext(ItemActionsContext);
  const cards = useContext(IssueCardContext);
  const { item } = data;
  const issue = issueCardData(item.data);
  if (issue === undefined) return null;
  const whyNot = cards.whyNoStart(item);
  return (
    <div className="issue-card" data-testid="issue-card" data-issue={issue.id} data-zone={item.zoneId ?? ''}>
      <NodeResizer
        isVisible={selected}
        color="var(--sticky-resizer)"
        minWidth={MIN_ISSUE_CARD_SIZE.width}
        minHeight={MIN_ISSUE_CARD_SIZE.height}
        onResizeEnd={(_event, { x, y, width, height }) => update({ id: item.id, x, y, width, height })}
      />
      <NodeToolbar isVisible={selected && !dragging} position={Position.Top} className="sticky-toolbar">
        <IconButton icon={<ExternalLink />} size="sm" aria-label="Open issue" tooltip="Open the issue" onClick={() => openLink(issue.url)} />
        <IconButton
          icon={<Trash2 />}
          size="sm"
          aria-label="Delete issue card"
          tooltip={
            <>
              Delete issue card
              <Kbd>{keyText('edit.delete')}</Kbd>
            </>
          }
          onClick={() => remove(item.id)}
        />
      </NodeToolbar>
      <div className="issue-card-head">
        <span className="issue-card-id">{shortIssueId(issue)}</span>
        {issue.state !== '' && <Tag className="issue-card-state">{issue.state}</Tag>}
      </div>
      <div className="issue-card-title" title={issue.title}>
        {issue.title}
      </div>
      {!cards.hasAgent(issue) && (
        <Button
          size="sm"
          className="issue-card-start nodrag"
          icon={<Play />}
          // Not `disabled`, which would hide the tooltip saying why.
          aria-disabled={whyNot !== undefined}
          title={whyNot}
          onClick={() => whyNot === undefined && cards.start(item)}
        >
          Start agent
        </Button>
      )}
    </div>
  );
});
