import { useEffect, useState, type FormEvent, type ReactElement, type ReactNode } from 'react';
import { CircleCheck, Clock, Download, FolderGit2, GitBranch, ListTodo, Search, SquareDashed } from 'lucide-react';
import {
  ZONE_COLOR_NAMES,
  ZONE_COLORS,
  type GitHubRepoSource,
  type NewZoneParams,
  type RecentFolder,
  type TrackerProject,
  type TrackerScope,
  type Zone,
  type ZoneLayout,
} from '@agent-board/daemon/protocol';
import { errorMessage } from '../../../shared/errors';
import { AnchoredPopover, Button, ErrorText, Hint, Input, Kbd, Select, SwatchRadio, Tabs } from '../ui';
import type { ZoneSource } from '../chrome/zones';
import { matches, type PopoverPlacement } from './add-zone';
import { apiKeyHint, GhLoginHelp, LINEAR_KEY_PLACEHOLDER } from './tracker-help';


/** A group first (AI1): a zone is a group until it is bound, and binding it to a source is optional. */
const SOURCES: { id: ZoneSource; label: string; icon: ReactNode }[] = [
  { id: 'empty', label: 'Group', icon: <SquareDashed /> },
  { id: 'github', label: 'GitHub', icon: <GitBranch /> },
  { id: 'linear', label: 'Linear', icon: <ListTodo /> },
  { id: 'recent', label: 'Recent', icon: <Clock /> },
];

/** What the tab has picked, to add a zone for. */
type Picked =
  | { source: 'github'; repo: GitHubRepoSource }
  | { source: 'linear'; team: TrackerScope; project?: TrackerProject }
  | { source: 'recent'; folder: RecentFolder }
  | { source: 'empty' };

/** A list a tab loads: loading, loaded, or why it can't be shown (a login it needs first, or an error). */
type Loaded<T> = { status: 'loading' } | { status: 'ok'; items: T[] } | { status: 'login'; message?: string } | { status: 'error'; message: string };

/** A row of a Linear team's projects: one of them, or the whole team. */
type ProjectChoice = TrackerProject | 'team';

interface AddZonePopoverProps {
  /** Where the new zone goes on the board, from the Zone tool's drag. */
  layout: ZoneLayout;
  /** The tab it opens on. */
  source: ZoneSource;
  /** Which side of the outline it sits. */
  placement: PopoverPlacement;
  /** The outline drawn on the board where it goes: the popover points at it. */
  outline: ReactElement;
  /** The colour picked to begin with: the least-used. */
  color: string;
  onAdded(zone: Zone): void;
  onCancel(): void;
}

/**
 * Add zone (P1): a popover beside the outline the Zone tool dragged out, with a search and a tab per source: a
 * group, bound to nothing, which it opens on (AI1); a GitHub repo (its local clone, or one the daemon makes); a
 * Linear team, or one of its projects (the zone's tracker, bound to a recent folder or left unbound); or a recent
 * folder ("Browse…" is the only way to the OS picker). The name and colour are set at the bottom (T1).
 */
