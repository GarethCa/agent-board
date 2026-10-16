import { useCallback, useEffect, useRef, type RefObject } from 'react';
import type { Edge } from '@xyflow/react';
import type { Shell, Zone } from '@agent-board/daemon/protocol';
import { liveShellCount } from '../session/tabs';
import { KEY_BLOCKERS, SESSION_SURFACES } from './board-shortcuts';
import { deleteLines, needsConfirmation, type DeleteTargets, type PendingDelete } from './editing/delete-plan';
import { zoneDeleteText, type ZoneToDelete } from './editing/delete-zones';
import { selectedNodes } from './editing/selection';
import type { useEditing } from './editing/use-editing';
import { isItemNode } from './items/items';
import type { TileActions, TileNodeType } from './tile';
import { isSessionTile, isZone, type BoardNode } from './tiles';

interface DeleteSelectionOptions {
  editing: ReturnType<typeof useEditing>;
  nodesRef: RefObject<BoardNode[]>;
  /** Undefined until listed. */
  shellsRef: RefObject<Shell[] | undefined>;
  selectedConnectorsRef: RefObject<ReadonlySet<string>>;
  /** Deletes a lone session as its tile's own delete does: asking first, if it needs to. */
  tileActions: TileActions;
  askDelete(ask: PendingDelete): void;
  /** Deletes sessions at once, without asking: the combined confirmation has already been answered. */
  remove: {
    agent(sessionId: string, force: boolean, keep?: boolean): void;
    shell(shellId: string): void;
    external(id: string): void;
  };
  zonesToDelete(zones: Zone[]): ZoneToDelete[];
  removeZones(zones: Zone[], deleteClone: boolean, then?: () => void): Promise<void>;
  report(action: string): (error: unknown) => void;
  /** The home directory, for `~` in a zone's paths; undefined until the daemon says. */
  home: string | undefined;
}

/**
 * Deleting the selection, from ⌫ and the context menu's Delete: what is selected goes, sessions and zones behind a
 * confirmation. `onBeforeDelete` is React Flow's: it takes the keyboard's delete over for sessions and zones.
 */
