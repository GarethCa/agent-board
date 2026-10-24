// What a merge gate run allows: Open PR once it passed on the agent's head, Merge once it passed on the pull
// request's head and GitHub's checks are green, each saying why not otherwise; and what the run reads as on a tile and
// in a pull request. Pure, with no Node imports: the app shows the reasons the daemon enforces.
import { pullRequestOfUrl } from '@agent-board/tracker/pull-request-ref';
import type { GateStep } from './gate-output.ts';

/** How a gate run is doing, or how it ended: `stopped` when the user stopped it, or the daemon went away under it. */
export type GateRunStatus = 'running' | 'passed' | 'failed' | 'stopped';

/** One run of a zone's gate command in an agent's worktree, the latest of which the daemon keeps per agent. */
export interface GateRun {
  /** The agent whose worktree it ran in. */
  sessionId: string;
  /** The command, as the zone had it when the run started. */
  command: string;
  /** The commit the worktree was at when it started: what a pass covers. */
  commit: string;
  /** Whether the worktree had uncommitted changes when it started, so a pass covers no commit. */
  dirty: boolean;
  startedAt: string;
  /** Null while it runs. */
  endedAt: string | null;
  status: GateRunStatus;
  /** How the command exited: null while it runs, and when it was stopped or a signal ended it. */
  exitCode: number | null;
  /** Its steps, in order (`gate-output.ts`). */
  steps: GateStep[];
}

/** What a pull request needs, besides the gate, to be merged from the app: GitHub's say. */
export interface MergeFacts {
  headCommit: string;
  checksState: 'passing' | 'failing' | 'pending' | 'none';
  checks: readonly { name: string; state: 'passing' | 'failing' | 'pending' | 'skipped' }[];
  /** GitHub's own verdict, from `allowedActions`. */
  merge: { allowed: true } | { allowed: false; why: string };
}

export const shortCommit = (commit: string): string => commit.slice(0, 7);

const finished = (step: GateStep) => step.status === 'passed' || step.status === 'failed';

/** The run in a word, for its tile's badge: `gate 3/5 · test` while it runs, `✓ gate 5/5`, `✗ gate · e2e`, or `gate stopped`. */
export function gateBadge(run: GateRun): string {
  const total = run.steps.length;
  switch (run.status) {
    case 'running': {
      const running = run.steps.find((step) => step.status === 'running');
      const done = `gate ${run.steps.filter(finished).length}/${total}`;
      return running === undefined ? done : `${done} · ${running.name}`;
    }
    case 'passed':
      return `✓ gate ${total}/${total}`;
    case 'failed': {
      const failed = run.steps.find((step) => step.status === 'failed');
      return failed === undefined ? `✗ gate · exit ${run.exitCode ?? '?'}` : `✗ gate · ${failed.name}`;
    }
    case 'stopped':
      return 'gate stopped';
  }
}

/** How long a step took: `14s`, `1m 30s`; empty until it has ended. */
export function stepTime(step: Pick<GateStep, 'startedAt' | 'endedAt'>): string {
  if (step.startedAt === null || step.endedAt === null) return '';
  return duration(Date.parse(step.endedAt) - Date.parse(step.startedAt));
}

/** `14s`, `1m 30s`. */
export function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

const STEP_RESULTS: Record<GateStep['status'], string> = { passed: 'pass', failed: 'FAIL', stopped: 'stopped', running: 'running', waiting: 'not run' };

/** The run as Markdown, the way `pnpm check:local` prints its table: what a PR it opens carries. */
export function gateTable(run: GateRun): string {
  return [
    `Gate \`${run.command}\` on \`${shortCommit(run.commit)}\`${run.dirty ? ' (with uncommitted changes)' : ''}:`,
    '',
    '| Step | Result | Time |',
    '| --- | --- | --- |',
    ...run.steps.map((step) => `| \`${step.name}\` | ${STEP_RESULTS[step.status]} | ${stepTime(step)} |`),
  ].join('\n');
}

/** Why the run doesn't count as a pass on `commit`, or undefined when it does. */
function gateBlocked(run: GateRun | undefined, commit: string, notRun: string): string | undefined {
  const at = shortCommit(commit);
  if (run === undefined) return notRun;
  if (run.commit !== commit) {
    return run.status === 'passed' ? `Gate passed on ${shortCommit(run.commit)}, but the head is now ${at}. Run gate again.` : notRun;
  }
  switch (run.status) {
    case 'running':
      return `The gate is still running on ${at}.`;
    case 'stopped':
      return `The gate was stopped on ${at}. Run gate again.`;
    case 'failed': {
      const failed = run.steps.filter((step) => step.status === 'failed').map((step) => step.name);
      return `The gate failed on ${at}${failed.length > 0 ? `: ${failed.join(', ')}` : ''}. Open the Gate tab.`;
    }
    case 'passed':
      return run.dirty ? `The gate ran with uncommitted changes on ${at}. Commit them, then run gate again.` : undefined;
  }
}

