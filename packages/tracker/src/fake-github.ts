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
   * `cloneFrom`, and fails for one without.
   */
  repos: { nameWithOwner: string; description: string | null; cloneFrom?: string }[];
  /** How long `gh repo clone` waits, after its first progress line, before it clones: for watching or cancelling one. */
  cloneDelayMs?: number;
  /** Issues, most recently updated first. */
  issues: FakeGitHubIssue[];
  /** Pull requests, newest first. `gh pr list` in any directory sees all of them, whatever its remote. */
  pullRequests: FakeGitHubPullRequest[];
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