export function useDeleteSelection({
  editing,
  nodesRef,
  shellsRef,
  selectedConnectorsRef,
  tileActions,
  askDelete,
  remove: { agent: deleteAgent, shell: deleteShell, external: dismissExternal },
  zonesToDelete,
  removeZones,
  report,
  home,
}: DeleteSelectionOptions) {
  /** Deletes the items and connectors `picked` at confirm time and the sessions in `targets`, those with a worktree keeping it if `keep`. */
  const deleteTargets = useCallback(
    (targets: DeleteTargets, sessions: TileNodeType[], keep: boolean, picked: ReturnType<typeof editing.selectedForDelete>) => {
      editing.deleteSelection(picked);
      for (const agent of targets.agents) deleteAgent(agent.sessionId, false, keep);
      for (const node of sessions) if (node.data.shell !== undefined) deleteShell(node.data.shell.id);
      for (const external of targets.externals) dismissExternal(external.id);
    },
    [editing, deleteAgent, deleteShell, dismissExternal],
  );

  /**
   * Deletes what is selected, as ⌫ and the context menu do: items and connectors at once, undoably; a lone session as its
   * tile's own delete does, asking if it needs to; anything more with a session in it behind one combined question; and
   * zones, with anything else selected, always behind one question that names them.
   */
  const deleteSelected = useCallback(() => {
    const selected = selectedNodes(nodesRef.current).all;
    const sessions = selected.filter(isSessionTile);
    const zones = selected.filter(isZone).map((node) => node.data.zone);
    if (sessions.length === 0 && zones.length === 0) return editing.deleteSelection();
    // What is selected now: the confirmation may wait, and a zone's delete takes a while.
    const picked = editing.selectedForDelete();
    const targets: DeleteTargets = {
      agents: sessions.flatMap((node) => node.data.agent ?? []),
      shells: sessions.flatMap((node) =>
        node.data.shell === undefined ? [] : [{ name: node.data.shell.name, live: liveShellCount({ kind: 'shell', shell: node.data.shell }, shellsRef.current ?? []) > 0 }],
      ),
      externals: sessions.flatMap((node) => node.data.external ?? []),
      items: editing.selection().items.length,
      connectors: selectedConnectorsRef.current.size,
      agentShells: new Map(sessions.flatMap((node) => (node.data.agent === undefined ? [] : [[node.data.agent.sessionId, liveShellCount({ kind: 'agent', agent: node.data.agent }, shellsRef.current ?? [])]]))),
    };
    if (zones.length > 0) {
      const cloning = zones.filter((zone) => zone.clone !== null);
      if (cloning.length === zones.length && sessions.length === 0 && targets.items === 0 && targets.connectors === 0) {
        return report(`delete ${cloning[0]!.name}`)(new Error('It is still cloning: cancel the clone first'));
      }
      const going = zones.filter((zone) => zone.clone === null);
      const text = going.length > 0 ? zoneDeleteText(zonesToDelete(going), home) : { title: '', lines: [], cloneLabel: undefined };
      const others = sessions.length > 0 || targets.items > 0 || targets.connectors > 0;
      // An agent that works in a clone, or worktrees kept, stop the daemon deleting it: the box isn't offered then.
      const inClone = going.some((zone) => zone.managedClone && targets.agents.some((agent) => agent.repoRoot === zone.repoRoot));
      const lines = [...(others ? deleteLines(targets) : []), ...text.lines];
      if (cloning.length > 0) lines.push(`${cloning.map((zone) => zone.name).join(', ')} ${cloning.length === 1 ? 'is' : 'are'} still cloning, and stay${cloning.length === 1 ? 's' : ''}.`);
      if (inClone && text.cloneLabel !== undefined) lines.push('The clone stays while an agent in this selection works in it: delete those agents first to delete the clone.');
      askDelete({
        title: others ? 'Delete selection?' : text.title,
        lines,
        confirm: 'Delete',
        keepLabel: targets.agents.some((agent) => agent.ownsWorktree) ? 'Delete, keeping worktrees' : undefined,
        cloneLabel: inClone ? undefined : text.cloneLabel,
        run: (keep, deleteClone) => void removeZones(going, deleteClone, () => deleteTargets(targets, sessions, keep, picked)),
      });
      return;
    }
    if (!needsConfirmation(targets)) {
      const { agent, shell, external } = sessions[0]!.data;
      if (agent !== undefined) return tileActions.deleteAgent(agent.sessionId);
      if (shell !== undefined) return tileActions.deleteShell(shell.id);
      if (external !== undefined) return tileActions.dismissExternal(external.id);
      return;
    }
    askDelete({
      title: 'Delete selection?',
      lines: deleteLines(targets),
      confirm: 'Delete',
      keepLabel: targets.agents.some((agent) => agent.ownsWorktree) ? 'Delete, keeping worktrees' : undefined,
      run: (keep) => deleteTargets(targets, sessions, keep, picked),
    });
  }, [editing, tileActions, askDelete, deleteTargets, zonesToDelete, removeZones, report, home]);

  // Whether the pointer last went down inside an expanded tile or a session window: then a ⌫ is for what is shown there.
  const pointerInSession = useRef(false);
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      pointerInSession.current = (event.target as Element | null)?.closest?.(SESSION_SURFACES) != null;
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => window.removeEventListener('pointerdown', onPointerDown, true);
  }, []);

  // React Flow adds a deleted node's children (a zone's notes) to the list: only items selected themselves go, and a
  // connector selected itself: one on a deleted item goes with it, in the daemon.
  const onBeforeDelete = async ({ nodes: doomed, edges: doomedEdges }: { nodes: BoardNode[]; edges: Edge[] }) => {
    // With a session or a zone selected the board deletes it all itself, after asking (see deleteSelected).
    if (doomed.some((node) => (isSessionTile(node) || isZone(node)) && node.selected === true)) {
      // Never from inside a session's window, its expanded tile or a dialog: the key is theirs.
      const inSession = pointerInSession.current || document.activeElement?.closest(SESSION_SURFACES) != null;
      if (!inSession && document.querySelector(KEY_BLOCKERS) === null) deleteSelected();
      return { nodes: [], edges: [] };
    }
    const nodes = doomed.filter((node) => isItemNode(node) && node.selected === true);
    const going = new Set(nodes.map((node) => node.id));
    const edges = doomedEdges.filter((edge) => edge.selected === true && !going.has(edge.source) && !going.has(edge.target));
    return { nodes, edges };
  };

  return { deleteSelected, onBeforeDelete };
}