/** What Merge's popover says in a zone with no gate command: Merge then waits for GitHub's checks alone. */
export const NO_GATE = "This zone has no gate: set one in the zone's ⋯ menu.";

/** Why the gate can't run: its agent's zone has no gate command. */
export const noGateCommand = (zone: string | undefined): string => `Set a gate command on ${zone ?? "its repo's zone"}'s tab first.`;

/**
 * What a PR tab says of, and the daemon refuses without the user's confirmation, a pull request a merge gate guards
 * whose gate hasn't passed on its head: `blocked` says why (`mergeGateBlocked`).
 */
export const pastGateWhy = (agent: string, blocked: string): string =>
  `${agent}'s gate hasn't passed on this head: ${blocked} Merging here goes past it, so it asks you to confirm.`;

/** What `gatedOwner` knows of an agent. */
export interface GateOwnerFacts {
  name: string;
  branch: string;
  /** Whether its zone has a gate command. */
  gated: boolean;
  /** Whether its pull requests have been read since the daemon started: until then, `pullRequests` says nothing. */
  read: boolean;
  /** The GitHub repo (`owner/repo`) its pull requests are in, when known. */
  repo: string | undefined;
  pullRequests: readonly { url: string }[];
}

/**
 * The agent whose gate guards the pull request: one in a zone with a gate command whose read pull requests
 * include it, or whose branch is its head (`headRefName`) in the same repo. While such an agent's pull requests in that
 * repo haven't been read yet, it is theirs too: the guard fails closed, not open. Undefined for any other pull request.
 */
export function gatedOwner<Facts extends GateOwnerFacts>({
  ref,
  headRefName,
  agents,
}: {
  ref: { repo: string; number: number };
  headRefName?: string;
  agents: readonly Facts[];
}): Facts | undefined {
  const sameRepo = (repo: string | undefined) => repo === undefined || repo.toLowerCase() === ref.repo.toLowerCase();
  return agents.find((agent) => {
    if (!agent.gated) return false;
    const own = agent.pullRequests.some((pr) => {
      const seen = pullRequestOfUrl(pr.url);
      return seen !== undefined && seen.number === ref.number && seen.repo.toLowerCase() === ref.repo.toLowerCase();
    });
    if (own) return true;
    if (headRefName !== undefined && headRefName === agent.branch && sameRepo(agent.repo)) return true;
    return !agent.read && sameRepo(agent.repo);
  });
}

/** Whether a pull request is open, as a draft or not: one the header's Merge acts on. */
export const isOpenPullRequest = (pr: { state: string }): boolean => pr.state === 'open' || pr.state === 'draft';

/**
 * Why Open PR can't be pressed yet, or undefined when it can: nothing uncommitted, and, in a zone with a gate (`gated`),
 * the gate passed on the worktree's head.
 */
export function openPullRequestBlocked(facts: { run: GateRun | undefined; head: string; uncommitted: number; gated: boolean }): string | undefined {
  if (facts.uncommitted > 0) return `Commit or stash first: the worktree has ${facts.uncommitted} uncommitted file${facts.uncommitted === 1 ? '' : 's'}.`;
  return facts.gated ? gateBlocked(facts.run, facts.head, 'Run the gate first: the PR carries its table for the head commit.') : undefined;
}

/**
 * Why Merge can't be pressed yet, or undefined when it can: GitHub's checks are green, and, in a zone with a gate
 * (`gated`), the gate passed on the PR's head.
 */
export function mergeBlocked(facts: { run: GateRun | undefined; pr: MergeFacts; gated: boolean }): string | undefined {
  return mergeGateBlocked(facts) ?? githubBlocked(facts.pr);
}

/** Merge's first condition: why the gate doesn't count for the PR's head, or undefined when it passed there (or the zone has none). */
export function mergeGateBlocked({ run, pr, gated }: { run: GateRun | undefined; pr: Pick<MergeFacts, 'headCommit'>; gated: boolean }): string | undefined {
  if (!gated) return undefined;
  return gateBlocked(run, pr.headCommit, `The gate hasn't run on ${shortCommit(pr.headCommit)}, the PR's head. Run gate.`);
}

