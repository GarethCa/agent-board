import { describe, expect, it } from 'vitest';
import type { Agent, AgentRecord, PullRequest, Subagent } from '@agent-board/daemon/protocol';
import { crewSection, docSection, pullRequestSection, sectionCount, subagentSection } from './sidebar-records';

const AT = '2026-10-23T10:12:00.000Z';

const pr = (number: number, fields: Partial<PullRequest> = {}): PullRequest => ({
  number,
  title: `PR ${number}`,
  url: `https://github.com/acme/web/pull/${number}`,
  state: 'open',
  checks: 'passing',
  ...fields,
});

const prRecord = (number: number, deleted = false, title: string | null = null, repo = 'acme/web'): AgentRecord => ({
  kind: 'pr',
  key: `${repo}#${number}`,
  url: `https://github.com/${repo}/pull/${number}`,
  title,
  recordedAt: AT,
  deletedAt: deleted ? AT : null,
});

const agent = (fields: Partial<Agent> = {}): Agent =>
  ({ sessionId: 'lead', records: [], pullRequests: [], pushedPullRequests: [], recordedPullRequests: [], subagents: [], guessedDoc: null, spawnedBy: null, ...fields }) as Agent;

describe("an agent's PR section", () => {
  it('lists what it recorded first, with what gh says of each, then the guesses no record has', () => {
    const { rows, hidden } = pullRequestSection(
      agent({ records: [prRecord(241, false, 'Release notes')], pullRequests: [pr(239), pr(241, { title: 'Release 1.4 notes', checks: 'failing' })] }),
    );
    expect(rows.map(({ key, source }) => `${source} ${key}`)).toEqual(['recorded acme/web#241', 'guessed acme/web#239']);
    // gh's title and checks win once it has seen the pull request.
    expect(rows[0]!.item).toMatchObject({ number: 241, title: 'Release 1.4 notes', pr: { checks: 'failing' } });
    expect(hidden).toEqual([]);
  });

  it('shows a recorded pull request gh has not seen, on any branch, by its own title', () => {
    const { rows } = pullRequestSection(agent({ records: [prRecord(12, false, 'Bump the pin', 'acme/other')] }));
    expect(rows).toEqual([expect.objectContaining({ source: 'recorded', item: { url: 'https://github.com/acme/other/pull/12', number: 12, title: 'Bump the pin', pr: undefined } })]);
  });

  it('hides a deleted record and its guess, and says so, until it is recorded again', () => {
    const deleted = pullRequestSection(agent({ records: [prRecord(236, true), prRecord(241)], pullRequests: [pr(236), pr(241)] }));
    expect(deleted.rows.map((row) => row.key)).toEqual(['acme/web#241']);
    expect(deleted.hidden.map((record) => record.key)).toEqual(['acme/web#236']);

    const again = pullRequestSection(agent({ records: [prRecord(236), prRecord(241)], pullRequests: [pr(236), pr(241)] }));
    expect(again.rows.map(({ key, source }) => `${source} ${key}`)).toEqual(['recorded acme/web#236', 'recorded acme/web#241']);
    expect(again.hidden).toEqual([]);
  });

  it('keeps a record just deleted, gone, while its Undo is up, its guess still hidden', () => {
    const { rows, hidden } = pullRequestSection(agent({ records: [prRecord(236, true), prRecord(241)], pullRequests: [pr(236)] }), new Set(['acme/web#236']));
    expect(rows.map((row) => ({ key: row.key, gone: row.source === 'recorded' && row.gone === true }))).toEqual([
      { key: 'acme/web#236', gone: true },
      { key: 'acme/web#241', gone: false },
    ]);
    expect(hidden).toEqual([]);
    expect(sectionCount(rows)).toBe('1');
  });

  it('takes state and checks for a recorded pull request on another branch from what gh found of it by number', () => {
    const other = { ...pr(12, { title: 'Release notes', checks: 'failing' }), url: 'https://github.com/acme/other/pull/12' };
    const { rows } = pullRequestSection(agent({ records: [prRecord(12, false, null, 'acme/other')], recordedPullRequests: [other] }));
    expect(rows).toEqual([expect.objectContaining({ source: 'recorded', item: expect.objectContaining({ title: 'Release notes', pr: other }) })]);
  });

  it('is one pull request however its owner and repo are cased, so a deleted record hides gh’s guess', () => {
    // Recorded as typed; gh spells it its own way.
    const typed: AgentRecord = { ...prRecord(263, false, null, 'acme/web-app'), key: 'acme/web-app#263' };
    const fromGh = { ...pr(263), url: 'https://github.com/Acme/Web-App/pull/263' };
    expect(pullRequestSection(agent({ records: [typed], pullRequests: [fromGh] })).rows.map((row) => row.source)).toEqual(['recorded']);
    const deleted = pullRequestSection(agent({ records: [{ ...typed, deletedAt: AT }], pullRequests: [fromGh] }));
    expect(deleted).toMatchObject({ rows: [], hidden: [{ key: typed.key }] });
  });

  it('matches a guess to its record by the pull request, whatever its URL looks like', () => {
    const { rows } = pullRequestSection(agent({ records: [prRecord(7)], pushedPullRequests: [pr(7, { url: 'https://github.com/acme/web/pull/7/files' })] }));
    expect(rows.map((row) => row.source)).toEqual(['recorded']);
  });
});

