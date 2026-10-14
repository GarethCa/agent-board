import { createContext, memo, useContext, type KeyboardEvent, type MouseEvent } from 'react';
import { BaseEdge, getBezierPath, type Edge, type EdgeProps } from '@xyflow/react';
import type { FlowEdge as FlowEdgeData, FlowEdgeTrigger, UpdateFlowEdgeParams } from '@agent-board/daemon/protocol';
import { Check, FileText, Play, Send, Zap, type LucideIcon } from 'lucide-react';
import { tokenNumber } from '../theme';
import { deliveredLabel, edgeLabel, edgeTitle, heldLabel } from './flow-edges';

/** What a flow edge's label, or its Edge rules, can ask the board to do. */
export interface FlowEdgeActions {
  /** Delivers the edge's payload now. */
  send(id: string): void;
  /** Changes the edge's rules: its trigger, payload, file or conditions. */
  update(id: string, changes: Omit<UpdateFlowEdgeParams, 'id'>): void;
  /** Approves what one of its gates or scripts runs, as shown: its fingerprint. */
  approve(id: string, command: string, fingerprint: string): void;
  /** Drops the hand-off it holds and the delivery it queued. */
  drop(id: string): void;
}

export const FlowEdgeActionsContext = createContext<FlowEdgeActions>({ send: () => {}, update: () => {}, approve: () => {}, drop: () => {} });

/** An agent edge's trigger mark (FlowDraw, FlowRules): a tick for "when it's done", a play for "when sent". */
const TRIGGER_MARKS: Record<FlowEdgeTrigger, { icon: LucideIcon; name: string }> = {
  auto: { icon: Check, name: 'Delivers by itself when its agent is done' },
  manual: { icon: Play, name: 'Delivers when sent' },
};

/** Runs `act` for a click or Enter on one of a label's buttons, without selecting the edge under it. */
const pressed = (act: () => void) => ({
  onClick: (event: MouseEvent) => {
    event.stopPropagation();
    act();
  },
  onKeyDown: (event: KeyboardEvent) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    act();
  },
});

/**
 * A flow edge's line and its label: coloured, labelled with what it carries and marked with its trigger (DecR R1), so
 * it reads as automation, unlike a neutral connector. The label is drawn in the edge's own SVG, after its line, so the
 * line never crosses it, and scales with the board. With `onTrigger` its trigger is a button, and with `onSend` the
 * label ends in a Send button.
 */
function FlowLine(props: {
  edge: Pick<EdgeProps, 'id' | 'sourceX' | 'sourceY' | 'targetX' | 'targetY' | 'sourcePosition' | 'targetPosition'>;
  label: string;
  trigger: FlowEdgeTrigger;
  /** The trigger's mark, and what it says. */
  mark: { icon: LucideIcon; name: string };
  selected?: boolean;
  /** A hand-off is going along it: it shows its payload travelling to the other end. */
  live?: boolean;
  /** What a hover over the label says, such as why its last delivery was skipped. */
  title?: string;
  /** A word under its label: what a hand-off it holds waits for (`held until CI green`), `paused` or `queued`. */
  note?: string;
  /**
   * With no note, a chip under its label saying when it last delivered (`delivered 14:02`). Clicking it, as anywhere on
   * the edge, selects it: its Edge rules show what it carried.
   */
  delivered?: string;
  /** An agent made it (an orchestrator): its line is dashed. */
  agentMade?: boolean;
  testId: string;
  onSend?: () => void;
}) {
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition } = props.edge;
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  const height = tokenNumber('--size-flow-label-height');
  const textWidth = tokenNumber('--size-flow-label');
  const sendWidth = props.onSend === undefined ? 0 : tokenNumber('--size-flow-send');
  const width = textWidth + sendWidth;
  const Icon = props.mark.icon;
  const live = props.live === true;
  return (
    <>
      {(props.selected === true || live) && <path d={path} className="connector-halo" />}
      <BaseEdge id={id} path={path} className={props.agentMade === true ? 'flow-edge flow-edge-agent-made' : 'flow-edge'} markerEnd="url(#flow-arrow)" />
      {live && <path d={path} className="flow-edge-flowing" />}
      <g
        className="flow-edge-label"
        data-testid={props.testId}
        data-trigger={props.trigger}
        data-live={live || undefined}
        data-selected={props.selected === true || undefined}
        data-agent-made={props.agentMade || undefined}
        transform={`translate(${labelX - width / 2} ${labelY - height / 2})`}
      >
        {props.title !== undefined && <title>{props.title}</title>}
        <rect className="flow-edge-pill" width={width} height={height} rx={height / 2} />
        <g className="flow-edge-trigger" role="img" aria-label={props.mark.name}>
          <circle className="flow-edge-trigger-dot" cx={height / 2} cy={height / 2} r={height / 2 - 2} />
          <Icon className="flow-edge-trigger-icon" x={height / 2 - 6} y={height / 2 - 6} width={12} height={12} aria-hidden="true" />
        </g>
        <text className="flow-edge-text" x={height + 6} y={height / 2} dominantBaseline="central">
          {props.label}
        </text>
        {props.onSend !== undefined && (
          <g className="flow-edge-send" role="button" tabIndex={0} aria-label="Send" transform={`translate(${textWidth} 0)`} {...pressed(props.onSend)}>
            <rect className="flow-edge-send-fill" width={sendWidth - 2} height={height - 4} y={2} rx={(height - 4) / 2} />
            <Send className="flow-edge-send-icon" x={8} y={height / 2 - 6} width={12} height={12} aria-hidden="true" />
            <text className="flow-edge-send-text" x={24} y={height / 2} dominantBaseline="central">
              send
            </text>
          </g>
        )}
      </g>
      {(props.note ?? props.delivered) !== undefined && (
        <g
          className={props.note === undefined ? 'flow-edge-note flow-edge-delivered' : 'flow-edge-note'}
          data-testid={props.note === undefined ? 'flow-edge-delivered' : 'flow-edge-note'}
          transform={`translate(${labelX} ${labelY + height / 2 + tokenNumber('--space-1')})`}
        >
          {props.note === undefined && <title>Click to see what it carried</title>}
          <rect className="flow-edge-note-fill" x={-tokenNumber('--size-flow-note') / 2} width={tokenNumber('--size-flow-note')} height={height - 4} rx={(height - 4) / 2} />
          <text className="flow-edge-note-text" y={(height - 4) / 2} textAnchor="middle" dominantBaseline="central">
            {props.note ?? props.delivered}
          </text>
        </g>
      )}
      {/* Over the label, which it passes on its way. */}
      {live && <FlowPayload path={path} label={props.label} />}
    </>
  );
}