/** Merge's second condition: why GitHub won't have it merged now, or undefined when its checks are green and it may. */
export function githubBlocked(pr: MergeFacts): string | undefined {
  const named = (state: string) => pr.checks.filter((check) => check.state === state).map((check) => check.name).join(', ');
  if (pr.checksState === 'failing') return `GitHub's checks failed: ${named('failing')}. Only GitHub can rerun them.`;
  if (pr.checksState === 'pending') return `GitHub's checks: ${named('pending')} ${pr.checks.filter((check) => check.state === 'pending').length === 1 ? 'is' : 'are'} still running.`;
  if (!pr.merge.allowed) return `GitHub won't merge it: ${pr.merge.why.charAt(0).toLowerCase()}${pr.merge.why.slice(1)}`;
  return undefined;
}

/**
 * A Markdown document's sections: what comes before its first `## ` heading, then each heading's text and body. A `## `
 * line inside a fenced code block is code, not a heading.
 */
function sections(markdown: string): { preamble: string; sections: { heading: string; body: string }[] } {
  const found: { heading: string; body: string[] }[] = [];
  const preamble: string[] = [];
  let fence: string | undefined;
  for (const line of markdown.split('\n')) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker !== undefined && (fence === undefined || marker.startsWith(fence))) fence = fence === undefined ? marker : undefined;
    const heading = fence === undefined && marker === undefined ? /^## +(.+?)\s*$/.exec(line) : null;
    if (heading !== null) found.push({ heading: heading[1]!, body: [] });
    else (found.at(-1)?.body ?? preamble).push(line);
  }
  return { preamble: preamble.join('\n').trim(), sections: found.map((section) => ({ heading: section.heading, body: section.body.join('\n').trim() })) };
}

/** Where the gate table goes, if the template has it. */
const VERIFY = 'how to verify';

/**
 * GitHub's (and Linear's) closing keywords before a reference: `Fixes #12`, `closes acme/app#3`, `Resolves STO-1`, or
 * one before an issue's URL. Merging a pull request whose description has one closes that issue.
 */
