import { useEffect, useRef, useState, type FormEvent, type ReactElement } from 'react';
import { ChevronDown, FolderOpen, GitBranch, Search, Sparkles, X } from 'lucide-react';
import {
  AGENT_ROLES,
  shortIssueId,
  type AgentRepo,
  type AgentRole,
  type Harness,
  type IssueCardData,
  type RecentFolder,
} from '@agent-board/daemon/protocol';
import { errorMessage } from '../../../shared/errors';
import { HARNESSES } from '../harness';
import { AnchoredPopover, Button, ErrorText, Hint, IconButton, Input, Kbd, SectionLabel, Select } from '../ui';
import { matches } from './add-zone';
import { bypassNoticeSeen, CodexBypassExplanation, markBypassNoticeSeen } from './codex-notice';
import { HarnessMark } from './HarnessMark';
import { FolderLine, FolderRow, useRecentFolders } from './RecentFolders';

/** The models offered for each harness, besides its own default; any other can be typed. */
const MODELS: Record<Harness, string[]> = { claude: ['opus', 'sonnet', 'haiku'], codex: ['gpt-5-codex', 'gpt-5'] };

/** How each role reads in the picker. */
const ROLE_LABELS: Record<AgentRole, string> = {
  implementer: 'Implementer',
  reviewer: 'Reviewer',
  'follow-up-reviewer': 'Follow-up reviewer',
};

/** What the picker starts an agent with. */
export interface RepoChoice {
  repo: AgentRepo;
  /** The repo's branch to cut it from: its HEAD without. */
  baseBranch?: string;
  /** Its new branch: from its name, or its issue, without. */
  branch?: string;
  harness: Harness;
  /** The harness's own default without. */
  model?: string;
  role?: AgentRole;
  allowProjectCodexConfig?: boolean;
}

/** What starting it came to: running, or the daemon's warning about Codex config in the new worktree, to confirm. */
export type PickerStart = { status: 'started' } | { status: 'confirm'; message: string };

/** The repo picked: a folder in a repo (recent, or browsed for), or a new scratch repo. */
type Picked = { kind: 'folder'; folder: Pick<RecentFolder, 'path' | 'branch'> } | { kind: 'scratch' };

interface RepoPickerProps {
  /** The pending tile it points at. */
  anchor: ReactElement;
  /** The name the daemon will give the agent, for its branch; undefined until it says. */
  agentName: string | undefined;
  /** The issue the agent starts from, if any: its branch is then named from it. */
  issue?: IssueCardData;
  onStart(choice: RepoChoice): Promise<PickerStart>;
  onCancel(): void;
}

/**
 * The repo picker (AH1): a popover on a new agent's tile, for when no zone gives it a repo. A recent repo (the
 * last used preselected), Browse… for any folder, or a scratch repo; a base branch and a new branch prefilled from the
 * agent's name; then Start. The footer's compact Model · Role row stays collapsed on the defaults until opened.
 */
