import { createContext, memo, useContext, useEffect, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type Edge, type EdgeProps } from '@xyflow/react';
import type { ConnectorSide, EdgePoint, FlowEdgeShape, FlowEdgeTrigger, UpdateFlowEdgeParams } from '@agent-board/daemon/protocol';
import { FileText, Send, Zap, type LucideIcon } from 'lucide-react';
import { useSimplified } from '../design';
import { tokenNumber } from '../theme';
import { BarRow } from './items/ItemStyleBar';
import { LineStyleButtons, RouteButton } from './connectors/LineStyleButtons';
import { lineShape, type LineEnds, type RoutePoint } from './connectors/geometry';
import { SIDES, useLine, useRoute } from './connectors/line';
import { edgeLabel, edgeTitle, type FlowRailData } from './flow-edges';
import { isLinkedPair, type Rail, type RailToken, type TokenSlot } from './rails';
import { tileSubject } from './tiles';

/** What a rail's token, or an edge's Edge rules, can ask the board to do. */
export interface FlowEdgeActions {
  /** Delivers the edge's payload now. */
  send(id: string): void;
  /** Changes the edge's rules: its trigger, payload, file or conditions. */
  update(id: string, changes: Omit<UpdateFlowEdgeParams, 'id'>): void;
  /** Whether `rail`'s `which` end can move onto `agent`'s tile: every edge on it can (`railMoveRefused`). */
  canMoveRail(rail: Rail, which: 'from' | 'to', agent: string): boolean;
  /** Moves `rail`'s `which` end onto `agent`, every edge on it, in `shape`: one undo step, once the daemon has them all. */
  moveRail(rail: Rail, which: 'from' | 'to', agent: string, shape: Pick<FlowEdgeShape, 'fromSide' | 'toSide' | 'points'>): void;
  /** Approves what one of its gates or scripts runs, as shown: its fingerprint, read in sender `from`'s worktree. */
  approve(id: string, command: string, fingerprint: string, from: string): void;
  /** Drops the hand-off it holds and the delivery it queued. */
  drop(id: string): void;
  /** Selects the edge alone, which opens its Edge rules. */
  select(id: string): void;
}

export const FlowEdgeActionsContext = createContext<FlowEdgeActions>({
  send: () => {},
  update: () => {},
  canMoveRail: () => false,
  moveRail: () => {},
  approve: () => {},
  drop: () => {},
  select: () => {},
});

/** Runs `act` for a click or Enter on one of a token's buttons, without selecting the rail under it. */
const pressed = (act: () => void) => ({
  onClick: (event: MouseEvent) => {
    event.stopPropagation();
    act();
  },
  onKeyDown: (event: KeyboardEvent) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    event.stopPropagation();
    act();
  },
});

/**
 * R1's "issue brief" flow edge, from an issue card to an agent working on its issue: coloured, labelled with
 * what it carries and marked with its trigger (DecR R1), so it reads as automation, unlike a neutral connector. The
 * label is drawn in the edge's own SVG, after its line, so the line never crosses it, and scales with the board. It
 * only shows the link: it can't be selected, moved or deleted.
 */
const BRIEF_MARK: { icon: LucideIcon; name: string; trigger: FlowEdgeTrigger } = { icon: Zap, name: 'Briefs the agent when it starts', trigger: 'auto' };

/** The issue-card line between `ends`: `plain`, the curve React Flow draws with its middle `middle`, or a curve through the corners of `route`. The pill sits on the middle of the line drawn. */
export function briefLine(ends: LineEnds, plain: string, middle: EdgePoint, route?: readonly RoutePoint[]): { path: string; pill: EdgePoint } {
  if (route === undefined) return { path: plain, pill: middle };
  const shape = lineShape('curved', ends, route.slice(1, -1), undefined, true);
  return { path: shape.path, pill: shape.label };
}

export const BriefEdge = memo(function BriefEdge(props: EdgeProps) {
  const [plain, x, y] = getBezierPath(props);
  const ends: LineEnds = {
    source: { x: props.sourceX, y: props.sourceY },
    sourceSide: SIDES[props.sourcePosition],
    target: { x: props.targetX, y: props.targetY },
    targetSide: SIDES[props.targetPosition],
  };
  // Round the objects between the issue card and the agent, as a curved arrow goes (`useRoute`).
  const route = useRoute(true, ends, plain, props.source, props.target);
  const { path, pill } = briefLine(ends, plain, { x, y }, route);
  const width = tokenNumber('--size-flow-label');
  const height = tokenNumber('--size-flow-label-height');
  const Icon = BRIEF_MARK.icon;
  return (
    <>
      <BaseEdge id={props.id} path={path} className="flow-edge" markerEnd="url(#flow-arrow)" data-routed={route !== undefined || undefined} />
      <g className="flow-edge-label" data-testid="brief-edge" data-trigger={BRIEF_MARK.trigger}>
        <g className="flow-edge-pill-group" transform={`translate(${pill.x - width / 2} ${pill.y - height / 2})`}>
          <rect className="flow-edge-pill" width={width} height={height} rx={height / 2} />
          <g className="flow-edge-trigger" role="img" aria-label={BRIEF_MARK.name}>
            <circle className="flow-edge-trigger-dot" cx={height / 2} cy={height / 2} r={height / 2 - 2} />
            <Icon className="flow-edge-trigger-icon" x={height / 2 - 6} y={height / 2 - 6} width={12} height={12} aria-hidden="true" />
          </g>
          <text className="flow-edge-text" x={height + 6} y={height / 2} dominantBaseline="central">
            issue brief
          </text>
        </g>
      </g>
    </>
  );
});

