import { createContext, memo, useContext, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type Edge, type EdgeProps } from '@xyflow/react';
import type { FlowEdge as FlowEdgeData, FlowEdgeTrigger, UpdateFlowEdgeParams } from '@agent-board/daemon/protocol';
import { Check, FileText, Play, Send, Zap, type LucideIcon } from 'lucide-react';
import { tokenNumber } from '../theme';
import { BarRow } from './items/ItemStyleBar';
import { LineStyleButtons } from './connectors/LineStyleButtons';
import { labelFits, type LabelSize, type LineRun } from './connectors/geometry';
import { useLine } from './connectors/line';
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
  /** Selects the edge alone, which opens its Edge rules. */
  select(id: string): void;
}

export const FlowEdgeActionsContext = createContext<FlowEdgeActions>({ send: () => {}, update: () => {}, approve: () => {}, drop: () => {}, select: () => {} });

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

/** The size of a flow edge's label: its pill, ending in a Send button when it has one. */
function labelSize(withSend: boolean): LabelSize {
  return {
    width: tokenNumber('--size-flow-label') + (withSend ? tokenNumber('--size-flow-send') : 0),
    height: tokenNumber('--size-flow-label-height'),
  };
}

/**
 * A flow edge's line and its label: coloured, labelled with what it carries and marked with its trigger (DecR R1), so
 * it reads as automation, unlike a neutral connector. The label is drawn in the edge's own SVG, after its line, so the
 * line never crosses it, and scales with the board. With `onTrigger` its trigger is a button, and with `onSend` the
 * label ends in a Send button.
 */
function FlowLine(props: {
  id: string;
  /** Its line, and where its label sits on it. */
  path: string;
  at: { x: number; y: number };
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
  /**
   * How long its line is, and the way it runs at its label: too short for the label to sit between its ends, measured
   * along it, the label collapses to a marker, its trigger in a dot, and shows on hover or focus. Without it,
   * the label always shows.
   */
  run?: LineRun;
  testId: string;
  onSend?: () => void;
  /** Opens its rules, from its collapsed marker by the keyboard (a click on it reaches the edge as one on its line does). */
  onOpen?: () => void;
}) {
  const { id, path } = props;
  const { x, y } = props.at;
  const { width, height } = labelSize(props.onSend !== undefined);
  const textWidth = tokenNumber('--size-flow-label');
  const sendWidth = width - textWidth;
  const Icon = props.mark.icon;
  const live = props.live === true;
  const collapsed = props.run !== undefined && !labelFits(props.run, labelSize(props.onSend !== undefined));
  // Collapsed, its label shows while the pointer is on its marker or the marker has focus.
  const [revealed, setRevealed] = useState(false);
  const markerRadius = height / 2 - 2;
  // Revealed, the label sits on top of its marker, touching it: the pointer reaches its Send button without leaving.
  const labelY = collapsed ? y - markerRadius - height / 2 : y;
  const shown = !collapsed || revealed;
  const note = props.note ?? props.delivered;
  const noteY = collapsed ? labelY - height / 2 - (height - 4) - tokenNumber('--space-1') : labelY + height / 2 + tokenNumber('--space-1');
  const revealTop = note === undefined ? labelY - height / 2 : noteY;
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
        data-collapsed={collapsed || undefined}
        {...(collapsed && {
          onMouseEnter: () => setRevealed(true),
          onMouseLeave: () => setRevealed(false),
          onFocus: () => setRevealed(true),
          onBlur: () => setRevealed(false),
        })}
      >
        {props.title !== undefined && <title>{props.title}</title>}
        {collapsed && revealed && (
          // Under the label and note it shows, down to the marker, so the pointer moving between them keeps them shown.
          <rect
            className="flow-edge-reveal"
            x={x - width / 2}
            y={revealTop}
            width={width}
            height={y - revealTop}
          />
        )}
        {collapsed && (
          <g
            className="flow-edge-marker"
            data-testid="flow-edge-marker"
            role="button"
            tabIndex={0}
            aria-label={`${props.label}: ${props.mark.name}`}
            transform={`translate(${x} ${y})`}
            {...(props.onOpen && pressed(props.onOpen))}
          >
            <circle className="flow-edge-trigger-dot" r={markerRadius} />
            <Icon className="flow-edge-trigger-icon" x={-6} y={-6} width={12} height={12} aria-hidden="true" />
          </g>
        )}
        {collapsed && props.onSend !== undefined && (
          <g
            className="flow-edge-send flow-edge-marker-send"
            data-testid="flow-edge-marker-send"
            role="button"
            tabIndex={0}
            aria-label="Send"
            transform={`translate(${x + markerRadius * 2 + 2} ${y})`}
            {...pressed(props.onSend)}
          >
            <circle className="flow-edge-send-fill" r={markerRadius} />
            <Send className="flow-edge-send-icon" x={-6} y={-6} width={12} height={12} aria-hidden="true" />
          </g>
        )}
        {shown && (
          <g className="flow-edge-pill-group" transform={`translate(${x - width / 2} ${labelY - height / 2})`}>
            <rect className="flow-edge-pill" width={width} height={height} rx={height / 2} />
            <g className="flow-edge-trigger" role="img" aria-label={props.mark.name}>
              <circle className="flow-edge-trigger-dot" cx={height / 2} cy={height / 2} r={markerRadius} />
              <Icon className="flow-edge-trigger-icon" x={height / 2 - 6} y={height / 2 - 6} width={12} height={12} aria-hidden="true" />
            </g>
            <text className="flow-edge-text" x={height + 6} y={height / 2} dominantBaseline="central">
              {props.label}
            </text>
            {props.onSend !== undefined && (
              // Collapsed, the marker's own Send is the one the keyboard reaches.
              <g className="flow-edge-send" role="button" tabIndex={collapsed ? -1 : 0} aria-hidden={collapsed || undefined} aria-label="Send" transform={`translate(${textWidth} 0)`} {...pressed(props.onSend)}>
                <rect className="flow-edge-send-fill" width={sendWidth - 2} height={height - 4} y={2} rx={(height - 4) / 2} />
                <Send className="flow-edge-send-icon" x={8} y={height / 2 - 6} width={12} height={12} aria-hidden="true" />
                <text className="flow-edge-send-text" x={24} y={height / 2} dominantBaseline="central">
                  send
                </text>
              </g>
            )}
          </g>
        )}
        {shown && note !== undefined && (
          // Collapsed, over the label: under it would cover the marker.
          <g
            className={props.note === undefined ? 'flow-edge-note flow-edge-delivered' : 'flow-edge-note'}
            data-testid={props.note === undefined ? 'flow-edge-delivered' : 'flow-edge-note'}
            transform={`translate(${x} ${noteY})`}
          >
            {props.note === undefined && <title>Click to see what it carried</title>}
            <rect className="flow-edge-note-fill" x={-tokenNumber('--size-flow-note') / 2} width={tokenNumber('--size-flow-note')} height={height - 4} rx={(height - 4) / 2} />
            <text className="flow-edge-note-text" y={(height - 4) / 2} textAnchor="middle" dominantBaseline="central">
              {note}
            </text>
          </g>
        )}
      </g>
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
  const [path, x, y] = getBezierPath(props);
  return <FlowLine id={props.id} path={path} at={{ x, y }} label="issue brief" trigger="auto" mark={BRIEF_MARK} testId="brief-edge" />;
});

