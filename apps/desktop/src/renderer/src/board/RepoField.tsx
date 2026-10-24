import { Folder, FolderOpen, GitBranch, Sparkles } from 'lucide-react';
import { Check, ChevronDown } from 'lucide-react';
import type { AgentRepo, RecentFolder } from '@agent-board/daemon/protocol';
import { errorMessage } from '../../../shared/errors';
import { Button, Input, Menu, type MenuEntry } from '../ui';
import { folderLabel } from './folders';
import { useRecentFolders } from './RecentFolders';

/** The repo a new agent in a group starts in: a folder in a repo, a new scratch repo, or none (the group's own folder). */
export type RepoValue = { kind: 'folder'; path: string; branch: string | null } | { kind: 'scratch' } | { kind: 'none' };

/** The repo as the spawn takes it: none for the group's own folder. */
export const repoParam = (value: RepoValue): AgentRepo | undefined =>
  value.kind === 'scratch' ? { scratch: true } : value.kind === 'folder' ? { path: value.path } : undefined;

interface RepoFieldProps {
  value: RepoValue;
  /** The group's default repo, tagged on the field while it is the one picked. */
  defaultRepo: string | null;
  /** The group's own folder, offered as No repo while the group has no default repo; null for none. */
  groupFolder: string | null;
  /** The repo's branch to cut it from: its HEAD without. */
  baseBranch: string;
  /** Its new branch, '' for the one made from its name. */
  branch: string;
  /** A reviewer reviews the branch it picks and makes none, so there is no new branch to name. */
  reviewer: boolean;
  /** It works on the repo's checkout as it is, so there are no branches to name. */
  inPlace?: boolean;
  /** A reviewer whose Reviews field picked an agent: that agent's branch and repo are the ones, not these. */
  reviewsPicked?: boolean;
  /** The recent folders arrived: the first is picked unless the user has picked, or the group has a default. */
  onRecents(folders: RecentFolder[]): void;
  onPick(value: RepoValue): void;
  onBaseBranch(branch: string): void;
  onBranch(branch: string): void;
  onError(message: string): void;
}

/**
 * The first field of New agent in a group (a zone with no repo of its own): which repo the agent works in, with its
 * base branch and new branch folded in one quiet line under it. A repo zone has no such field.
 */
export function RepoField({ value, defaultRepo, groupFolder, baseBranch, branch, reviewer, inPlace = false, reviewsPicked = false, onRecents, onPick, onBaseBranch, onBranch, onError }: RepoFieldProps) {
  const { folders } = useRecentFolders(onRecents);
  const scratch = value.kind === 'scratch';
  const none = value.kind === 'none';
  const picked = value.kind === 'folder' ? value.path : undefined;
  const folderEntry = (folder: Pick<RecentFolder, 'path' | 'branch'>): MenuEntry => ({
    label: folderLabel(folder.path, undefined),
    hint: folder.path,
    icon: folder.path === picked ? <Check aria-hidden /> : <span className="agent-setup-blank" aria-hidden />,
    onSelect: () => onPick({ kind: 'folder', path: folder.path, branch: folder.branch }),
  });
  const listed = folders ?? [];
  // The default repo is offered even when no zone or agent has used it yet.
  const offered = [
    ...(defaultRepo !== null && !listed.some((folder) => folder.path === defaultRepo) ? [{ path: defaultRepo, branch: null }] : []),
    ...listed,
  ];
  const browse = () =>
    window.agentBoard.zones.browseFolder('Choose where the agent works').then(
      (path) => path === undefined || onPick({ kind: 'folder', path, branch: null }),
      (failure: unknown) => onError(errorMessage(failure)),
    );
  const entries: MenuEntry[] = [
    ...offered.map(folderEntry),
    ...(picked !== undefined && !offered.some((folder) => folder.path === picked) ? [folderEntry({ path: picked, branch: null })] : []),
    ...(offered.length > 0 ? (['separator'] as const) : []),
    { label: 'Browse…', hint: 'Any folder on disk', icon: <FolderOpen aria-hidden />, onSelect: () => void browse() },
    {
      label: 'No repo, scratch folder',
      hint: "A new git repo of its own, in agent-board's scratch folder",
      icon: scratch ? <Check aria-hidden /> : <Sparkles aria-hidden />,
      onSelect: () => onPick({ kind: 'scratch' }),
    },
    ...(groupFolder === null
      ? []
      : [
          {
            label: 'No repo',
            hint: "The group's own folder, outside git",
            icon: none ? <Check aria-hidden /> : <Folder aria-hidden />,
            onSelect: () => onPick({ kind: 'none' }),
          },
        ]),
  ];
  const shown = value.kind === 'folder' ? folderLabel(value.path, undefined) : scratch ? 'No repo, scratch folder' : 'No repo';

  return (
    <div className="ui-field repo-field" role="group" aria-label="Repo">
      <span className="ui-field-name">Repo</span>
      <Menu entries={entries} align="start" side="bottom">
        <Button variant="secondary" className="repo-field-button" aria-label={`Repo: ${value.kind === 'folder' ? shown : scratch ? 'scratch repo' : 'none'}`} trailingIcon={<ChevronDown />}>
          {scratch ? <Sparkles aria-hidden /> : none ? <Folder aria-hidden /> : <FolderOpen aria-hidden />}
          <span className="repo-field-name">{shown}</span>
          {value.kind === 'folder' && value.path === defaultRepo && <span className="repo-field-tag">group default</span>}
        </Button>
      </Menu>
      <div className="repo-field-branches">
        {scratch ? (
          <span className="repo-field-note">A new git repo, made for this agent</span>
        ) : none ? (
          <span className="repo-field-note">The group&apos;s own folder, outside git: no worktree or branch</span>
        ) : reviewer && reviewsPicked ? (
          <span className="repo-field-note">Reviews the agent picked below, in its own repo</span>
        ) : inPlace ? (
          <span className="repo-field-note">Works in the checkout as it is: no branch of its own</span>
        ) : (
          <>
            <span>{reviewer ? 'reviews' : 'from'}</span>
            <Input
              size="sm"
              icon={<GitBranch />}
              className="add-zone-mono"
              aria-label={reviewer ? 'Branch to review' : 'Base branch'}
              placeholder="HEAD"
              value={baseBranch}
              onChange={(event) => onBaseBranch(event.target.value)}
            />
            {!reviewer && (
              <>
                <span aria-hidden>→</span>
                <Input
                  size="sm"
                  className="add-zone-mono"
                  aria-label="New branch"
                  placeholder="From its name"
                  value={branch}
                  onChange={(event) => onBranch(event.target.value)}
                />
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
