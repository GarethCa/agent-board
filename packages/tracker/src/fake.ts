import {
  issueBranchName,
  TrackerError,
  type IssueLink,
  type IssueListOptions,
  type Tracker,
  type TrackerIssue,
  type TrackerMilestone,
  type TrackerProject,
  type TrackerScope,
} from './tracker.ts';

/**
 * Issues the fake tracker starts with: team ACME's, newest first, the last one done, then one of team OPS.
 * Each has the `project` it is in; ACME-12 is in none of `FAKE_PROJECTS`.
 */
export const FAKE_ISSUES: readonly TrackerIssue[] = [
  {
    provider: 'linear',
    id: 'ACME-16',
    scope: 'ACME',
    title: 'Tracker interface with Linear: link and start agents from issues',
    description: 'Credentials (Linear API key or OAuth) are stored in the OS keychain.',
    url: 'https://linear.app/acme/issue/ACME-16/tracker-interface-with-linear',
    state: 'In Progress',
    project: 'fake-project-tracker',
  },
  {
    provider: 'linear',
    id: 'ACME-12',
    scope: 'ACME',
    title: 'Spawn agents in a PTY',
    description: '',
    url: 'https://linear.app/acme/issue/ACME-12/spawn-agents-in-a-pty',
    state: 'Todo',
  },
  {
    provider: 'linear',
    id: 'ACME-2',
    scope: 'ACME',
    title: 'Test harness and CI',
    description: 'Fake claude and codex CLIs.',
    url: 'https://linear.app/acme/issue/ACME-2/test-harness-and-ci',
    state: 'Done',
    project: 'fake-project-harness',
  },
  {
    provider: 'linear',
    id: 'OPS-3',
    scope: 'OPS',
    title: 'Rotate the keychain signing certificate',
    description: '',
    url: 'https://linear.app/acme/issue/OPS-3/rotate-the-keychain-signing-certificate',
    state: 'Todo',
  },
];

export const FAKE_SCOPES: readonly TrackerScope[] = [
  { key: 'ACME', name: 'JarvisBoard' },
  { key: 'OPS', name: 'Operations' },
];

/** Team ACME's projects in the fake tracker (team OPS has none): one open, one completed. */
export const FAKE_PROJECTS: readonly (TrackerProject & { scope: string })[] = [
  {
    scope: 'ACME',
    id: 'fake-project-tracker',
    name: 'Tracker integration',
    description: 'Link and start agents from issues.',
    state: 'In Progress',
    progress: 0.5,
  },
  { scope: 'ACME', id: 'fake-project-agents', name: 'Agents', description: '', state: 'Planned', progress: 0 },
  { scope: 'ACME', id: 'fake-project-harness', name: 'Harness', description: '', state: 'Completed', progress: 1 },
];

/** The milestones of the fake's open projects, and the issues in each: Tracker integration's Beta holds its keychain issue. */
export const FAKE_MILESTONES: readonly (TrackerMilestone & { project: string; issues: readonly string[] })[] = [
  { project: 'fake-project-tracker', id: 'fake-milestone-beta', name: 'Beta', issues: ['ACME-16'] },
  { project: 'fake-project-tracker', id: 'fake-milestone-later', name: 'Later', issues: [] },
];

const withoutScope = ({ id, name, description, state, progress }: TrackerProject): TrackerProject => ({
  id,
  name,
  description,
  state,
  progress,
});

export interface FakeTracker extends Tracker {
  /** Every link and comment it was sent, oldest first. */
  readonly links: { id: string; link: IssueLink }[];
  readonly comments: { id: string; body: string }[];
}

/**
 * An in-memory Linear-like tracker for tests: teams ACME and OPS with `FAKE_ISSUES` (or `issues`), and ACME's
 * `FAKE_PROJECTS` (an issue's is its `project`). `Done` issues are closed, and `Completed` projects too.
 * With `refuse`, every call fails as unauthorized, as with a revoked credential. `labels` are issues' labels, by ID.
 */
export function createFakeTracker(
  options: { issues?: readonly TrackerIssue[]; refuse?: boolean; labels?: Readonly<Record<string, readonly string[]>> } = {},
): FakeTracker {
  const issues = options.issues ?? FAKE_ISSUES;
  const links: FakeTracker['links'] = [];
  const comments: FakeTracker['comments'] = [];
  const check = async () => {
    if (options.refuse) throw new TrackerError('unauthorized', 'the fake tracker refused the credential');
  };
  const inScope = async (scope: string) => {
    await check();
    if (!FAKE_SCOPES.some((s) => s.key === scope)) throw new TrackerError('rejected', `no team ${scope}`);
    return issues.filter((issue) => issue.scope === scope);
  };
  const inProject = (issue: TrackerIssue, { project, milestone }: IssueListOptions) =>
    (project === undefined || issue.project === project) &&
    (milestone === undefined || FAKE_MILESTONES.some((m) => m.id === milestone && m.issues.includes(issue.id)));
  const known = async (id: string) => {
    await check();
    if (!issues.some((issue) => issue.id === id)) throw new TrackerError('rejected', `no issue ${id}`);
  };
  return {
    provider: 'linear',
    links,
    comments,
    async scopes() {
      await check();
      return [...FAKE_SCOPES];
    },
    async getScope(key) {
      await check();
      return FAKE_SCOPES.find((scope) => scope.key === key);
    },
    async projects(scope) {
      await check();
      return FAKE_PROJECTS.filter((p) => p.scope === scope && p.state !== 'Completed').map(withoutScope);
    },
    async getProject(scope, id) {
      await check();
      return FAKE_PROJECTS.filter((p) => p.scope === scope && p.id === id).map(withoutScope)[0];
    },
    async issueFilters(scope) {
      return {
        projects: (await this.projects!(scope)).map(({ id, name }) => ({
          id,
          name,
          milestones: FAKE_MILESTONES.filter((m) => m.project === id).map((m) => ({ id: m.id, name: m.name })),
        })),
        milestones: [],
      };
    },
    async listIssues(scope, { limit = 50, ...only } = {}) {
      return (await inScope(scope))
        .filter((issue) => issue.state !== 'Done' && inProject(issue, only))
        .slice(0, limit);
    },
    async searchIssues(scope, text, { limit = 50, ...only } = {}) {
      const needle = text.toLowerCase();
      return (await inScope(scope))
        .filter(
          (issue) =>
            inProject(issue, only) &&
            `${issue.id} ${issue.title} ${issue.description}`.toLowerCase().includes(needle),
        )
        .slice(0, limit);
    },
    async getIssue(id) {
      await check();
      return issues.find((issue) => issue.id === id);
    },
    async issueLabels(id) {
      await check();
      return issues.some((issue) => issue.id === id) ? [...(options.labels?.[id] ?? [])] : undefined;
    },
    async link(id, link) {
      await known(id);
      links.push({ id, link });
    },
    async comment(id, body) {
      await known(id);
      comments.push({ id, body });
    },
    branchName: (issue) => issueBranchName(issue),
  };
}