export function AddZonePopover({ layout, source: initialSource, placement, outline, color: initialColor, onAdded, onCancel }: AddZonePopoverProps) {
  const [source, setSource] = useState<ZoneSource>(initialSource);
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<Picked | undefined>(initialSource === 'empty' ? { source: 'empty' } : undefined);
  /** The name typed, or undefined to take the picked source's. */
  const [typedName, setTypedName] = useState<string>();
  const [color, setColor] = useState(initialColor);
  /** What a Linear team's zone is bound to: '' for nothing, `folder:<path>`, or `github:<owner/repo>`. */
  const [bindTo, setBindTo] = useState('');
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string>();
  const [repos, setRepos] = useState<Loaded<GitHubRepoSource>>({ status: 'loading' });
  const [teams, setTeams] = useState<Loaded<TrackerScope>>({ status: 'loading' });
  /** The open projects of the picked Linear team, once loaded. */
  const [projects, setProjects] = useState<Loaded<TrackerProject>>({ status: 'loading' });
  const [folders, setFolders] = useState<Loaded<RecentFolder>>({ status: 'loading' });
  const [apiKey, setApiKey] = useState('');
  /** Bumped to ask for the repos or teams again, after logging in. */
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const set = <T,>(setter: (loaded: Loaded<T>) => void) => (loaded: Loaded<T>) => cancelled || setter(loaded);
    const failed = (failure: unknown) => ({ status: 'error' as const, message: errorMessage(failure) });
    window.agentBoard.zones.githubRepos().then(
      (result) => set(setRepos)(result.status === 'ok' ? { status: 'ok', items: result.repos } : { status: 'login', message: result.refused }),
      (failure: unknown) => set(setRepos)(failed(failure)),
    );
    window.agentBoard.trackers.scopes('linear').then(
      (result) => set(setTeams)(result.status === 'ok' ? { status: 'ok', items: result.scopes } : { status: 'login', message: result.refused }),
      (failure: unknown) => set(setTeams)(failed(failure)),
    );
    window.agentBoard.zones.recentFolders().then(
      (found) => set(setFolders)({ status: 'ok', items: found }),
      (failure: unknown) => set(setFolders)(failed(failure)),
    );
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const linearTeam = picked?.source === 'linear' ? picked.team.key : undefined;
  useEffect(() => {
    if (linearTeam === undefined) return;
    let cancelled = false;
    setProjects({ status: 'loading' });
    window.agentBoard.trackers.projects('linear', linearTeam).then(
      (found) => cancelled || setProjects({ status: 'ok', items: found }),
      (failure: unknown) => cancelled || setProjects({ status: 'error', message: errorMessage(failure) }),
    );
    return () => {
      cancelled = true;
    };
  }, [linearTeam]);

  const pickSource = (next: ZoneSource) => {
    setSource(next);
    setPicked(next === 'empty' ? { source: 'empty' } : undefined);
    setError(undefined);
  };
  const defaultName =
    picked?.source === 'github'
      ? picked.repo.name
      : picked?.source === 'linear'
        ? (picked.project ?? picked.team).name
        : picked?.source === 'recent'
          ? picked.folder.name
          : '';
  const name = (typedName ?? defaultName).trim();

  const look = (): NewZoneParams => ({ ...layout, name: name || undefined, color });
  const add = async (): Promise<Zone | undefined> => {
    if (picked === undefined) return undefined;
    const addFolder = async (path: string, params: NewZoneParams) => {
      const result = await window.agentBoard.zones.addFolder(path, params);
      if (result.status === 'rejected') throw new Error(result.message);
      return result.zone;
    };
    switch (picked.source) {
      case 'github': {
        const { repo, localPath } = picked.repo;
        return localPath === null
          ? window.agentBoard.zones.clone(repo, look())
          : addFolder(localPath, { ...look(), tracker: { provider: 'github', scope: repo } });
      }
      case 'linear': {
        const tracker = {
          provider: 'linear' as const,
          scope: picked.team.key,
          ...(picked.project === undefined ? {} : { project: picked.project.id }),
        };
        const params = { ...look(), name: name || defaultName, tracker };
        if (bindTo.startsWith('folder:')) return addFolder(bindTo.slice('folder:'.length), params);
        const repo = repos.status === 'ok' ? repos.items.find((each) => `github:${each.repo}` === bindTo) : undefined;
        if (repo === undefined) return window.agentBoard.zones.addUnbound(params);
        // A GitHub repo: its clone here, or one the daemon makes, with the team's issues.
        return repo.localPath === null ? window.agentBoard.zones.clone(repo.repo, params) : addFolder(repo.localPath, params);
      }
      case 'recent':
        return addFolder(picked.folder.path, look());
      case 'empty':
        return window.agentBoard.zones.addUnbound({ ...look(), name });
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!canAdd) return;
    setAdding(true);
    setError(undefined);
    add().then(
      (zone) => (zone === undefined ? setAdding(false) : onAdded(zone)),
      (failure: unknown) => {
        setError(errorMessage(failure));
        setAdding(false);
      },
    );
  };

  const browse = () => {
    setError(undefined);
    window.agentBoard.zones.add(look()).then((result) => {
      if (result.status === 'added') onAdded(result.zone);
      else if (result.status === 'rejected') setError(result.message);
    }, (failure: unknown) => setError(errorMessage(failure)));
  };

  const connectLinear = () => {
    setError(undefined);
    window.agentBoard.trackers.connect('linear', apiKey.trim()).then((found) => {
      setApiKey('');
      setTeams({ status: 'ok', items: found });
    }, (failure: unknown) => setError(errorMessage(failure)));
  };

  const canAdd = picked !== undefined && !adding && (picked.source !== 'empty' || name !== '');
  const count = (loaded: Loaded<unknown>) => (loaded.status === 'ok' ? loaded.items.length : undefined);

  return (
    <AnchoredPopover
      anchor={outline}
      open
      onOpenChange={(open) => open || onCancel()}
      aria-label="Add zone"
      className="add-zone"
      side={placement.side}
      sideOffset={placement.sideOffset}
    >
      <form onSubmit={submit} className="add-zone-form">
        <div className="add-zone-head">
          <Input
            icon={<Search />}
            type="search"
            aria-label="Search repos, teams, projects and folders"
            placeholder="Search repos, teams, projects and folders"
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <Tabs
            aria-label="Zone source"
            value={source}
            onChange={pickSource}
            tabs={SOURCES.map((tab) => ({
              ...tab,
              count: tab.id === 'github' ? count(repos) : tab.id === 'linear' ? count(teams) : undefined,
            }))}
          />
        </div>

        <div className="add-zone-body" role="tabpanel" aria-label={SOURCES.find((tab) => tab.id === source)?.label}>
          {source === 'github' && (
            <SourceList
              loaded={repos}
              login={
                <Hint>
                  <GhLoginHelp />, then{' '}
                  <button type="button" className="add-zone-link" onClick={() => setAttempt((n) => n + 1)}>
                    try again
                  </button>
                  .
                </Hint>
              }
              filter={(repo) => matches([repo.repo, repo.description], query)}
              empty="No repos match"
              label="GitHub repos"
              keyOf={(repo) => repo.repo}
              isPicked={(repo) => picked?.source === 'github' && picked.repo.repo === repo.repo}
              isDisabled={(repo) => repo.onBoard}
              onPick={(repo) => setPicked({ source: 'github', repo })}
              row={(repo) => <RepoRow repo={repo} />}
            />
          )}
          {source === 'linear' && (
            <>
              <div className="add-zone-linear" data-columns={teams.status === 'ok' || undefined}>
                <SourceList
                  loaded={teams}
                  login={
                    <div className="add-zone-connect">
                      <Input
                        type="password"
                        aria-label="Linear API key"
                        placeholder={LINEAR_KEY_PLACEHOLDER}
                        value={apiKey}
                        onChange={(event) => setApiKey(event.target.value)}
                      />
                      <Button disabled={apiKey.trim() === ''} onClick={connectLinear}>
                        Connect Linear
                      </Button>
                      <Hint>{apiKeyHint('Linear')}</Hint>
                    </div>
                  }
                  // Once a team is picked the search is for its projects; every team stays to pick another.
                  filter={(team) => picked?.source === 'linear' || matches([team.key, team.name], query)}
                  empty="No teams match"
                  label="Linear teams"
                  keyOf={(team) => team.key}
                  isPicked={(team) => picked?.source === 'linear' && picked.team.key === team.key}
                  onPick={(team) => setPicked({ source: 'linear', team })}
                  row={(team) => (
                    <>
                      <span className="add-zone-row-mark add-zone-mono">{team.key}</span>
                      <span className="add-zone-row-main">
                        <span className="add-zone-row-title">{team.name}</span>
                      </span>
                    </>
                  )}
                />
                {picked?.source === 'linear' ? (
                  <SourceList
                    loaded={
                      projects.status === 'ok'
                        ? { status: 'ok', items: ['team', ...projects.items] satisfies ProjectChoice[] }
                        : projects
                    }
                    filter={(choice) => choice === 'team' || matches([choice.name, choice.description], query)}
                    empty="No projects match"
                    label={`${picked.team.name} projects`}
                    keyOf={(choice) => (choice === 'team' ? 'team' : choice.id)}
                    isPicked={(choice) =>
                      choice === 'team' ? picked.project === undefined : picked.project?.id === choice.id
                    }
                    onPick={(choice) =>
                      setPicked({ source: 'linear', team: picked.team, project: choice === 'team' ? undefined : choice })
                    }
                    row={(choice) =>
                      choice === 'team' ? (
                        <span className="add-zone-row-main">
                          <span className="add-zone-row-title">Whole team</span>
                          <span className="add-zone-row-detail">Every open issue of {picked.team.key}</span>
                        </span>
                      ) : (
                        <ProjectRow project={choice} />
                      )
                    }
                  />
                ) : (
                  teams.status === 'ok' && <Hint>Pick a team, then a project in it, or the whole team.</Hint>
                )}
              </div>
              {picked?.source === 'linear' && (
                <label className="add-zone-bind">
                  <span>Bind to</span>
                  <Select size="sm" aria-label="Bind to" value={bindTo} onChange={(event) => setBindTo(event.target.value)}>
                    <option value="">Leave unbound</option>
                    {folders.status === 'ok' && folders.items.length > 0 && (
                      <optgroup label="Recent folders">
                        {folders.items.map((folder) => (
                          <option key={folder.path} value={`folder:${folder.path}`}>
                            {folder.name} ({folder.path})
                          </option>
                        ))}
                      </optgroup>
                    )}
                    {repos.status === 'ok' && repos.items.length > 0 && (
                      <optgroup label="GitHub repos">
                        {repos.items.map((repo) => (
                          <option key={repo.repo} value={`github:${repo.repo}`}>
                            {repo.repo}
                            {repo.localPath === null ? ' (clones it)' : ` (${repo.localPath})`}
                          </option>
                        ))}
                      </optgroup>
                    )}
                  </Select>
                </label>
              )}
            </>
          )}
          {source === 'recent' && (
            <>
              <SourceList
                loaded={folders}
                filter={(folder) => matches([folder.name, folder.path, folder.branch], query)}
                empty="No folders yet: zones you add from a folder show here"
                label="Recent folders"
                keyOf={(folder) => folder.path}
                isPicked={(folder) => picked?.source === 'recent' && picked.folder.path === folder.path}
                onPick={(folder) => setPicked({ source: 'recent', folder })}
                row={(folder) => (
                  <>
                    <FolderGit2 className="add-zone-row-icon" />
                    <span className="add-zone-row-main">
                      <span className="add-zone-row-title">{folder.name}</span>
                      <span className="add-zone-row-detail add-zone-mono">
                        {folder.path}
                        {folder.branch !== null && ` · ⎇ ${folder.branch}`}
                      </span>
                    </span>
                    {folder.onBoard && <span className="add-zone-on-board">On the board</span>}
                  </>
                )}
              />
              <p className="add-zone-browse">
                Not listed?{' '}
                <button type="button" className="add-zone-link" onClick={browse}>
                  Browse…
                </button>
              </p>
            </>
          )}
          {source === 'empty' && (
            <Hint>
              A group: a name and a colour. Agents in it keep their own repos, and new ones ask for one, unless you give
              the group a default repo. Bind it to a repo, Linear or GitHub later from its tab, or bind it now from the
              other tabs.
            </Hint>
          )}
        </div>

        <div className="add-zone-foot">
          <label className="add-zone-name">
            <span>Name</span>
            <Input
              size="sm"
              aria-label="Zone name"
              value={typedName ?? defaultName}
              placeholder={source === 'empty' ? 'Name it' : 'From what you pick'}
              onChange={(event) => setTypedName(event.target.value)}
            />
          </label>
          <div className="add-zone-colors" role="radiogroup" aria-label="Zone colour">
            {ZONE_COLORS.map((choice) => (
              <SwatchRadio
                key={choice}
                name="add-zone-color"
                color={choice}
                aria-label={ZONE_COLOR_NAMES[choice] ?? choice}
                title={choice}
                checked={color === choice}
                onChange={() => setColor(choice)}
              />
            ))}
          </div>
          <span className="add-zone-spacer" />
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={adding} disabled={!canAdd}>
            {picked?.source === 'github' && picked.repo.localPath === null ? 'Clone and add' : 'Add zone'}
            <Kbd aria-hidden>⏎</Kbd>
          </Button>
        </div>
        {error !== undefined && <ErrorText>{error}</ErrorText>}
      </form>
    </AnchoredPopover>
  );
}