export type AgentFlowEdgeType = Edge<FlowRailData, 'flow'>;

/** The agent whose tile is node `nodeId`, if it is an agent's. */
function agentOf(nodeId: string): string | undefined {
  const subject = tileSubject(nodeId);
  return subject?.kind === 'agent' ? subject.id : undefined;
}

/** Which way from an end of a rail its token lies: away from the tile, along the side's outward normal. */
const OUTWARD: Record<ConnectorSide, EdgePoint> = { left: { x: -1, y: 0 }, right: { x: 1, y: 0 }, top: { x: 0, y: -1 }, bottom: { x: 0, y: 1 } };

/**
 * The edges between two agents as one rail: a faint line with no arrowheads when they hand work both
 * ways, or with a small arrow at the receiving end when only one way, and the latest document riding it as a token at
 * the end of whoever has it (`railToken`). A click on the rail or its token selects the edge the token is from (or the
 * one of its edges already selected), which opens its Edge rules; a token waiting for Send has Send on it (Classic
 * only: the Simplified design sends from Edge rules), and slides to the other end as it goes. Selected, the rail can be bent, its ends moved to other sides of their tiles or onto
 * other agents' (every edge on it moving with them), and its style picked, as a connector's can: the edge made first
 * keeps its shape. An end on no side the user picked faces
 * the other tile.
 */
export const AgentFlowEdge = memo(function AgentFlowEdge(props: EdgeProps<AgentFlowEdgeType>) {
  const actions = useContext(FlowEdgeActionsContext);
  const { rail, token, live, madeByName, slot } = props.data!;
  const shaped = rail.edges[0]!;
  const selected = props.selected === true;
  const pair = isLinkedPair(rail);
  const { shape, ends, handles, routed } = useLine(props, shaped.style, shaped, (geometry) => actions.update(shaped.id, geometry), undefined, {
    // Either end goes onto another agent's tile, where every edge on it can go: it hands off there instead.
    canEndOn: (nodeId, which) => {
      const agent = agentOf(nodeId);
      return agent !== undefined && actions.canMoveRail(rail, which, agent);
    },
    onMoved: (which, nodeId, geometry) => {
      const agent = agentOf(nodeId);
      if (agent !== undefined) actions.moveRail(rail, which, agent, geometry);
    },
  });
  // The token's end is its edge's sender or receiver, which is the rail's start or end as its edge runs with it or back.
  const atStart = (token.end === 'from') === (token.edge.from === rail.from);
  const [end, side] = atStart ? [ends.source, ends.sourceSide] : [ends.target, ends.targetSide];
  const gap = tokenNumber('--rail-token-gap');
  const apart = slotOffset(slot, side, tokenNumber('--rail-token-step'));
  const at = { x: end.x + OUTWARD[side].x * gap, y: end.y + OUTWARD[side].y * gap + apart };
  const sliding = useSlide(atStart, token.state === 'sending');
  const capRadius = tokenNumber('--rail-cap-radius');
  // Too short a rail for its token to lie along: it shows only its mark (and Send, in Classic), the rest on hover or focus.
  const compact = shape.length < tokenNumber('--rail-token-room');
  return (
    <>
      {(selected || live) && <path d={shape.path} className="connector-halo" />}
      <BaseEdge
        id={props.id}
        path={shape.path}
        className={token.state === 'next' ? 'flow-edge flow-rail flow-rail-faint' : 'flow-edge flow-rail'}
        markerEnd={pair ? undefined : 'url(#rail-arrow)'}
        data-testid="flow-edge"
        data-pair={pair || undefined}
        data-routed={routed || undefined}
      />
      <circle className="flow-rail-cap" cx={ends.source.x} cy={ends.source.y} r={capRadius} />
      {pair && <circle className="flow-rail-cap" cx={ends.target.x} cy={ends.target.y} r={capRadius} />}
      <EdgeLabelRenderer>
        <RailTokenChip
          token={token}
          at={at}
          side={side}
          sliding={sliding}
          compact={compact}
          selected={selected}
          title={edgeTitle(token.edge, madeByName)}
          onOpen={() => actions.select(token.edge.id)}
          onSend={() => actions.send(token.edge.id)}
        />
        {selected && (
          <div
            className="connector-bar nodrag nopan"
            style={{ transform: `translate(-50%, -100%) translate(${shape.label.x}px, ${shape.label.y - tokenNumber('--space-2')}px)` }}
          >
            <div role="toolbar" aria-label="Edge style" className="item-bar-rows">
              <BarRow>
                <LineStyleButtons current={shaped.style} onPick={(style) => actions.update(shaped.id, { style })} />
                <RouteButton style={shaped.style} bent={shaped.points.length > 0} onRoute={() => actions.update(shaped.id, { points: [] })} />
              </BarRow>
            </div>
          </div>
        )}
      </EdgeLabelRenderer>
      {selected && handles}
    </>
  );
});