describe("an orchestrator's Crew section", () => {
  const member = (sessionId: string, fields: Partial<Agent> = {}) => agent({ sessionId, name: sessionId, spawnedBy: 'lead', ...fields });
  const crew = (sessionId: string, deleted = false): AgentRecord => ({ kind: 'crew', key: sessionId, recordedAt: AT, deletedAt: deleted ? AT : null });

  it('lists the agents it recorded starting, then any other it started, and skips one no longer on the board', () => {
    const agents = [member('impl'), member('review'), member('old'), agent({ sessionId: 'someone' })];
    const { rows } = crewSection(agent({ records: [crew('impl'), crew('gone'), crew('review')] }), agents);
    expect(rows.map(({ key, source }) => `${source} ${key}`)).toEqual(['recorded impl', 'recorded review', 'guessed old']);
  });

  it('neither shows nor counts as hidden a deleted crew record whose agent has left the board', () => {
    expect(crewSection(agent({ records: [crew('gone', true)] }), [])).toEqual({ rows: [], hidden: [] });
  });

  it('hides a crew member whose record was deleted, ended or not', () => {
    const { rows, hidden } = crewSection(agent({ records: [crew('impl', true)] }), [member('impl', { endedAt: AT })]);
    expect(rows).toEqual([]);
    expect(hidden.map((record) => record.key)).toEqual(['impl']);
  });
});

describe("an agent's Hand-off docs section", () => {
  const doc = (path: string, from: { sessionId: string; name: string } | null = null, deleted = false): AgentRecord => ({
    kind: 'doc',
    key: path,
    path,
    from,
    recordedAt: AT,
    deletedAt: deleted ? AT : null,
  });

  it('lists its own docs and its crew’s for it, then its worktree’s handover as a guess', () => {
    const from = { sessionId: 'impl', name: 'Fix checkout flake' };
    const { rows } = docSection(agent({ records: [doc('/wt/plan.md'), doc('/impl/findings.md', from)], guessedDoc: '/wt/.agent-board/handover.md' }));
    expect(rows.map(({ source, item }) => `${source} ${item.path} ${item.from?.name ?? 'own'}`)).toEqual([
      'recorded /wt/plan.md own',
      'recorded /impl/findings.md Fix checkout flake',
      'guessed /wt/.agent-board/handover.md own',
    ]);
  });

  it('shows the handover as recorded once it is, and hides it once that record is deleted', () => {
    const handover = '/wt/.agent-board/handover.md';
    expect(docSection(agent({ records: [doc(handover)], guessedDoc: handover })).rows.map((row) => row.source)).toEqual(['recorded']);
    expect(docSection(agent({ records: [doc(handover, null, true)], guessedDoc: handover }))).toMatchObject({ rows: [], hidden: [{ key: handover }] });
  });
});

describe('section counts', () => {
  it('says how many rows, and how many are guessed', () => {
    const { rows } = pullRequestSection(agent({ records: [prRecord(241)], pullRequests: [pr(239), pr(241)] }));
    expect(sectionCount(rows)).toBe('2 · 1 guessed');
    expect(sectionCount(rows.slice(0, 1))).toBe('1');
    const subagent: Subagent = { id: 's1', type: 'general-purpose', state: 'running', startedAt: AT, endedAt: null, result: null };
    expect(sectionCount(subagentSection(agent({ subagents: [subagent] })).rows)).toBe('1 · guessed');
    expect(sectionCount([])).toBe('None');
  });
});