export type AgentFlowEdgeType = Edge<{ edge: FlowEdgeData; live: boolean; madeByName?: string }, 'flow'>;

/**
 * A flow edge between two agents, labelled with what it carries (`plan.md`). Selected, its Edge rules
 * open, where its rules are set; a manual one has a Send button on its label too. Under its label it says when it is
 * paused, what a hand-off it holds waits for, that it has queued one, or else when it last delivered. One an agent
 * made is dashed. A hover over its label says who made it, and why its last delivery was skipped, if it was.
 * Selected, it can be bent, its ends moved to other sides of their tiles, and its style picked over its label
 *, as a connector's can.
 */
export const AgentFlowEdge = memo(function AgentFlowEdge(props: EdgeProps<AgentFlowEdgeType>) {
  const actions = useContext(FlowEdgeActionsContext);
  const { edge, madeByName } = props.data!;
  const selected = props.selected === true;
  const manual = edge.trigger === 'manual';
  const label = labelSize(manual);
  // The handles keep clear of its label, or of its marker (and the marker's Send) once the label is too long for it.
  const { shape, handles } = useLine(props, edge.style, edge, (geometry) => actions.update(edge.id, geometry), (run) =>
    labelFits(run, label) ? label : { width: manual ? label.height * 2 : label.height, height: label.height },
  );
  return (
    <>
      <FlowLine
        id={props.id}
        path={shape.path}
        at={shape.label}
        run={shape}
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
        onOpen={() => actions.select(edge.id)}
      />
      {selected && (
        <EdgeLabelRenderer>
          <div
            className="connector-bar nodrag nopan"
            style={{ transform: `translate(-50%, -100%) translate(${shape.label.x}px, ${shape.label.y - tokenNumber('--size-flow-label-height') / 2}px)` }}
          >
            <div role="toolbar" aria-label="Edge style" className="item-bar-rows">
              <BarRow>
                <LineStyleButtons current={edge.style} onPick={(style) => actions.update(edge.id, { style })} />
              </BarRow>
            </div>
          </div>
        </EdgeLabelRenderer>
      )}
      {selected && handles}
    </>
  );
});