/**
 * How far down a token is moved from its end of the rail by its slot among those off the same side of its tile: those
 * off a left or right side are spread along it, centred on the end; those off the top or bottom stack away from it.
 */
function slotOffset({ index, count }: TokenSlot, side: ConnectorSide, step: number): number {
  if (side === 'left' || side === 'right') return (index - (count - 1) / 2) * step;
  return (side === 'bottom' ? index : -index) * step;
}

/**
 * Whether a rail's token is sliding to its other end: from when it moves there on its way (`going`), for one trip.
 * Otherwise it moves with its tiles at once, as a dragged tile does: an ease there would trail behind them.
 */
function useSlide(atStart: boolean, going: boolean): boolean {
  const [slide, setSlide] = useState({ atStart, sliding: false });
  if (slide.atStart !== atStart) setSlide({ atStart, sliding: going });
  useEffect(() => {
    if (!slide.sliding) return;
    const timer = setTimeout(() => setSlide((current) => ({ ...current, sliding: false })), tokenNumber('--motion-handoff'));
    return () => clearTimeout(timer);
  }, [slide]);
  return slide.sliding;
}

/** What a token's state says to a screen reader, after the document's name. */
const STATE_NAMES: Record<RailToken['state'], string> = {
  sending: 'on its way',
  held: 'held',
  queued: 'queued',
  waiting: 'waiting for Send',
  delivered: 'delivered',
  failed: 'skipped',
  next: 'next',
};

/**
 * The document on a rail: its name, its round on a linked pair (R2) or a held one's passing conditions (1/2),
 * Send while it waits for it, and the line under it (`delivered 14:31`, `held until CI green`). It sits `at` the end
 * of whoever has it, off the `side` of that tile, and slides there while `sliding` (not under reduced motion). On a
 * rail too short for it (`compact`), only its mark, round and (in Classic) Send show until it is hovered or focused.
 */
function RailTokenChip(props: {
  token: RailToken;
  at: EdgePoint;
  side: ConnectorSide;
  sliding: boolean;
  compact: boolean;
  selected: boolean;
  title?: string;
  onOpen(): void;
  onSend(): void;
}) {
  const { token, at } = props;
  const simplified = useSimplified();
  const name = edgeLabel(token.edge);
  return (
    <div
      className="rail-token nodrag nopan"
      data-testid="rail-token"
      data-state={token.state}
      data-side={props.side}
      data-sliding={props.sliding || undefined}
      data-compact={props.compact || undefined}
      data-selected={props.selected || undefined}
      style={{ transform: `translate(${at.x}px, ${at.y}px)` }}
    >
      <div className="rail-token-body" title={props.title}>
        <span className="rail-token-chip">
          <button type="button" className="rail-token-open" aria-label={`${name}: ${simplified && token.state === 'waiting' ? 'waiting' : STATE_NAMES[token.state]}`} {...pressed(props.onOpen)}>
            <FileText className="rail-token-icon" aria-hidden="true" />
            <span className="rail-token-name">{name}</span>
            {token.round !== undefined && <span className="rail-token-count">R{token.round}</span>}
            {token.passing !== undefined && (
              <span className="rail-token-count" title={`${token.passing} of its conditions pass`}>
                {token.passing}
              </span>
            )}
          </button>
          {token.state === 'waiting' && !simplified && (
            <button type="button" className="rail-token-send" data-testid="rail-token-send" {...pressed(props.onSend)}>
              <Send aria-hidden="true" />
              send
            </button>
          )}
        </span>
        {token.note !== undefined && (
          <span className="rail-token-note" data-testid="rail-token-note">
            {token.note}
          </span>
        )}
      </div>
    </div>
  );
}