export function RepoPicker({ anchor, agentName, issue, onStart, onCancel }: RepoPickerProps) {
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<Picked>();
  const [baseBranch, setBaseBranch] = useState('');
  /** The branch typed, or undefined to take the one made from its name (or its issue's). */
  const [typedBranch, setTypedBranch] = useState<string>();
  const [harness, setHarness] = useState<Harness>('claude');
  const [model, setModel] = useState('');
  const [role, setRole] = useState<AgentRole | ''>('');
  const [showModel, setShowModel] = useState(false);
  const [starting, setStarting] = useState(false);
  const [confirm, setConfirm] = useState<string>();
  const [error, setError] = useState<string>();
  /** Whether the user has picked a repo, which the last used must not then replace as it loads. */
  const userPicked = useRef(false);

  const pick = (next: Picked) => {
    setPicked(next);
    setBaseBranch(next.kind === 'folder' ? (next.folder.branch ?? '') : '');
    setError(undefined);
  };
  const pickByUser = (next: Picked) => {
    userPicked.current = true;
    pick(next);
  };
  // The last used is preselected, so ⏎ starts it at once.
  const { folders, error: loadError } = useRecentFolders((found) => {
    if (found[0] !== undefined && !userPicked.current) pick({ kind: 'folder', folder: found[0] });
  });
  /** Whether Codex's hook-bypass notice has been read, checked again whenever the harness changes. */
  const [seenNotice, setSeenNotice] = useState(bypassNoticeSeen);
  useEffect(() => setSeenNotice(bypassNoticeSeen()), [harness]);

  const browse = () => {
    setError(undefined);
    window.agentBoard.zones.browseFolder('Choose where the agent works').then(
      (path) => path === undefined || pickByUser({ kind: 'folder', folder: { path, branch: null } }),
      (failure: unknown) => setError(errorMessage(failure)),
    );
  };

  const prefilled = issue === undefined && agentName !== undefined ? `agent/${agentName}` : '';
  const branch = (typedBranch ?? prefilled).trim();

  const start = (allowProjectCodexConfig = false) => {
    if (picked === undefined) return;
    setStarting(true);
    setError(undefined);
    setConfirm(undefined);
    onStart({
      repo: picked.kind === 'scratch' ? { scratch: true } : { path: picked.folder.path },
      baseBranch: baseBranch.trim() || undefined,
      branch: branch || undefined,
      harness,
      model: model.trim() || undefined,
      role: role || undefined,
      allowProjectCodexConfig,
    }).then(
      (result) => {
        if (result.status === 'started' && harness === 'codex') markBypassNoticeSeen();
        if (result.status === 'confirm') {
          setConfirm(result.message);
          setStarting(false);
        }
      },
      (failure: unknown) => {
        setError(errorMessage(failure));
        setStarting(false);
      },
    );
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    start();
  };

  const shown = folders?.filter((folder) => matches([folder.name, folder.path, folder.branch], query));
  const isPicked = (path: string) => picked?.kind === 'folder' && picked.folder.path === path;
  const browsed =
    picked?.kind === 'folder' && !(folders ?? []).some((folder) => folder.path === picked.folder.path) ? picked.folder : undefined;
  const scratch = picked?.kind === 'scratch';
  // Until the daemon says its name, the branch made from it can't be shown: wait, unless one was typed.
  const canStart = picked !== undefined && !starting && (issue !== undefined || agentName !== undefined || typedBranch !== undefined);
  const base = baseBranch.trim() || 'HEAD';
  const worksIn = scratch ? 'new scratch repo' : `worktree off ${base}`;
  const modelRole = `${HARNESSES[harness].label} · ${model.trim() || 'default model'} · ${role === '' ? 'no role' : ROLE_LABELS[role]}`;

  return (
    <AnchoredPopover anchor={anchor} open onOpenChange={(open) => open || onCancel()} aria-label="Choose where the agent works" className="repo-picker">
      <form onSubmit={submit} className="repo-picker-form">
        <div className="repo-picker-head">
          <FolderOpen className="repo-picker-head-icon" aria-hidden />
          <span className="repo-picker-title">Where should it work?</span>
          <IconButton icon={<X />} aria-label="Cancel" size="sm" variant="ghost" onClick={onCancel} />
        </div>
        <div className="repo-picker-body">
          {issue !== undefined && (
            <Hint>
              Starts from {shortIssueId(issue)}: {issue.title}
            </Hint>
          )}
          <Input
            icon={<Search />}
            type="search"
            aria-label="Search repos and folders"
            placeholder="Search repos and folders…"
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <SectionLabel as="p">Recent repos</SectionLabel>
          <ul className="add-zone-list" role="listbox" aria-label="Recent repos">
            {folders === undefined && loadError === undefined && <Hint>Loading…</Hint>}
            {shown?.length === 0 && <Hint>{query === '' ? 'No repos yet: Browse… for one' : 'No repos match'}</Hint>}
            {shown?.map((folder, index) => (
              <FolderRow key={folder.path} picked={isPicked(folder.path)} onPick={() => pickByUser({ kind: 'folder', folder })}>
                <FolderLine path={folder.path} branch={folder.branch} />
                {index === 0 && query === '' && <span className="add-zone-on-board">last used</span>}
              </FolderRow>
            ))}
            {browsed !== undefined && (
              <FolderRow picked onPick={() => {}}>
                <FolderLine path={browsed.path} branch={null} />
              </FolderRow>
            )}
          </ul>
          <button type="button" className="repo-picker-browse" onClick={browse}>
            <FolderOpen aria-hidden />
            <span className="repo-picker-browse-label">Browse…</span>
            <span className="repo-picker-meta">any folder on disk</span>
          </button>
          <hr className="repo-picker-rule" />
          <ul className="add-zone-list" role="listbox" aria-label="Scratch">
            <FolderRow picked={scratch} onPick={() => pickByUser({ kind: 'scratch' })}>
              <Sparkles className="add-zone-row-icon repo-picker-scratch-icon" />
              <span className="add-zone-row-main">
                <span className="add-zone-row-title">No repo, scratch folder</span>
                <span className="add-zone-row-detail">A new git repo of its own, in agent-board&apos;s scratch folder</span>
              </span>
            </FolderRow>
          </ul>
          <hr className="repo-picker-rule" />
          <div className="repo-picker-branches">
            <label className="repo-picker-field">
              Base branch
              <Input
                size="sm"
                icon={<GitBranch />}
                className="add-zone-mono"
                aria-label="Base branch"
                placeholder="HEAD"
                disabled={scratch}
                value={scratch ? '' : baseBranch}
                onChange={(event) => setBaseBranch(event.target.value)}
              />
            </label>
            <label className="repo-picker-field">
              New branch
              <Input
                size="sm"
                className="add-zone-mono"
                aria-label="New branch"
                placeholder={issue === undefined ? 'From its name' : 'From the issue'}
                value={typedBranch ?? prefilled}
                onChange={(event) => setTypedBranch(event.target.value)}
              />
            </label>
          </div>
          {showModel && (
            <div className="repo-picker-model" role="group" aria-label="Model and role">
              <label className="repo-picker-field">
                Harness
                <Select size="sm" aria-label="Harness" value={harness} onChange={(event) => setHarness(event.target.value as Harness)}>
                  {(Object.keys(HARNESSES) as Harness[]).map((choice) => (
                    <option key={choice} value={choice}>
                      {HARNESSES[choice].label}
                    </option>
                  ))}
                </Select>
              </label>
              <label className="repo-picker-field">
                Model
                <Input
                  size="sm"
                  aria-label="Model"
                  placeholder="Default"
                  list="repo-picker-models"
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                />
                <datalist id="repo-picker-models">
                  {MODELS[harness].map((choice) => (
                    <option key={choice} value={choice} />
                  ))}
                </datalist>
              </label>
              <label className="repo-picker-field">
                Role
                <Select size="sm" aria-label="Role" value={role} onChange={(event) => setRole(event.target.value as AgentRole | '')}>
                  <option value="">No role</option>
                  {AGENT_ROLES.map((choice) => (
                    <option key={choice} value={choice}>
                      {ROLE_LABELS[choice]}
                    </option>
                  ))}
                </Select>
              </label>
            </div>
          )}
          {harness === 'codex' && !seenNotice && (
            <div className="repo-picker-notice">
              <CodexBypassExplanation />
            </div>
          )}
          {confirm !== undefined && (
            <div className="repo-picker-confirm" role="alert">
              <Hint>{confirm}</Hint>
              <Button size="sm" onClick={() => start(true)}>
                Start anyway
              </Button>
            </div>
          )}
          {(error ?? loadError) !== undefined && <ErrorText>{error ?? loadError}</ErrorText>}
        </div>
        <div className="repo-picker-foot">
          <Button
            size="sm"
            variant="ghost"
            className="repo-picker-model-toggle"
            title={modelRole}
            aria-label="Model and role"
            aria-expanded={showModel}
            icon={<HarnessMark harness={harness} />}
            trailingIcon={<ChevronDown />}
            onClick={() => setShowModel((open) => !open)}
          >
            <span className="repo-picker-foot-text">{modelRole}</span>
          </Button>
          <span className="repo-picker-meta repo-picker-foot-text add-zone-mono" title={worksIn}>
            {worksIn}
          </span>
          <span className="add-zone-spacer" />
          <Button type="submit" variant="primary" size="sm" loading={starting} disabled={!canStart}>
            Start
            <Kbd aria-hidden>⏎</Kbd>
          </Button>
        </div>
      </form>
    </AnchoredPopover>
  );
}

