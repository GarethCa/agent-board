// Flow edges: the daemon's edges between agents, each drawn from one tile's square out port to the other's in
// port, in the flow look the "issue brief" edge has.
import { createContext } from 'react';
import type { Edge } from '@xyflow/react';
import { DEFAULT_PAYLOAD_PATHS, type FlowCondition, type FlowEdge, type FlowEdgeEvent, type UpdateFlowEdgeParams } from '@agent-board/daemon/protocol';
import type { FlowEdgeChange } from '../../../preload/api';
import { whenLabel } from './schedule';
import { tileNodeId } from './tiles';

export const FLOW_EDGE_TYPE = 'flow';
const FLOW_EDGE_PREFIX = 'flow:';
/** The square ports an agent's tile has: a flow leaves from the out port and arrives at the in port. */
export const FLOW_PORTS = { out: 'flow-out', in: 'flow-in' } as const;
/** Over the nodes, like connectors. */
const FLOW_Z_INDEX = 3;

export const isFlowEdge = (edge: Pick<Edge, 'id'>): boolean => edge.id.startsWith(FLOW_EDGE_PREFIX);
export const flowEdgeIdOf = (edge: Pick<Edge, 'id'>): string => edge.id.slice(FLOW_EDGE_PREFIX.length);
/** Whether a drag started on a tile's flow port, so draws a flow edge, not a connector. */
export const isFlowPort = (handleId: string | null | undefined): boolean => handleId === FLOW_PORTS.out || handleId === FLOW_PORTS.in;

/**
 * The edges for `edges`, leaving out any whose agent's tile isn't on the board (`nodeIds`): the daemon deletes an edge
 * with its agent, and tells nobody. `names` are the agents' names, by session, for who made an edge an agent made.
 */
export function flowEdges(
  edges: readonly FlowEdge[],
  nodeIds: ReadonlySet<string>,
  selected: ReadonlySet<string>,
  live: ReadonlySet<string> = new Set(),
  names: ReadonlyMap<string, string> = new Map(),
): Edge<{ edge: FlowEdge; live: boolean; madeByName?: string }>[] {
  return edges
    .filter((edge) => nodeIds.has(tileNodeId('agent', edge.from)) && nodeIds.has(tileNodeId('agent', edge.to)))
    .map((edge) => ({
      id: `${FLOW_EDGE_PREFIX}${edge.id}`,
      type: FLOW_EDGE_TYPE,
      source: tileNodeId('agent', edge.from),
      sourceHandle: FLOW_PORTS.out,
      target: tileNodeId('agent', edge.to),
      targetHandle: FLOW_PORTS.in,
      selected: selected.has(edge.id),
      zIndex: FLOW_Z_INDEX,
      data: { edge, live: live.has(edge.id), madeByName: edge.madeBy === null ? undefined : names.get(edge.madeBy) },
    }));
}

/**
 * Which edges show a hand-off going along them at `now`: each delivering one, and each that started delivering less
 * than `hold` ms ago and delivered, so a delivery over in an instant is still seen. `since` is when each started, as the last call
 * returned it; `wakeIn` is how soon to ask again, while one is held.
 */
export function liveHandoffs(
  edges: readonly FlowEdge[],
  since: ReadonlyMap<string, number>,
  now: number,
  hold: number,
): { live: Set<string>; since: Map<string, number>; wakeIn?: number } {
  const live = new Set<string>();
  const started = new Map<string, number>();
  let wakeIn: number | undefined;
  for (const edge of edges) {
    const at = since.get(edge.id) ?? (edge.delivering ? now : undefined);
    if (at === undefined) continue;
    const left = hold - (now - at);
    // Over, or skipped: a skip shows nothing travelling, as nothing arrives.
    if (!edge.delivering && (left <= 0 || edge.lastDelivery?.delivered === false)) continue;
    live.add(edge.id);
    started.set(edge.id, at);
    if (!edge.delivering) wakeIn = Math.min(wakeIn ?? left, left);
  }
  return { live, since: started, wakeIn };
}

/** The agents handing off along a live edge, and those receiving along one, by session id. */
export interface HandoffEnds {
  sending: ReadonlySet<string>;
  receiving: ReadonlySet<string>;
}

export const HandoffsContext = createContext<HandoffEnds>({ sending: new Set(), receiving: new Set() });

/** The agents handing off along a live edge, and those receiving along one. */
export function handoffEnds(edges: readonly FlowEdge[], live: ReadonlySet<string>): HandoffEnds {
  const going = edges.filter((edge) => live.has(edge.id));
  return { sending: new Set(going.map((edge) => edge.from)), receiving: new Set(going.map((edge) => edge.to)) };
}

/** `edges` with a change applied: an edge added, replaced by its id, or dropped. */
export function withFlowEdgeChange(edges: readonly FlowEdge[], change: FlowEdgeChange): FlowEdge[] {
  if (change.type === 'flowEdge.removed') return edges.filter((edge) => edge.id !== change.id);
  const index = edges.findIndex((known) => known.id === change.edge.id);
  return index < 0 ? [...edges, change.edge] : edges.with(index, change.edge);
}

/** The most characters an edge's label shows of a file's name. */
const LABEL_CHARACTERS = 15;

/**
 * What an edge's label says it carries (BRIEF: "labelled with what they carry, e.g. `plan.md`"): its final message, or
 * its file by its own name, shortened in the middle to fit, keeping its extension.
 */
