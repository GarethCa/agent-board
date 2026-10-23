// What an agent's sidebar lists in each section: what it recorded (`Agent.records`) first, then what the daemon
// guessed (gh, hooks) of entries it didn't record. A record the user deleted hides the entry, guess included, until the
// agent records it again. Pure, so it is unit-tested.
import { pullRequestKey, pullRequestOfUrl } from '@agent-board/tracker/pull-request-ref';
import type { Agent, AgentRecord, AgentRecordKind, PullRequest, Subagent } from '@agent-board/daemon/protocol';

/**
 * One row of a section: recorded (with its record, which the user may delete) or guessed. A record the user just
 * deleted stays a moment, `gone`, while its Undo is up.
 */
export type SidebarRow<T> = { key: string; item: T } & ({ source: 'recorded'; record: AgentRecord; gone?: true } | { source: 'guessed' });

export interface SidebarSection<T> {
  rows: SidebarRow<T>[];
  /** The records the user deleted, which hide their guesses too: what the section's foot says it hides. */
  hidden: AgentRecord[];
}

/** A pull request row: its number and title, its state and checks once gh has seen it. */
export interface PullRequestRow {
  url: string;
  number: number;
  title: string | null;
  pr: PullRequest | undefined;
}

/** A crew row: the agent it started. */
export type CrewRow = Pick<Agent, 'sessionId' | 'name' | 'state' | 'role' | 'roleName' | 'endedAt'>;

/** A hand-off doc row: its path, and the crew member that recorded it for this orchestrator, if one did. */
export interface DocRow {
  path: string;
  from: { sessionId: string; name: string } | null;
}

/** A pull request's key, as its record's (`pullRequestKey`); its URL for one that names no GitHub pull request. */
function pullRequestKeyOf(url: string): string {
  const ref = pullRequestOfUrl(url);
  return ref === undefined ? url : pullRequestKey(ref);
}

/** The keys of the records the user just deleted, shown `gone` a moment longer. */
export type Fading = ReadonlySet<string>;

const NONE_FADING: Fading = new Set();

/**
 * A section's rows: each live record of `kind` as `recorded` (or skipped when `item` gives none for it), then each guess
 * whose key no record has; a deleted record's guess is hidden, and the record too unless it is `fading`.
 */
function section<T>(
  records: readonly AgentRecord[],
  kind: AgentRecordKind,
  item: (record: AgentRecord) => T | undefined,
  guesses: readonly { key: string; item: T }[],
  fading: Fading,
): SidebarSection<T> {
  const own = records.filter((record) => record.kind === kind);
  const recorded = new Set(own.map((record) => record.key));
  const rows: SidebarRow<T>[] = [];
  const hidden: AgentRecord[] = [];
  for (const record of own) {
    // One it can't draw (a crew member no longer on the board) is neither shown nor hidden.
    const shown = item(record);
    if (shown === undefined) continue;
    const deleted = record.deletedAt !== null;
    if (deleted && !fading.has(record.key)) hidden.push(record);
    else rows.push({ key: record.key, item: shown, source: 'recorded', record, ...(deleted ? { gone: true as const } : {}) });
  }
  for (const guess of guesses) if (!recorded.has(guess.key)) rows.push({ ...guess, source: 'guessed' });
  return { rows, hidden };
}

/**
 * The PR section: the pull requests it recorded, with what gh says of each (found on its branches, or asked about by
 * number), then those gh found of its branches.
 */
export function pullRequestSection(
  agent: Pick<Agent, 'records' | 'pullRequests' | 'pushedPullRequests' | 'recordedPullRequests'>,
  fading = NONE_FADING,
): SidebarSection<PullRequestRow> {
  const seen = [...agent.pullRequests, ...agent.pushedPullRequests];
  const byKey = new Map([...seen, ...agent.recordedPullRequests].map((pr) => [pullRequestKeyOf(pr.url), pr]));
  return section(
    agent.records,
    'pr',
    (record) => {
      if (record.kind !== 'pr') return undefined;
      const pr = byKey.get(record.key);
      return { url: record.url, number: pullRequestOfUrl(record.url)?.number ?? 0, title: pr?.title ?? record.title, pr };
    },
    seen.map((pr) => ({ key: pullRequestKeyOf(pr.url), item: { url: pr.url, number: pr.number, title: pr.title, pr } })),
    fading,
  );
}

/**
 * The Crew section: the agents it recorded starting that are still on the board, then any other agent it started (one
 * started before records were kept). `agents` is every agent.
 */
export function crewSection(agent: Pick<Agent, 'sessionId' | 'records'>, agents: readonly Agent[], fading = NONE_FADING): SidebarSection<CrewRow> {
  const byId = new Map(agents.map((each) => [each.sessionId, each]));
  return section(
    agent.records,
    'crew',
    (record) => byId.get(record.key),
    agents.filter((each) => each.spawnedBy === agent.sessionId).map((each) => ({ key: each.sessionId, item: each })),
    fading,
  );
}

/** The Hand-off docs section: the docs recorded on it, its own and its crew's for it, then its worktree's handover. */
export function docSection(agent: Pick<Agent, 'records' | 'guessedDoc'>, fading = NONE_FADING): SidebarSection<DocRow> {
  return section(
    agent.records,
    'doc',
    (record) => (record.kind === 'doc' ? { path: record.path, from: record.from } : undefined),
    agent.guessedDoc === null ? [] : [{ key: agent.guessedDoc, item: { path: agent.guessedDoc, from: null } }],
    fading,
  );
}

/** The Subagents section: none is ever recorded, so every one is guessed from hooks. */
export function subagentSection(agent: Pick<Agent, 'subagents'>): SidebarSection<Subagent> {
  return { rows: agent.subagents.map((subagent) => ({ key: subagent.id, item: subagent, source: 'guessed' })), hidden: [] };
}

/** A section heading's count: how many rows, and how many of them are guessed; `None` for none. */
export function sectionCount(all: readonly SidebarRow<unknown>[]): string {
  const rows = all.filter((row) => row.source === 'guessed' || row.gone !== true);
  if (rows.length === 0) return 'None';
  const guessed = rows.filter((row) => row.source === 'guessed').length;
  if (guessed === 0) return String(rows.length);
  return guessed === rows.length ? `${rows.length} · guessed` : `${rows.length} · ${guessed} guessed`;
}
