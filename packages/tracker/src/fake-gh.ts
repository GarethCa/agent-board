// The fake `gh` (bin/gh): answers the few commands agent-board runs from a state file, the way the real `gh` 2.x
// does (output shapes, error messages and exit codes were taken from it), and logs every call. Never reaches GitHub.
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import {
  callLog,
  FAKE_GH_STATE_ENV,
  type FakeGitHubIssue,
  type FakeGitHubPullRequest,
  type FakeGitHubState,
} from './fake-github.ts';

class GhExit extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

interface Command {
  words: string[];
  flags: Map<string, string>;
  /** What follows `--`: for `repo clone`, git's own flags. */
  passthrough: string[];
}

const FLAG_ALIASES: Record<string, string> = { '-R': '--repo', '-L': '--limit', '-S': '--search', '-H': '--head', '-F': '--body-file' };

/** Flags that take no value. */
const SWITCHES = new Set(['--squash']);

function parse(argv: string[]): Command {
  const words: string[] = [];
  const flags = new Map<string, string>();
  const end = argv.indexOf('--');
  const own = end === -1 ? argv : argv.slice(0, end);
  for (let i = 0; i < own.length; i++) {
    const arg = own[i]!;
    if (SWITCHES.has(arg)) flags.set(arg, '');
    else if (arg.startsWith('-') && arg !== '-') flags.set(FLAG_ALIASES[arg] ?? arg, own[++i] ?? '');
    else words.push(arg);
  }
  return { words, flags, passthrough: end === -1 ? [] : argv.slice(end + 1) };
}

function answer(state: FakeGitHubState, { words, flags }: Command): unknown {
  const command = words.slice(0, 2).join(' ');
  const fields = (flags.get('--json') ?? '').split(',').filter(Boolean);
  if (command === 'api user') return { login: 'octocat' };
  if (command.startsWith('api ') && words[1]!.startsWith('user/repos')) {
    return state.repos.map((repo) => ({
      full_name: repo.nameWithOwner,
      name: repo.nameWithOwner.split('/')[1],
      description: repo.description,
    }));
  }
  if (command === 'repo view') {
    const repo = findRepo(state, words[2]!);
    return pick({ nameWithOwner: repo.nameWithOwner, name: repo.nameWithOwner.split('/')[1], description: repo.description }, fields);
  }
  if (command === 'issue list') {
    const repo = findRepo(state, flags.get('--repo') ?? '').nameWithOwner;
    const status = flags.get('--state') ?? 'open';
    const terms = (flags.get('--search') ?? '')
      .toLowerCase()
      .split(/\s+/)
      .filter((term) => term !== '' && !term.includes(':'));
    return state.issues
      .filter((issue) => issue.repo === repo && (status === 'all' || issue.state === status.toUpperCase()))
      .filter((issue) => terms.every((term) => `${issue.title} ${issue.body}`.toLowerCase().includes(term)))
      .slice(0, Number(flags.get('--limit') ?? 30))
      .map((issue) => pick(issueJson(issue), fields));
  }
  if (command === 'issue view' || command === 'issue comment') {
    const repo = findRepo(state, flags.get('--repo') ?? '').nameWithOwner;
    const number = Number(words[2]);
    // Issues and pull requests share numbers, and `gh issue view` shows either.
    const found =
      state.issues.find((issue) => issue.repo === repo && issue.number === number) ??
      state.pullRequests.find((pr) => pr.repo === repo && pr.number === number);
    if (found === undefined) {
      throw new GhExit(
        1,
        `GraphQL: Could not resolve to an issue or pull request with the number of ${words[2]}. (repository.issue)`,
      );
    }
    if (command === 'issue comment') return `https://github.com/${repo}/issues/${number}#issuecomment-1`;
    return pick('headRefName' in found ? pullRequestJson(found) : issueJson(found), fields);
  }
  if (command === 'pr view') {
    const repo = findRepo(state, flags.get('--repo') ?? '').nameWithOwner;
    const found = state.pullRequests.find((pr) => pr.repo === repo && pr.number === Number(words[2]));
    if (found === undefined) {
      throw new GhExit(1, `GraphQL: Could not resolve to an issue or pull request with the number of ${words[2]}. (repository.pullRequest)`);
    }
    return pick(pullRequestJson(found), fields);
  }
  if (command === 'pr list') {
    const repo = flags.get('--repo') ?? remoteRepo();
    const head = flags.get('--head');
    return state.pullRequests
      .filter((pr) => pr.repo.toLowerCase() === repo.toLowerCase())
      .filter((pr) => head === undefined || pr.headRefName === head)
      .slice(0, Number(flags.get('--limit') ?? 30))
      .map((pr) => pick(pullRequestJson(pr), fields));
  }
  throw new GhExit(1, `fake gh: unknown command: ${words.join(' ')}`);
}

