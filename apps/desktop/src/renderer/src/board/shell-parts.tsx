// The part both of a shell's tiles, Classic's and the Simplified design's, share: the folder chip that opens a new pane elsewhere.
import { useContext, useState } from 'react';
import { Folder, GitBranch } from 'lucide-react';
import type { RecentFolder, Shell } from '@agent-board/daemon/protocol';
import { paneIds } from '@agent-board/daemon/pane-layout';
import { Chip, Menu, type MenuEntry } from '../ui';
import { folderLabel } from './folders';
import { ShellFoldersContext } from './tile';
import { stopPropagation } from './tile-parts';

/**
 * A shell tile's folder chip: the folder its first live pane is in, following `cd`, `~` at home. It opens
 * a menu to start a new pane elsewhere: home, a recent folder, or one browsed for. Running panes never move.
 */
export function ShellFolderChip({ shell }: { shell: Shell }) {
  const folders = useContext(ShellFoldersContext);
  const [recent, setRecent] = useState<RecentFolder[]>([]);
  const live = paneIds(shell.layout).find((pane) => !shell.endedPanes.includes(pane));
  const folder = (live === undefined ? undefined : shell.paneFolders[live]) ?? shell.cwd;
  const elsewhere = recent.filter((each) => each.path !== folder);
  const entries: MenuEntry[] = [
    ...(folders.home === undefined || folders.home === folder
      ? []
      : [{ label: 'Home ~', icon: <Folder />, onSelect: () => folders.newPaneIn(shell, folders.home) }]),
    ...elsewhere.map((each) => ({
      label: each.branch === null ? each.name : `${each.name} (${each.branch})`,
      icon: <GitBranch />,
      hint: each.path,
      onSelect: () => folders.newPaneIn(shell, each.path),
    })),
    ...(elsewhere.length > 0 || folders.home !== folder ? ['separator' as const] : []),
    { label: 'Browse…', icon: <Folder />, onSelect: () => folders.newPaneIn(shell) },
  ];
  return (
    <Menu
      entries={entries}
      onOpenChange={(open) => {
        if (open) void folders.recent().then(setRecent, () => setRecent([]));
      }}
    >
      <Chip
        className="hybrid-tile-folder nodrag"
        icon={<Folder />}
        mono
        aria-label="Shell folder"
        data-testid="shell-folder"
        title={`${folder}: start a new pane in another folder`}
        onDoubleClick={stopPropagation}
      >
        {folderLabel(folder, folders.home)}
      </Chip>
    </Menu>
  );
}
