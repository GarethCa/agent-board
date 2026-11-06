import { useContext } from 'react';
import { Expand, SquareArrowOutUpRight } from 'lucide-react';
import type { Shell } from '@agent-board/daemon/protocol';
import { EditableName, RenameButton, useRenaming, useSlowClickRename } from '../ui';
import { dropKey, dropOver as dropOverValue } from '../session/shell-moves';
import { calmShellFace, shellPanesLine } from './calm-tile';
import { HarnessMark } from './HarnessMark';
import { shellMenu } from './menu-model';
import { useRenameRequest } from './rename';
import { ResumeButton } from './RestartBanner';
import { ShellFolderChip } from './shell-parts';
import { StatusMark } from './StatusMark';
import { ClickOpensContext, TileActionsContext } from './tile';
import { nameClass, TileButton, TileMenu } from './tile-parts';

/**
 * A shell's tile under the Simplified design, the calm tile's shape (docs/adr/0022-simplified-design.md): its name and window
 * controls (Expand, Pop out and ⋯, always shown), the folder it is in, and a status with Resume only when a restart stopped
 * it or its panes have ended. Show technical details adds its panes under it. It keeps the Classic shell tile's root and
 * data, so the board finds, drops onto and measures it as it does that one.
 */
export function CalmShellTile({ id, shell, selected }: { id: string; shell: Shell; selected: boolean }) {
  const tileActions = useContext(TileActionsContext);
  const { expand, openShell, popOutShell, resumeShell, rename } = tileActions;
  const clickOpens = useContext(ClickOpensContext);
  const renaming = useRenaming(shell.name, (name) => rename({ kind: 'shell', shellId: shell.id }, name));
  const dropOver = dropOverValue.use();
  useRenameRequest(id, renaming);
  const nameClicks = useSlowClickRename(renaming, selected);
  const face = calmShellFace(shell);
  const drop = dropKey({ kind: 'shell', id: shell.id });
  return (
    <div
      className="hybrid-tile hybrid-tile-agent hybrid-tile-shell calm-tile"
      data-testid="shell-tile"
      data-representation="hybrid"
      data-harness="shell"
      data-shell-id={shell.id}
      data-zone={shell.zoneId ?? ''}
      data-tab-drop={drop}
      data-drop-over={dropOver === drop || undefined}
      data-status={face.status ?? undefined}
      data-state={shell.stoppedPanes.length > 0 ? 'stopped-by-restart' : face.status === 'done' ? 'done' : 'idle'}
      title={clickOpens !== 'expand' ? 'Double-click to open its terminal window' : 'Double-click to expand it here'}
      onDoubleClick={() => (clickOpens !== 'expand' ? openShell(shell) : expand(id))}
    >
      <div className="hybrid-tile-head calm-tile-head">
        <EditableName className={nameClass(shell.name)} value={shell.name} title={shell.name} renaming={renaming} clicks={nameClicks} label="Shell name" />
        <RenameButton renaming={renaming} />
        <span className="calm-tile-controls" data-testid="tile-controls">
          <TileButton icon={<Expand />} aria-label="Expand" title="Expand it here, with its panes" onClick={() => expand(id)} />
          <TileButton icon={<SquareArrowOutUpRight />} aria-label="Pop out" title="Open its terminal in its own window" onClick={() => popOutShell(shell)} />
          <TileMenu entries={shellMenu({ nodeId: id, shell, clickOpens, rename: renaming.startSoon, actions: tileActions })} />
        </span>
      </div>
      <ShellFolderChip shell={shell} />
      {face.line !== null && (
        <span className="calm-tile-line" data-testid="tile-line" title={face.line}>
          {face.line}
        </span>
      )}
      {face.status !== null && (
        <span className="calm-tile-foot">
          <StatusMark status={face.status} />
          {face.resume && <ResumeButton className="calm-tile-action nodrag" onResume={() => resumeShell(shell)} />}
        </span>
      )}
      <span className="calm-tile-technical" data-testid="tile-technical" data-technical-detail="">
        <HarnessMark harness="shell" />
        <span className="calm-tile-technical-text" data-testid="shell-tile-panes">
          {shellPanesLine(shell)}
        </span>
      </span>
    </div>
  );
}
