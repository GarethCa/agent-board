import { useEffect, useMemo, useRef, useState } from 'react';
import { FLOW_EDGE_SHAPE_KEYS, type FlowEdge, type FlowEdgeShape } from '@agent-board/daemon/protocol';
import type { FlowEdgeChange } from '../../../preload/api';
import type { FlowEdgeActions } from './FlowEdge';
import { tokenNumber } from '../theme';
import { liveHandoffs, withFlowEdgeChange, withChanges, withChangesUndone } from './flow-edges';
import { railMoved, railMoveRefused } from './rails';
import { historyKey, type Change } from './editing/use-history';

/** The changes to an edge that go in the undo history: its shape, and the agents at its ends. */
const RECORDED_KEYS = [...FLOW_EDGE_SHAPE_KEYS, 'from', 'to'] as const;

/**
 * The board's flow edges, as the daemon has them and every window hears them change, and what the board can
 * do with them. `report(action)` shows why one failed; `record` puts an edge made, reshaped or deleted in the undo
 * history.
 */
export function useFlowEdges(report: (action: string) => (error: unknown) => void, record: (changes: readonly Change[]) => void) {
  const [edges, setEdges] = useState<FlowEdge[]>([]);
  /** The flow edges selected, by id. React Flow reports a selection, and the edges are drawn from `edges`. */
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  /** The edge just drawn, until its Edge rules close: they call it new. */
  const [drawn, setDrawn] = useState<string>();
  /** The edges showing a hand-off going along them, and when each started. */
  const [live, setLive] = useState<ReadonlySet<string>>(new Set());
  const liveSince = useRef<ReadonlyMap<string, number>>(new Map());
  /** Edges asked for and not yet heard of: selected already, so not yet unselected for being unknown. */
  const creating = useRef(new Set<string>());
  const [liveCheck, setLiveCheck] = useState(0);
  const edgesRef = useRef(edges);
  edgesRef.current = edges;

  // Subscribed before the list: a change that crossed it is applied again on top.
  useEffect(() => {
    let backlog: FlowEdgeChange[] | undefined = [];
    let cancelled = false;
    const unsubscribe = window.agentBoard.flowEdges.onChanged((change) => {
      if (backlog !== undefined) backlog.push(change);
      else setEdges((current) => withFlowEdgeChange(current, change));
    });
    window.agentBoard.flowEdges.list().then((listed) => {
      if (cancelled) return;
      setEdges(backlog!.reduce(withFlowEdgeChange, listed));
      backlog = undefined;
    }, report('load the flow edges'));
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [report]);

  // An edge that goes, however it goes (with its agent, or in another window), is no longer selected.
  useEffect(() => {
    setSelected((current) => {
      const kept = new Set([...current].filter((id) => creating.current.has(id) || edges.some((edge) => edge.id === id)));
      return kept.size === current.size ? current : kept;
    });
  }, [edges]);

  useEffect(() => {
    const next = liveHandoffs(edges, liveSince.current, performance.now(), tokenNumber('--motion-handoff'));
    liveSince.current = next.since;
    setLive((current) => (current.size === next.live.size && [...next.live].every((id) => current.has(id)) ? current : next.live));
    if (next.wakeIn === undefined) return;
    const timer = setTimeout(() => setLiveCheck((count) => count + 1), next.wakeIn);
    return () => clearTimeout(timer);
  }, [edges, liveCheck]);

  // The panel calls an edge new only until it closes on it.
  useEffect(() => {
    if (drawn !== undefined && !selected.has(drawn) && edges.some((edge) => edge.id === drawn)) setDrawn(undefined);
  }, [drawn, selected, edges]);

  const actions = useMemo<
    FlowEdgeActions & {
      /**
       * Joins `from` to `to`, drawn as `shape` has it; true once the daemon has it. In the same undo step as `replaces`:
       * the arrow it was made from, say.
       */
      create(from: string, to: string, shape?: Partial<FlowEdgeShape>, replaces?: readonly Change[]): Promise<boolean>;
      restore(edge: FlowEdge): void;
      remove(id: string): void;
    }
  >(
    () => {
      return {
        // Its id is picked here, so it is selected, with its Edge rules open, as soon as the daemon has it.
        create(from, to, shape = {}, replaces = []) {
          const id = crypto.randomUUID();
          creating.current.add(id);
          setSelected(new Set([id]));
          setDrawn(id);
          return window.agentBoard.flowEdges
            .create({ id, from, to, ...shape })
            .then((edge) => {
              record([...replaces, [historyKey.flowEdge(id), null, { type: 'flowEdge', edge }]]);
              return true;
            })
            .catch((error: unknown) => {
              setSelected((current) => new Set([...current].filter((known) => known !== id)));
              report('join the agents')(error);
              return false;
            })
            .finally(() => creating.current.delete(id));
        },
        // Made again by undo or redo, as it was, under its own id and in its own shape: its history starts afresh.
        restore(edge) {
          const { id, from, to, trigger, payload, conditions, deliverAs, paused, fromSide, toSide, style, points } = edge;
          const path = edge.path ?? undefined;
          window.agentBoard.flowEdges
            .create({ id, from, to, trigger, payload, path, conditions, deliverAs, paused, fromSide, toSide, style, points })
            .catch(report('put the flow edge back'));
        },
        remove(id) {
          const edge = edgesRef.current.find((known) => known.id === id);
          if (edge !== undefined) record([[historyKey.flowEdge(id), { type: 'flowEdge', edge }, null]]);
          setEdges((current) => current.filter((known) => known.id !== id));
          window.agentBoard.flowEdges.delete(id).catch(report('delete the flow edge'));
        },
        send(id) {
          window.agentBoard.flowEdges.send(id).catch(report('send along the flow edge'));
        },
        approve(id, command, fingerprint, from) {
          window.agentBoard.flowEdges.approve(id, command, fingerprint, from).catch(report('approve the command'));
        },
        select(id) {
          setSelected(new Set([id]));
        },
        drop(id) {
          window.agentBoard.flowEdges.drop(id).catch(report('drop the held hand-off'));
        },
        // At once, so the panel's controls take; put back if the daemon refuses it, as it does an auto loop. A reshape
        // or a move of an end (an undo's) goes in the undo history; a change of rules, as before, doesn't.
        update(id, changes) {
          const was = edgesRef.current.find((edge) => edge.id === id);
          if (was === undefined) return;
          if (RECORDED_KEYS.some((key) => key in changes)) {
            record([[historyKey.flowEdge(id), { type: 'flowEdge', edge: was }, { type: 'flowEdge', edge: withChanges(was, changes) }]]);
          }
          setEdges((current) => current.map((edge) => (edge.id === id ? withChanges(edge, changes) : edge)));
          window.agentBoard.flowEdges.update({ id, ...changes }).catch((error: unknown) => {
            // Only what it changed: what the daemon said of the edge meanwhile (a check, a delivery) stands.
            setEdges((current) => current.map((edge) => (edge.id === id ? withChangesUndone(edge, was, changes) : edge)));
            report('change the flow edge')(error);
          });
        },
        canMoveRail(rail, which, agent) {
          return railMoveRefused(rail, which, agent, edgesRef.current) === undefined;
        },
        // Shown at once, and in the undo history as one step only once the daemon has moved every edge: one it refuses
        // (another window changed the board meanwhile) puts back those it moved, so the rail is never left split.
        moveRail(rail, which, agent, shape) {
          const moves = railMoved(rail, which, agent, shape).flatMap(([id, change]) => {
            const was = edgesRef.current.find((edge) => edge.id === id);
            return was === undefined ? [] : [{ id, change, was }];
          });
          const moving = new Map(moves.map((move) => [move.id, move]));
          setEdges((current) =>
            current.map((edge) => {
              const move = moving.get(edge.id);
              return move === undefined ? edge : withChanges(edge, move.change);
            }),
          );
          void Promise.allSettled(moves.map(({ id, change }) => window.agentBoard.flowEdges.update({ id, ...change }))).then((results) => {
            const refused = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
            if (refused === undefined) {
              record(moves.map(({ id, change, was }) => [historyKey.flowEdge(id), { type: 'flowEdge', edge: was }, { type: 'flowEdge', edge: withChanges(was, change) }]));
              return;
            }
            for (const [index, { id, change, was }] of moves.entries()) {
              setEdges((current) => current.map((edge) => (edge.id === id ? withChangesUndone(edge, was, change) : edge)));
              if (results[index]!.status !== 'fulfilled') continue;
              const { from, to, fromSide, toSide, style, points } = was;
              window.agentBoard.flowEdges.update({ id, from, to, fromSide, toSide, style, points }).catch(report('put the flow edge back'));
            }
            report('move the hand-off')(refused.reason);
          });
        },
      };
    },
    [report, record],
  );

  return { edges, selected, setSelected, drawn, live, actions };
}
