import type { TrackerProvider } from './providers.ts';

/** Where a tracker's issues live: a Linear team, a GitHub repo. A zone picks one. */
export interface TrackerScope {
  /** What a zone stores: the team key (`ACME`), the `owner/repo` (as the tracker spells it). */
  key: string;
  name: string;
  /** What it is for, for a tracker that says (a GitHub repo's description). */
  description?: string;
}

/** An issue as every provider reports it. */
export interface TrackerIssue {
  provider: TrackerProvider;
  /** The ID people use, unique in the tracker: `ACME-12`, `acme/app#34`. */
  id: string;
  /** The key of the scope it belongs to: its team's key (`ACME`), its repo's `owner/repo`. */
  scope: string;
  title: string;
  /** Markdown; empty when the issue has none. */
  description: string;
  url: string;
  /** Its workflow state's name, e.g. `In Progress`, `Open`. */
  state: string;
  /** The ID of the project it is in (a `TrackerProject.id`), for a tracker that has projects; absent if it is in none. */
  project?: string;
}

/** A group of a scope's issues a tracker keeps together: a Linear project. */
export interface TrackerProject {
  /** What a zone stores: stable, unlike the name (a Linear project's ID). */
  id: string;
  name: string;
  /** What it is for; empty when it has none. */
  description: string;
  /** Its state's name, e.g. `Planned`, `In Progress`. */
  state: string;
  /** How much of it is done, from 0 to 1. */
  progress: number;
}

export interface IssueListOptions {
  /** At most this many issues; providers cap it at their own page size. */
  limit?: number;
  /** Only issues in this project (a `TrackerProject.id`), for a tracker that has projects. */
  project?: string;
}

/** A URL to attach to an issue, such as a pull request. */
export interface IssueLink {
  url: string;
  title: string;
}

/**
 * One issue tracker, already authenticated. Every method talks to the tracker; none caches. Failures are
 * `TrackerError`s.
 */
export interface Tracker {
  readonly provider: TrackerProvider;
  /**
   * For a tracker that logs in by itself (GitHub, through gh): whether that login works, as cheaply as the tracker
   * can tell. False when it is refused; other failures are `TrackerError`s.
   */
  loggedIn?(): Promise<boolean>;
  /** The teams (or repos) the credential can see. */
  scopes(): Promise<TrackerScope[]>;
  /** The scope with that key, if the credential can see it, even one `scopes()` has no room for. */
  getScope(key: string): Promise<TrackerScope | undefined>;
  /** The scope's open projects, most recently updated first; only for a tracker that has them. */
  projects?(scope: string): Promise<TrackerProject[]>;
  /** The project with that ID, if it is one of the scope's (open or not); only for a tracker that has projects. */
  getProject?(scope: string, id: string): Promise<TrackerProject | undefined>;
  /** Open issues in the scope (or in `options.project`), most recently updated first. */
  listIssues(scope: string, options?: IssueListOptions): Promise<TrackerIssue[]>;
  /** Issues in the scope (or in `options.project`) matching `text`, open or not, best match first. */
  searchIssues(scope: string, text: string, options?: IssueListOptions): Promise<TrackerIssue[]>;
  /** The issue, or undefined if there is none with that ID. */
  getIssue(id: string): Promise<TrackerIssue | undefined>;
  /**
   * A pull request by the same kind of ID as an issue (`owner/repo#34`), for a tracker that has them: its title, URL
   * and state (`Open`, `Draft`, `Merged`, `Closed`), or undefined if there is none.
   */
  getPullRequest?(id: string): Promise<Pick<TrackerIssue, 'title' | 'url' | 'state'> | undefined>;
  /** The names of the issue's labels, or undefined if there is no issue with that ID. */
  issueLabels?(id: string): Promise<string[] | undefined>;
  /** Attaches `link` to the issue. */
  link(id: string, link: IssueLink): Promise<void>;
  comment(id: string, body: string): Promise<void>;
  /** The branch an agent working on the issue gets: `acme-12-short-title`, `gh-34-short-title`. */
  branchName(issue: TrackerIssue): string;
}

/** Why a tracker call failed. */
export type TrackerErrorKind =
  /** The credential was refused. */
  | 'unauthorized'
  /** The tracker could not be reached, or answered with something other than a result. */
  | 'unavailable'
  /** The request was refused, e.g. an unknown team. */
  | 'rejected';

export class TrackerError extends Error {
  readonly kind: TrackerErrorKind;

  constructor(kind: TrackerErrorKind, message: string, options?: ErrorOptions) {
    super(message, options);
    this.kind = kind;
  }
}

/** Longest title slug in an issue's branch name. */
const MAX_TITLE_SLUG_LENGTH = 40;

/**
 * `<prefix or lowercase ID>-<title slug>`, e.g. `acme-12-spawn-agents-in-a-pty`. The slug is cut at a word boundary
 * to at most 40 characters. `prefix` replaces the ID's own letters, for IDs like `#34` (`gh` gives `gh-34`).
 */
export function issueBranchName(issue: TrackerIssue, prefix?: string): string {
  const id = slug(prefix === undefined ? issue.id : `${prefix}-${issue.id}`);
  let title = slug(issue.title);
  if (title.length > MAX_TITLE_SLUG_LENGTH) {
    const cut = title.slice(0, MAX_TITLE_SLUG_LENGTH + 1);
    const dash = cut.lastIndexOf('-');
    title = dash > 0 ? cut.slice(0, dash) : cut.slice(0, MAX_TITLE_SLUG_LENGTH);
  }
  return title === '' ? id : `${id}-${title}`;
}

/** Lowercase ASCII letters and digits joined by single dashes. */
function slug(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** An agent's first prompt for working on the issue: its ID and title, its link, then its description. */
export function issuePrompt(issue: TrackerIssue): string {
  const head = `${issue.id}: ${issue.title}\n${issue.url}`;
  const description = issue.description.trim();
  return description === '' ? head : `${head}\n\n${description}`;
}