const CLOSING = /\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)(:?[ \t]+)(https?:\/\/\S+|[\w.-]+\/[\w.-]+#\d+|#\d+|[A-Za-z][A-Za-z0-9]*-\d+)/gi;

/**
 * The handover's text with each closing keyword and its reference put in a code span, where neither GitHub nor Linear
 * reads it: the agent writes the handover, and only the generated `Fixes <issue>` line may close anything.
 */
export function defuseClosingKeywords(text: string): string {
  return text.replace(CLOSING, (match) => `\`${match}\``);
}

/**
 * The description Open PR sends: the repo's pull request template (its comments and its own `Fixes` line taken out),
 * each of its sections filled from the agent's handover's section of the same heading when it has one (its closing
 * keywords defused), then the handover's other sections; with a gate run, its table under "How to verify" (else in a
 * Gate section at the end); and first, `Fixes <issue>` for the agent's issue. A missing template is the handover alone; a
 * missing handover leaves the template bare.
 */
export function pullRequestBody(facts: { template: string | undefined; handover: string | undefined; run: GateRun | undefined; issue: string | undefined }): string {
  const template = sections((facts.template ?? '').replace(/<!--[\s\S]*?-->/g, '').replace(/^Fixes\b.*$/gm, ''));
  const handover = sections(facts.handover ?? '').sections.map(({ heading, body }) => ({ heading, body: defuseClosingKeywords(body) }));
  const fromHandover = (heading: string) => handover.find((section) => section.heading.toLowerCase() === heading.toLowerCase());
  const filled = template.sections.map(({ heading, body }) => ({ heading, body: fromHandover(heading)?.body ?? body }));
  const rest = handover.filter((section) => !template.sections.some((each) => each.heading.toLowerCase() === section.heading.toLowerCase()));
  const all = [...filled, ...rest];
  const verify = all.find((section) => section.heading.toLowerCase() === VERIFY);
  if (facts.run !== undefined) {
    const table = gateTable(facts.run);
    if (verify === undefined) all.push({ heading: 'Gate', body: table });
    else verify.body = verify.body === '' ? table : `${verify.body}\n\n${table}`;
  }
  return [
    ...(facts.issue === undefined ? [] : [`Fixes ${facts.issue}`]),
    ...(template.preamble === '' ? [] : [template.preamble]),
    ...all.map(({ heading, body }) => (body === '' ? `## ${heading}` : `## ${heading}\n\n${body}`)),
  ].join('\n\n');
}

/**
 * The gate command as the process it runs (ADR-0013): the user's own text through `/bin/sh -c`, so it may chain,
 * pipe and expand as in a terminal. Nothing else is ever put into it. Throws for an empty command.
 */
export function gateCommandArgv(command: string): string[] {
  const text = command.trim();
  if (text === '') throw new Error('The gate command is empty.');
  return ['/bin/sh', '-c', text];
}

/**
 * What happens after a merge from the app: close the agent (end it and take it off the board), remove its
 * worktree (only with `close`), delete its branch here and on GitHub (only with `worktree`), and comment on its issue
 * with the pull request and the gate.
 */
export interface GateCleanup {
  close: boolean;
  worktree: boolean;
  branch: boolean;
  comment: boolean;
}

/** Every clean-up step after a merge, as Merge's popover offers them first. */
export const ALL_CLEANUP: GateCleanup = { close: true, worktree: true, branch: true, comment: true };

/** Why the clean-up can't be: a worktree removed with its agent left running, or a branch deleted with its worktree kept. */
export function cleanupProblem(cleanup: GateCleanup): string | undefined {
  if (cleanup.worktree && !cleanup.close) return 'its worktree is removed only with the agent closed';
  if (cleanup.branch && !cleanup.worktree) return 'its branch is deleted only with its worktree removed';
  return undefined;
}

/**
 * The clean-up once one box is ticked or cleared, kept clear of `cleanupProblem`: ticking one ticks what it needs, and
 * clearing one clears what needs it.
 */
export function withCleanup(cleanup: GateCleanup, step: keyof GateCleanup, on: boolean): GateCleanup {
  const next = { ...cleanup, [step]: on };
  if (on && step === 'branch') next.worktree = true;
  if (on && (step === 'branch' || step === 'worktree')) next.close = true;
  if (!on && step === 'close') next.worktree = false;
  if (!on && (step === 'close' || step === 'worktree')) next.branch = false;
  return next;
}

/** The last `count` lines of `text`, without its final line break. */
export function logTail(text: string, count: number): string {
  return text.replace(/\n$/, '').split('\n').slice(-count).join('\n');
}

/** How many of the failing step's lines "Send failure" pastes. */
const FAILURE_LINES = 30;

/** Escapes and control characters, which a paste must never carry: `ESC[201~` in it would end the paste early. */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROLS = /\u001b\[[0-9;?]*[ -/]*[@-~]|[\u0000-\u0008\u000b-\u001f\u007f]/g;

/**
 * What "Send failure to the agent" pastes at its prompt: which step failed on which commit, and its last lines, as one
 * bracketed paste with no Enter after it, so the user reads it and sends it, or not.
 */
export function failurePaste(run: GateRun, step: string, log: string): string {
  const lines = logTail(log.replace(CONTROLS, ''), FAILURE_LINES);
  const text = `The gate \`${run.command.replace(CONTROLS, '')}\` failed on ${shortCommit(run.commit)}: ${step.replace(CONTROLS, '')}. Its last lines:\n\n\`\`\`\n${lines}\n\`\`\`\n`;
  return `\u001b[200~${text}\u001b[201~`;
}

/**
 * Whether the agent works in its repo's own checkout, with no worktree of its own: on whatever branch is checked out
 * there, usually the default one. It never opens a pull request, merges or pushes (`inCheckoutWhy`), so nothing it does
 * through the app can reach that branch. Not an agent in its group's own folder, which is no repo at all.
 */
export function inRepoCheckout(agent: { ownsWorktree: boolean; worktree: string; repoRoot: string; plainFolder: boolean }): boolean {
  return !agent.ownsWorktree && !agent.plainFolder && agent.worktree === agent.repoRoot;
}

/** Why an agent in its group's own folder has no gate, pull request or merge: there is no repo. */
export function noRepoWhy(name: string): string {
  return `${name} has no repo: it works in its group's own folder, outside git, so it has no gate, pull request or merge.`;
}

/** Why an agent in the repo's own checkout can't open a pull request or merge one, for the app, the CLI and the MCP tool. */
export function inCheckoutWhy(name: string): string {
  return `${name} works in the repo's own checkout, on the branch checked out there, so it never opens a pull request or merges. Make a branch in a worktree first, or have an agent it starts do the work.`;
}