/**
 * A hand-off on its way (FlowRules): the payload, as a chip, travelling along the edge's `path` from its start to its
 * end, over and over while it lasts. Still, it isn't drawn: the halo and the pills say it all.
 */
function FlowPayload({ path, label }: { path: string; label: string }) {
  const height = tokenNumber('--size-flow-payload-height');
  const width = tokenNumber('--size-flow-payload');
  return (
    <g className="flow-payload" data-testid="flow-payload" style={{ offsetPath: `path('${path}')` }} aria-hidden="true">
      <g transform={`translate(${-width / 2} ${-height / 2})`}>
        <rect className="flow-payload-fill" width={width} height={height} rx={tokenNumber('--radius-lg')} />
        <FileText className="flow-payload-icon" x={6} y={height / 2 - 7} width={14} height={14} />
        <text className="flow-payload-text" x={24} y={height / 2} dominantBaseline="central">
          {label}
        </text>
      </g>
    </g>
  );
}

/**
 * R1's "issue brief" flow edge, from an issue card to an agent working on its issue. It only shows the link:
 * it can't be selected, moved or deleted.
 */
const BRIEF_MARK = { icon: Zap, name: 'Briefs the agent when it starts' };

export const BriefEdge = memo(function BriefEdge(props: EdgeProps) {
  return <FlowLine edge={props} label="issue brief" trigger="auto" mark={BRIEF_MARK} testId="brief-edge" />;
});

export type AgentFlowEdgeType = Edge<{ edge: FlowEdgeData; live: boolean; madeByName?: string }, 'flow'>;

/**
 * A flow edge between two agents, labelled with what it carries (`plan.md`). Selected, its Edge rules
 * open, where its rules are set; a manual one has a Send button on its label too. Under its label it says when it is
 * paused, what a hand-off it holds waits for, that it has queued one, or else when it last delivered. One an agent
 * made is dashed. A hover over its label says who made it, and why its last delivery was skipped, if it was.
 */
export const AgentFlowEdge = memo(function AgentFlowEdge(props: EdgeProps<AgentFlowEdgeType>) {
  const actions = useContext(FlowEdgeActionsContext);
  const { edge, madeByName } = props.data!;
  return (
    <FlowLine
      edge={props}
      label={edgeLabel(edge)}
      note={edge.paused ? 'paused' : (heldLabel(edge) ?? (edge.queued === null ? undefined : 'queued'))}
      delivered={deliveredLabel(edge, new Date())}
      agentMade={edge.madeBy !== null}
      trigger={edge.trigger}
      mark={TRIGGER_MARKS[edge.trigger]}
      selected={props.selected}
      live={props.data!.live}
      title={edgeTitle(edge, madeByName)}
      testId="flow-edge"
      onSend={edge.trigger === 'manual' ? () => actions.send(edge.id) : undefined}
    />
  );
});
