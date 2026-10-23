import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The fake `gh` (`bin/gh`): never reaches GitHub, answers from a state file instead. */
export const FAKE_GH = fileURLToPath(new URL('../bin/gh', import.meta.url));

/** The env var that points the fake `gh` at its state file. */
export const FAKE_GH_STATE_ENV = 'AGENT_BOARD_FAKE_GH_STATE';

/** What the fake `gh` knows: GitHub as one logged-in user sees it. */
export interface FakeGitHubState {
  /** False: every call fails as `gh` does before `gh auth login`. True by default. */
  loggedIn?: boolean;
  /**
   * The repos the user can see, most recently pushed first. `gh repo clone` clones one from the local git repo
   * `cloneFrom`, and fails for one without. Squash merges are allowed unless `squashMergeAllowed` is false.
   */
  repos: { nameWithOwner: string; description: string | null; cloneFrom?: string; squashMergeAllowed?: boolean }[];
  /** How long `gh repo clone` waits, after its first progress line, before it clones: for watching or cancelling one. */
  cloneDelayMs?: number;
  /** Issues, most recently updated first. */
  issues: FakeGitHubIssue[];
  /** Pull requests, newest first. `gh pr list` in any directory sees all of them, whatever its remote. */
  pullRequests: FakeGitHubPullRequest[];
  /** What the user may do in each repo (`gh repo view --json viewerPermission`), by `nameWithOwner`: `WRITE` unless set. */
  viewerPermissions?: Record<string, 'ADMIN' | 'MAINTAIN' | 'WRITE' | 'TRIAGE' | 'READ'>;
  /** True: every GitHub call fails as gh does once GitHub's API rate limit is reached. */
  rateLimited?: boolean;
  /** Repos whose pull requests `gh pr view` can't read, as in an org whose SAML session has lapsed: it fails, not "not found". */
  unreadableRepos?: string[];
}

export interface FakeGitHubIssue {
  repo: string;
  number: number;
  title: string;
  body: string;
  state: 'OPEN' | 'CLOSED';
  /** Its labels' names; none when left out. */
  labels?: string[];
}

export interface FakeGitHubPullRequest {
  repo: string;
  number: number;
  title: string;
  headRefName: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  isDraft: boolean;
  /** As `gh pr list --json statusCheckRollup` reports it: `CheckRun`s and `StatusContext`s. */
  statusCheckRollup: Record<string, unknown>[];
  /** The commit its head branch is at, which `gh pr merge --match-head-commit` must name; any commit when unset. */
  headRefOid?: string;
  /**
   * The commits it holds, which `gh pr list --search <sha>` finds it by, as GitHub's search does; its `headRefOid` is
   * one too.
   */
  commits?: string[];
  /** Its description: empty unless set. */
  body?: string;
  /** Its author's login: `hubot` unless set (the fake's user is `octocat`). */
  author?: string;
  /** The branch it merges into: `main` unless set. */
  baseRefName?: string;
  /** Whether it merges cleanly, as GitHub says: `MERGEABLE` unless set. */
  mergeable?: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  /** GitHub's merge state (`CLEAN`, `BLOCKED`, `BEHIND`, `DIRTY`, `UNSTABLE`, `HAS_HOOKS`, `UNKNOWN`): `CLEAN` unless set. */
  mergeStateStatus?: string;
  /** Its changed files, as the REST API's `pulls/N/files` gives them. */
  files?: { filename: string; status: string; additions: number; deletions: number; patch?: string; previous_filename?: string }[];
  /** Its reviews, oldest first. Approving through `gh api …/reviews` adds one, with the commit it approved. */
  reviews?: { author: string; state: string; body: string; submittedAt: string; commitId?: string }[];
  /** Its conversation's comments, oldest first. */
  comments?: { author: string; body: string; createdAt: string }[];
  /** Its review comments on lines of its diff, oldest first. */
  reviewComments?: { id: number; author: string; path: string; line: number | null; body: string; createdAt: string }[];
}

/** One run of the fake `gh`. */
export interface FakeGhCall {
  args: string[];
  cwd: string;
  stdin: string;
}

export const FAKE_GITHUB_STATE: FakeGitHubState = {
  repos: [
    { nameWithOwner: 'acme/app', description: 'The app' },
    { nameWithOwner: 'acme/ops', description: null },
  ],
  issues: [
    {
      repo: 'acme/app',
      number: 34,
      title: 'Fix the login redirect',
      body: 'Users land on a blank page after signing in with the keychain.',
      state: 'OPEN',
    },
    { repo: 'acme/app', number: 12, title: 'Add a dark theme', body: '', state: 'OPEN' },
    { repo: 'acme/app', number: 3, title: 'Set up CI', body: 'Run the tests on every push.', state: 'CLOSED' },
    { repo: 'acme/ops', number: 5, title: 'Rotate the deploy keys', body: '', state: 'OPEN' },
  ],
  pullRequests: [],
};

export interface FakeGitHub {
  /** A `gh` executable that runs the fake on this state: pass it wherever a `gh` command is taken. */
  readonly gh: string;
  /** Replaces the state the fake answers from. */
  setState(state: FakeGitHubState): void;
  /** The state as it is now, with what the fake's own calls changed (a pull request opened or merged). */
  state(): FakeGitHubState;
  /** Every run of the fake so far, oldest first. */
  calls(): FakeGhCall[];
}

/**
 * A fake GitHub behind a `gh` executable, for tests: `FAKE_GITHUB_STATE` unless given `state`. Removed when the
 * process exits, or with `dispose`.
 */
export function createFakeGitHub(state: FakeGitHubState = FAKE_GITHUB_STATE): FakeGitHub & { dispose(): void } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ab-fake-gh-')));
  const stateFile = join(dir, 'state.json');
  const gh = join(dir, 'gh');
  // A wrapper, so whoever runs it needs no env of its own: a daemon, or an app under test.
  writeFileSync(gh, `#!/bin/sh\n${FAKE_GH_STATE_ENV}='${stateFile}' exec '${FAKE_GH}' "$@"\n`);
  chmodSync(gh, 0o755);
  const setState = (next: FakeGitHubState) => writeFileSync(stateFile, JSON.stringify(next));
  setState(state);
  const dispose = () => {
    process.off('exit', dispose);
    rmSync(dir, { recursive: true, force: true });
  };
  process.once('exit', dispose);
  return {
    gh,
    setState,
    state: () => JSON.parse(readFileSync(stateFile, 'utf8')) as FakeGitHubState,
    calls() {
      let log: string;
      try {
        log = readFileSync(callLog(stateFile), 'utf8');
      } catch {
        return [];
      }
      return log
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as FakeGhCall);
    },
    dispose,
  };
}

/** Where the fake `gh` appends its calls, one JSON line each. */
export function callLog(stateFile: string): string {
  return `${stateFile}.calls.jsonl`;
}