/**
 * `gh repo clone <repo> <dir> [-- <git flags>]`: clones the repo's `cloneFrom` with the real git, which prints its own
 * progress to stderr, as gh lets it. With `cloneDelayMs`, it prints a first progress line and waits before cloning.
 */
function cloneRepo(state: FakeGitHubState, { words, passthrough }: Command): void {
  const repo = findRepo(state, words[2] ?? '');
  const dir = words[3] ?? repo.nameWithOwner.split('/')[1]!;
  if (repo.cloneFrom === undefined) throw new GhExit(1, `fake gh: ${repo.nameWithOwner} has no cloneFrom to clone`);
  process.stderr.write(`Cloning into '${dir}'...\nremote: Enumerating objects: 0% (0/1)\r`);
  if (state.cloneDelayMs !== undefined) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, state.cloneDelayMs);
  try {
    execFileSync('git', ['clone', '--quiet', ...passthrough, repo.cloneFrom, dir], { stdio: ['ignore', 'ignore', 'inherit'] });
    // As gh leaves it: origin is the repo on GitHub.
    execFileSync('git', ['-C', dir, 'remote', 'set-url', 'origin', `https://github.com/${repo.nameWithOwner}.git`]);
  } catch (error) {
    throw new GhExit((error as { status?: number }).status ?? 1, 'failed to run git: git clone failed');
  }
}

/** `gh pr merge <number> [--repo <repo>] --squash`: merges an open pull request, saying so on stderr as gh does. */
function mergePullRequest(state: FakeGitHubState, stateFile: string, { words, flags }: Command): void {
  const repo = flags.get('--repo') ?? remoteRepo();
  const number = Number(words[2]);
  const found = state.pullRequests.find((pr) => pr.repo.toLowerCase() === repo.toLowerCase() && pr.number === number);
  if (found === undefined) {
    throw new GhExit(1, `GraphQL: Could not resolve to a PullRequest with the number of ${words[2]}. (repository.pullRequest)`);
  }
  if (found.state === 'MERGED') throw new GhExit(1, `X Pull request ${repo}#${number} was already merged`);
  if (found.state === 'CLOSED') throw new GhExit(1, `X Pull request ${repo}#${number} is closed`);
  const head = flags.get('--match-head-commit');
  if (head !== undefined && found.headRefOid !== undefined && head !== found.headRefOid) {
    throw new GhExit(1, 'GraphQL: Head branch was modified. Review and try the merge again. (mergePullRequest)');
  }
  const pullRequests = state.pullRequests.map((pr) => (pr === found ? { ...pr, state: 'MERGED' as const } : pr));
  writeFileSync(stateFile, JSON.stringify({ ...state, pullRequests }));
  process.stderr.write(`✓ Squashed and merged pull request ${repo}#${number} (${found.title})\n`);
}

/** Remote names gh prefers, in order, when it infers the repo from the current directory's remotes. */
const REMOTE_PREFERENCE = ['upstream', 'github', 'origin'];