interface SourceListProps<T> {
  loaded: Loaded<T>;
  /** What to show when the source needs a login first. */
  login?: ReactNode;
  filter(item: T): boolean;
  empty: string;
  label: string;
  keyOf(item: T): string;
  isPicked(item: T): boolean;
  isDisabled?(item: T): boolean;
  onPick(item: T): void;
  row(item: T): ReactNode;
}

/** A tab's list of things to add a zone for: one can be picked. */
function SourceList<T>({ loaded, login, filter, empty, label, keyOf, isPicked, isDisabled, onPick, row }: SourceListProps<T>) {
  if (loaded.status === 'loading') return <Hint>Loading…</Hint>;
  if (loaded.status === 'error') return <ErrorText>{loaded.message}</ErrorText>;
  if (loaded.status === 'login') {
    return (
      <>
        {login}
        {loaded.message !== undefined && <ErrorText>{loaded.message}</ErrorText>}
      </>
    );
  }
  const shown = loaded.items.filter(filter);
  if (shown.length === 0) return <Hint>{empty}</Hint>;
  return (
    <ul className="add-zone-list" role="listbox" aria-label={label}>
      {shown.map((item) => {
        const disabled = isDisabled?.(item) ?? false;
        const pick = () => disabled || onPick(item);
        return (
          <li
            key={keyOf(item)}
            className="add-zone-row"
            role="option"
            aria-selected={isPicked(item)}
            aria-disabled={disabled || undefined}
            tabIndex={disabled ? -1 : 0}
            onClick={pick}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return;
              event.preventDefault();
              pick();
            }}
          >
            {row(item)}
          </li>
        );
      })}
    </ul>
  );
}

