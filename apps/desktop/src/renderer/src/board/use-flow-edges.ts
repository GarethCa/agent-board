import { useEffect, useMemo, useRef, useState } from 'react';
import type { FlowEdge } from '@agent-board/daemon/protocol';
import type { FlowEdgeChange } from '../../../preload/api';
import type { FlowEdgeActions } from './FlowEdge';
import { tokenNumber } from '../theme';
import { liveHandoffs, withFlowEdgeChange, withRules, withRulesOf } from './flow-edges';
import { historyKey, type Change } from './editing/use-history';

/**
 * The board's flow edges, as the daemon has them and every window hears them change, and what the board can
 * do with them. `report(action)` shows why one failed; `record` puts an edge made or deleted in the undo history.
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
    FlowEdgeActions & { create(from: string, to: string): void; restore(edge: FlowEdge): void; remove(id: string): void }
  >(
    () => ({
      // Its id is picked here, so it is selected, with its Edge rules open, as soon as the daemon has it.
      create(from, to) {
        const id = crypto.randomUUID();
        creating.current.add(id);
        setSelected(new Set([id]));
        setDrawn(id);
        window.agentBoard.flowEdges
          .create({ id, from, to })
          .then((edge) => record([[historyKey.flowEdge(id), null, { type: 'flowEdge', edge }]]))
          .catch((error: unknown) => {
            setSelected((current) => new Set([...current].filter((known) => known !== id)));
            report('join the agents')(error);
          })
          .finally(() => creating.current.delete(id));
      },
      // Made again by undo or redo, as it was, under its own id: its history starts afresh.
      restore(edge) {
        const { id, from, to, trigger, payload, conditions, deliverAs, paused } = edge;
        const path = edge.path ?? undefined;
        window.agentBoard.flowEdges
          .create({ id, from, to, trigger, payload, path, conditions, deliverAs, paused })
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
      approve(id, command, fingerprint) {
        window.agentBoard.flowEdges.approve(id, command, fingerprint).catch(report('approve the command'));
      },
      drop(id) {
        window.agentBoard.flowEdges.drop(id).catch(report('drop the held hand-off'));
      },
      // At once, so the panel's controls take; put back if the daemon refuses it, as it does an auto loop.
      update(id, changes) {
        const was = edgesRef.current.find((edge) => edge.id === id);
        if (was === undefined) return;
        setEdges((current) => current.map((edge) => (edge.id === id ? withRules(edge, changes) : edge)));
        window.agentBoard.flowEdges.update({ id, ...changes }).catch((error: unknown) => {
          // Only what it changed: what the daemon said of the edge meanwhile (a check, a delivery) stands.
          setEdges((current) => current.map((edge) => (edge.id === id ? withRulesOf(edge, was, changes) : edge)));
          report('change the flow edge')(error);
        });
      },
    }),
    [report, record],
  );

  return { edges, selected, setSelected, drawn, live, actions };
}
