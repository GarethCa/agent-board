import { createContext, useContext, useEffect } from 'react';
import type { Agent, Shell } from '@agent-board/daemon/protocol';
import type { Renaming } from '../ui';

/** Something with a name the user can change: an agent's tile, a shell's tile, or one pane of a shell. */
export type RenameTarget =
  | { kind: 'agent'; sessionId: string }
  | { kind: 'shell'; shellId: string }
  | { kind: 'pane'; shellId: string; sessionId: string };

/** The key an undo step files a name under. */
export const renameKey = (target: RenameTarget): string =>
  target.kind === 'agent' ? `name:agent:${target.sessionId}` : target.kind === 'shell' ? `name:shell:${target.shellId}` : `name:pane:${target.shellId}:${target.sessionId}`;

/** Renames through the daemon. A pane's blank name takes its label off. Resolves with the name as saved. */
export async function renameDirect(target: RenameTarget, name: string): Promise<string> {
  if (target.kind === 'agent') return (await window.agentBoard.agents.setName(target.sessionId, name)).name;
  if (target.kind === 'shell') return (await window.agentBoard.shells.setName(target.shellId, name)).name;
  const shell = await window.agentBoard.shells.setPaneName(target.shellId, target.sessionId, name === '' ? null : name);
  return paneLabel(shell, target.sessionId) ?? '';
}

/** The label the user gave the pane, if any. */
export function paneLabel(shell: Shell, sessionId: string): string | undefined {
  const find = (node: Shell['layout']): string | undefined =>
    node.type === 'pane' ? (node.sessionId === sessionId ? node.name : undefined) : (find(node.first) ?? find(node.second));
  return find(shell.layout);
}

/** The target of the agent's or shell's own name. */
export const nameTarget = (subject: { agent?: Agent; shell?: Shell }): RenameTarget | undefined =>
  subject.agent !== undefined
    ? { kind: 'agent', sessionId: subject.agent.sessionId }
    : subject.shell !== undefined
      ? { kind: 'shell', shellId: subject.shell.id }
      : undefined;

/**
 * Which tile (by node id) the board has asked to start renaming, from F2 or its context menu, until it has. Only the
 * tile knows how to open its field, so the board asks and the tile answers.
 */
export const RenameRequestContext = createContext<{ nodeId: string | undefined; done(): void }>({ nodeId: undefined, done: () => {} });

/** Starts `renaming` when the board asks for the tile `nodeId` to be renamed. */
export function useRenameRequest(nodeId: string, renaming: Renaming): void {
  const request = useContext(RenameRequestContext);
  const asked = request.nodeId === nodeId;
  useEffect(() => {
    if (!asked) return;
    renaming.start();
    request.done();
    // `renaming` is rebuilt every render; only a new ask should start it.
  }, [asked]);
}
