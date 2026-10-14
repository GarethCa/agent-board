import { expect, it } from 'vitest';
import type { Tracker, TrackerIssue } from '../src/index.ts';
import { CONTRACT_COMMENT, CONTRACT_LINK, MISSING_ISSUE_SUFFIX, MISSING_PROJECT_ID } from './contract-calls.ts';

export interface ContractSubject {
  tracker: Tracker;
  /** A scope the tracker has. */
  scope: string;
  /** An open issue in that scope, exactly as `getIssue` returns it. */
  knownIssue: TrackerIssue;
  /** A word in at least one issue of the scope, not in its ID. */
  searchTerm: string;
  /** What the issue's branch starts with: its lowercase ID by default. */
  branchPrefix?: string;
  /** For a tracker with projects: an open project of that scope, and `knownIssue` is in it. */
  project?: string;
}

/** What every `Tracker` must do, whichever tracker is behind it. */
export function trackerContract(name: string, subject: () => ContractSubject): void {
  it(`${name}: lists its scopes`, async () => {
    const { tracker, scope } = subject();
    expect((await tracker.scopes()).map((s) => s.key)).toContain(scope);
  });

  it(`${name}: gets a scope by its key, and nothing for an unknown key`, async () => {
    const { tracker, scope } = subject();
    expect(await tracker.getScope(scope)).toEqual((await tracker.scopes()).find((s) => s.key === scope));
    expect(await tracker.getScope(`${scope}${MISSING_ISSUE_SUFFIX}`)).toBeUndefined();
  });

  it(`${name}: lists open issues in a scope`, async () => {
    const { tracker, scope, knownIssue } = subject();
    const issues = await tracker.listIssues(scope);
    expect(issues).toContainEqual(knownIssue);
    for (const issue of issues) expect(issue).toMatchObject({ provider: tracker.provider, scope });
  });

  it(`${name}: lists a scope's open projects, and its issues by project`, async (context) => {
    const { tracker, scope, knownIssue, searchTerm, project } = subject();
    if (tracker.projects === undefined || tracker.getProject === undefined) return context.skip();
    if (project === undefined) return context.skip();
    expect((await tracker.projects(scope)).map((p) => p.id)).toContain(project);
    expect(await tracker.getProject(scope, project)).toMatchObject({ id: project, name: expect.any(String) });
    expect(await tracker.getProject(scope, MISSING_PROJECT_ID)).toBeUndefined();
    expect(await tracker.getProject(scope, 'not-an-id')).toBeUndefined();
    expect(await tracker.listIssues(scope, { project })).toContainEqual(knownIssue);
    expect(await tracker.searchIssues(scope, searchTerm, { project })).toContainEqual(knownIssue);
  });

  it(`${name}: searches a scope's issues`, async () => {
    const { tracker, scope, searchTerm } = subject();
    const found = await tracker.searchIssues(scope, searchTerm);
    expect(found.length).toBeGreaterThan(0);
    for (const issue of found) {
      expect(issue.scope).toBe(scope);
      expect(`${issue.title} ${issue.description}`.toLowerCase()).toContain(searchTerm);
    }
  });

  it(`${name}: gets an issue by its ID, and nothing for an unknown ID`, async () => {
    const { tracker, knownIssue } = subject();
    expect(await tracker.getIssue(knownIssue.id)).toEqual(knownIssue);
    expect(await tracker.getIssue(`${knownIssue.id}${MISSING_ISSUE_SUFFIX}`)).toBeUndefined();
  });

  it(`${name}: links a URL to an issue and comments on it`, async () => {
    const { tracker, knownIssue } = subject();
    await tracker.link(knownIssue.id, CONTRACT_LINK);
    await tracker.comment(knownIssue.id, CONTRACT_COMMENT);
  });

  it(`${name}: names an issue's branch from its ID`, () => {
    const { tracker, knownIssue, branchPrefix = knownIssue.id.toLowerCase() } = subject();
    expect(tracker.branchName(knownIssue)).toMatch(new RegExp(`^${branchPrefix}-[a-z0-9-]+$`));
  });
}