/** A Linear project: its name and state, and how far along it is. */
function ProjectRow({ project }: { project: TrackerProject }) {
  const percent = Math.round(project.progress * 100);
  return (
    <>
      <span className="add-zone-row-main">
        <span className="add-zone-row-title">{project.name}</span>
        {project.description !== '' && <span className="add-zone-row-detail">{project.description}</span>}
      </span>
      <span className="add-zone-progress">
        <span
          className="add-zone-progress-bar"
          role="progressbar"
          aria-label={`${project.name} progress`}
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <span style={{ width: `${percent}%` }} />
        </span>
        <span className="add-zone-row-detail">
          {percent}% · {project.state}
        </span>
      </span>
    </>
  );
}

/** A GitHub repo: who owns it, what it is, and whether it is cloned here or will be. */
function RepoRow({ repo }: { repo: GitHubRepoSource }) {
  const [owner] = repo.repo.split('/');
  return (
    <>
      <span className="add-zone-row-mark" aria-hidden="true">
        {owner?.slice(0, 2).toUpperCase()}
      </span>
      <span className="add-zone-row-main">
        <span className="add-zone-row-title">
          <span className="add-zone-owner">{owner} /</span> {repo.name}
        </span>
        {repo.description !== null && <span className="add-zone-row-detail">{repo.description}</span>}
      </span>
      {repo.onBoard ? (
        <span className="add-zone-on-board">Already on the board</span>
      ) : repo.localPath !== null ? (
        <span className="add-zone-where" data-cloned="true">
          <CircleCheck />
          cloned at <span className="add-zone-mono">{repo.localPath}</span>
        </span>
      ) : (
        <span className="add-zone-where">
          <Download />
          will clone to <span className="add-zone-mono">{repo.clonePath}</span>
        </span>
      )}
    </>
  );
}