/** The GitHub repo gh infers from the current directory's git remotes, failing as gh does when there is none. */
function remoteRepo(): string {
  let lines: string[];
  try {
    lines = execFileSync('git', ['remote', '-v'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      .split('\n')
      .filter(Boolean);
  } catch (error) {
    throw new GhExit(1, `failed to run git: ${String((error as { stderr?: string }).stderr ?? error).trim()}`);
  }
  if (lines.length === 0) throw new GhExit(1, 'no git remotes found');
  const remotes = new Map<string, string>();
  for (const line of lines) {
    const [name, url] = line.split(/\s+/);
    const repo = /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(url ?? '')?.[1];
    if (name !== undefined && repo !== undefined) remotes.set(name, repo);
  }
  const preferred = [...REMOTE_PREFERENCE.filter((name) => remotes.has(name)), ...remotes.keys()][0];
  if (preferred === undefined) {
    throw new GhExit(
      1,
      'none of the git remotes configured for this repository point to a known GitHub host. ' +
        'To tell gh about a new GitHub host, please use `gh auth login`',
    );
  }
  return remotes.get(preferred)!;
}

function findRepo(state: FakeGitHubState, name: string) {
  const repo = state.repos.find((r) => r.nameWithOwner.toLowerCase() === name.toLowerCase());
  if (repo === undefined) {
    throw new GhExit(1, `GraphQL: Could not resolve to a Repository with the name '${name}'. (repository)`);
  }
  return repo;
}

function issueJson(issue: FakeGitHubIssue) {
  return {
    ...issue,
    url: `https://github.com/${issue.repo}/issues/${issue.number}`,
    labels: (issue.labels ?? []).map((name) => ({ name })),
  };
}

function pullRequestJson(pr: FakeGitHubPullRequest) {
  return { ...pr, body: '', labels: [], url: `https://github.com/${pr.repo}/pull/${pr.number}` };
}

/** Only the asked-for fields, keys sorted, as `gh --json` prints them. */
function pick(record: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  return Object.fromEntries(fields.sort().map((field) => [field, record[field] ?? null]));
}

/** The version the fake reports for `gh --version`. */
const FAKE_GH_VERSION = '2.0.0';

/**
 * `gh auth status`, which fails while logged out, and `gh auth login` (any flags), which logs in at once as octocat, as
 * if the user had finished the browser flow.
 */
function auth(state: FakeGitHubState, stateFile: string, command: string | undefined): void {
  if (command === 'login') {
    writeFileSync(stateFile, JSON.stringify({ ...state, loggedIn: true }));
    process.stderr.write('✓ Logged in as octocat\n');
    return;
  }
  if (command !== 'status') throw new GhExit(1, `fake gh: unknown command: auth ${command ?? ''}`);
  if (state.loggedIn === false) {
    throw new GhExit(1, 'You are not logged into any GitHub hosts. To log in, run: gh auth login');
  }
  process.stderr.write('github.com\n  ✓ Logged in to github.com account octocat (keyring)\n');
}

main();

function main(): void {
  const args = process.argv.slice(2);
  const stateFile = process.env[FAKE_GH_STATE_ENV];
  try {
    if (stateFile === undefined) throw new GhExit(1, `fake gh: ${FAKE_GH_STATE_ENV} is not set`);
    const stdin = args.includes('-') ? readFileSync(0, 'utf8') : '';
    appendFileSync(callLog(stateFile), `${JSON.stringify({ args, cwd: process.cwd(), stdin })}\n`);
    const state = JSON.parse(readFileSync(stateFile, 'utf8')) as FakeGitHubState;
    if (args[0] === '--version') {
      process.stdout.write(`gh version ${FAKE_GH_VERSION} (fake)\n`);
      return;
    }
    if (args[0] === 'auth') {
      auth(state, stateFile, args[1]);
      return;
    }
    if (state.loggedIn === false) {
      throw new GhExit(
        4,
        'To get started with GitHub CLI, please run:  gh auth login\n' +
          'Alternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.',
      );
    }
    const command = parse(args);
    if (command.words[0] === 'repo' && command.words[1] === 'clone') cloneRepo(state, command);
    else if (command.words[0] === 'pr' && command.words[1] === 'merge') mergePullRequest(state, stateFile, command);
    else process.stdout.write(`${JSON.stringify(answer(state, command))}\n`);
  } catch (error) {
    if (!(error instanceof GhExit)) throw error;
    process.stderr.write(`${error.message}\n`);
    process.exitCode = error.code;
  }
}
