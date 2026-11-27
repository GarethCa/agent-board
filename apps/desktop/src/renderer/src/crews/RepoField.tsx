import type { RecentFolder } from '@agent-board/daemon/protocol';
import { Button, Select } from '../ui';
import { folderLabel } from '../board/folders';

interface RepoFieldProps {
  repo: string | undefined;
  folders: readonly RecentFolder[];
  onRepo(path: string): void;
  /** What the folder picker asks, such as "Choose the repo for this crew". */
  browseTitle: string;
}

/** The repo a start in a group with none works in: a recent folder, or one chosen. */
export function RepoField({ repo, folders, onRepo, browseTitle }: RepoFieldProps) {
  const browse = () => {
    void window.agentBoard.zones.browseFolder(browseTitle).then((path) => path !== undefined && onRepo(path));
  };
  return (
    <div className="ui-field">
      <span className="ui-field-name">Repo</span>
      <span className="crew-prompt-repo">
        <Select aria-label="Repo" value={repo ?? ''} onChange={(event) => onRepo(event.target.value)}>
          {repo === undefined && <option value="">Choose a repo</option>}
          {repo !== undefined && !folders.some((folder) => folder.path === repo) && <option value={repo}>{folderLabel(repo, undefined)}</option>}
          {folders.map((folder) => (
            <option key={folder.path} value={folder.path}>
              {folderLabel(folder.path, undefined)}
            </option>
          ))}
        </Select>
        <Button onClick={browse}>Choose…</Button>
      </span>
    </div>
  );
}