export function edgeLabel(edge: Pick<FlowEdge, 'payload' | 'path'>): string {
  if (edge.payload === 'final-message' || edge.path === null) return 'final message';
  const name = edge.path.split(/[\\/]/).at(-1)!;
  if (name.length <= LABEL_CHARACTERS) return name;
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 && name.length - dot <= 6 ? name.slice(dot) : '';
  return `${name.slice(0, LABEL_CHARACTERS - extension.length - 1)}…${extension}`;
}

/** A condition as the Edge rules list it. */
export function conditionName(condition: FlowCondition): string {
  switch (condition.kind) {
    case 'gate-green':
      return 'Only if gate green';
    case 'pr-checks':
      return 'Only if PR checks pass';
    case 'issue-label':
      return `Issue has label ${condition.label}`;
    case 'script':
      return `Script passes: ${condition.command}`;
  }
}

/** What a condition waits for, as a held edge says it. */
function waitsFor(condition: FlowCondition): string {
  switch (condition.kind) {
    case 'gate-green':
      return 'gate green';
    case 'pr-checks':
      return 'CI green';
    case 'issue-label':
      return `label ${condition.label}`;
    case 'script':
      return 'script passes';
  }
}

/**
 * What a held edge's mark says it waits for (FlowRules: "held until CI green"), or why it is held before its
 * conditions have been checked again since a restart; undefined when it holds nothing.
 */
export function heldLabel(edge: Pick<FlowEdge, 'held' | 'conditions' | 'checks'>): string | undefined {
  if (edge.held === null) return undefined;
  const failed = edge.checks.find((check) => check?.passed === false);
  if (failed?.needsApproval === true) return 'held until you approve';
  const condition = failed === undefined ? undefined : edge.conditions[edge.checks.indexOf(failed)];
  return condition === undefined ? `held: ${edge.held.reason}` : `held until ${waitsFor(condition)}`;
}

/** When the edge last delivered, for the chip under its label (`delivered 14:02`); nothing before then, or after a skip. */
export function deliveredLabel(edge: Pick<FlowEdge, 'lastDelivery'>, now: Date): string | undefined {
  if (edge.lastDelivery?.delivered !== true) return undefined;
  return `delivered ${whenLabel(new Date(edge.lastDelivery.at), now)}`;
}

/**
 * What a hover over the edge's label says: who made it, if an agent did (`madeBy`, its name if it is still on the
 * board), and why its last delivery was skipped, if it was.
 */
export function edgeTitle(edge: Pick<FlowEdge, 'madeBy' | 'lastDelivery'>, madeByName: string | undefined): string | undefined {
  const lines = [
    ...(edge.madeBy === null ? [] : [madeByName === undefined ? 'Made by an orchestrator since deleted' : `Made by ${madeByName}, an orchestrator`]),
    ...(edge.lastDelivery?.delivered === false ? [`Last delivery skipped: ${edge.lastDelivery.reason}`] : []),
  ];
  return lines.length === 0 ? undefined : lines.join('\n');
}

/** One of an edge's events as its history says it, `to` being the agent it delivers to. */
export function historyLine(event: FlowEdgeEvent, to: string): string {
  switch (event.kind) {
    case 'delivered':
      return `Sent ${event.detail} to ${to}`;
    case 'skipped':
      return `Skipped: ${event.detail}`;
    case 'held':
      return `Held: ${event.detail}`;
    case 'released':
      return `Released: ${event.detail}`;
    case 'queued':
      return `Queued until ${to}'s turn ends: ${event.detail}`;
    case 'approved':
      return `Approved: ${event.detail}`;
  }
}

/**
 * How far to pan the board left, in screen pixels, so an edge's ends (the screen span of its two tiles) clear the
 * Edge rules panel, whose left side is at `panelLeft`, by `margin` (FlowDraw AB2: "tiles shift left"): 0 when they
 * do already, and never so far that their left goes out of view.
 */
export function panClear(span: { left: number; right: number }, panelLeft: number, margin: number): number {
  const over = span.right + margin - panelLeft;
  if (over <= 0) return 0;
  return Math.max(0, Math.min(over, span.left - margin));
}

/** What a change to an edge's rules makes of it at once, before the daemon answers: a new payload takes its default file. */
export function withRules(edge: FlowEdge, changes: Omit<UpdateFlowEdgeParams, 'id'>): FlowEdge {
  const payload = changes.payload ?? edge.payload;
  const path =
    payload === 'final-message' ? null : (changes.path ?? (payload === edge.payload ? edge.path : DEFAULT_PAYLOAD_PATHS[payload]));
  const conditions = changes.conditions ?? edge.conditions;
  return {
    ...edge,
    trigger: changes.trigger ?? edge.trigger,
    payload,
    path,
    conditions,
    checks: changes.conditions === undefined ? edge.checks : conditions.map(() => null),
    deliverAs: changes.deliverAs ?? edge.deliverAs,
    paused: changes.paused ?? edge.paused,
  };
}

/** `edge` with the rules `changes` touched put back as they were in `was`, the rest as the daemon last said. */
export function withRulesOf(edge: FlowEdge, was: FlowEdge, changes: Omit<UpdateFlowEdgeParams, 'id'>): FlowEdge {
  const keys = new Set<keyof FlowEdge>(Object.keys(changes) as (keyof FlowEdge)[]);
  if (keys.has('payload')) keys.add('path');
  if (keys.has('conditions')) keys.add('checks');
  return { ...edge, ...Object.fromEntries([...keys].map((key) => [key, was[key]])) };
}
