// What the ⌘K switcher lists: grouped before anything is typed, one ranked fuzzy list after. Pure, so the
// grouping and the ranking are unit-tested.
import { needsYouNow, planPending, type Agent, type NeedsYouShows, type Shell, type Zone } from '@agent-board/daemon/protocol';
import { SETTINGS_GROUPS } from './settings-ia';
import { controlsIn, searchable } from './settings-search';

/** What a row of the switcher is about: a setting's row opens the Settings window at its section (`group.section`). */
export type SpotlightSubject =
  | { kind: 'agent'; agent: Agent }
  | { kind: 'shell'; shell: Shell }
  | { kind: 'zone'; zone: Zone }
  | { kind: 'setting'; pane: string };

/** A row's subject that the window ⌘K opened in shows: a session or a zone. */
export type BoardSubject = Exclude<SpotlightSubject, { kind: 'setting' }>;

export interface SpotlightRow {
  key: string;
  subject: SpotlightSubject;
  name: string;
  /** Its zone and branch or folder; for an agent that needs you, what it asks instead of the branch. */
  sub: string;
  /** Which letters of the name the query matched, for the row to underline. */
  marks: readonly number[];
}

/** A run of rows, under a heading before anything is typed; one with no heading once something is. */
export interface SpotlightGroup {
  label?: string;
  rows: readonly SpotlightRow[];
}

export interface SpotlightSources {
  agents: readonly Agent[];
  shells: readonly Shell[];
  zones: readonly Zone[];
  /** What the needs-you inbox lists: the agents in it lead, as there. */
  shows: NeedsYouShows;
  /** Whether the Simplified design is on, so the settings it alone draws are found; Classic's if unset. */
  simplified?: boolean;
}

/** How many sessions Recent lists before anything is typed: the rest are a few letters away. */
export const RECENT_LIMIT = 6;

/** How many settings a query lists, under the sessions and zones: the Settings window's own search lists them all. */
export const SETTINGS_LIMIT = 5;

/** The heading the settings found are listed under. */
export const SETTINGS_GROUP = 'Settings';

/**
 * The switcher's rows for `query`. Before anything is typed: the agents that need you, then the other sessions most
 * recently active, then the zones, leaving out an empty group. Once something is: the sessions and zones that match,
 * best first, ranked on the name, then the issue, the branch, the zone and what the agent asks, in that order; then,
 * under Settings, the few settings sections and controls that match best.
 */
export function spotlightGroups(query: string, { agents, shells, zones, shows, simplified = false }: SpotlightSources): SpotlightGroup[] {
  const zoneName = (zoneId: string | null) => (zoneId === null ? 'Loose' : (zones.find((zone) => zone.id === zoneId)?.name ?? 'Loose'));
  // A shell that is a tab is its owner's window's, not a tile of its own.
  const tiles = shells.filter((shell) => shell.owner === null);
  const wanted = query.trim();
  if (wanted === '') {
    const needing = agents.filter((agent) => needsYouNow(agent, shows));
    const rest = [
      ...agents.filter((agent) => !needsYouNow(agent, shows)).map((agent) => ({ at: agent.finishedAt ?? agent.createdAt, row: agentRow(agent, zoneName, [], shows) })),
      ...tiles.map((shell) => ({ at: shell.createdAt, row: shellRow(shell, zoneName, []) })),
    ];
    const recent = rest.sort((a, b) => b.at.localeCompare(a.at)).slice(0, RECENT_LIMIT);
    const groups: SpotlightGroup[] = [
      { label: 'Needs you', rows: needing.map((agent) => agentRow(agent, zoneName, [], shows)) },
      { label: 'Recent', rows: recent.map(({ row }) => row) },
      { label: 'Zones', rows: [...zones].sort((a, b) => a.name.localeCompare(b.name)).map((zone) => zoneRow(zone, agents, tiles, [])) },
    ];
    return groups.filter((group) => group.rows.length > 0);
  }

  const ranked: { score: number; row: SpotlightRow }[] = [];
  const consider = (fields: readonly Field[], row: (marks: readonly number[]) => SpotlightRow) => {
    let score = 0;
    for (const [text, weight, runOnly] of fields) score = Math.max(score, (text ? (fuzzyMatch(wanted, text, runOnly)?.score ?? 0) : 0) * weight);
    if (score === 0) return;
    const [name] = fields[0]!;
    ranked.push({ score, row: row(fuzzyMatch(wanted, name ?? '')?.positions ?? []) });
  };
  for (const agent of agents) {
    consider(
      [
        [agent.name, 1],
        [agent.issue?.id, FIELD_WEIGHTS.issue],
        [agent.branch, FIELD_WEIGHTS.branch],
        [zoneName(agent.zoneId), FIELD_WEIGHTS.zone],
        // Prose holds most letters somewhere: only a whole run of them counts.
        [agent.ask?.question ?? agent.lastMessage, FIELD_WEIGHTS.asks, true],
      ],
      (marks) => agentRow(agent, zoneName, marks, shows),
    );
  }
  for (const shell of tiles) {
    consider(
      [
        [shell.name, 1],
        [zoneName(shell.zoneId), FIELD_WEIGHTS.zone],
      ],
      (marks) => shellRow(shell, zoneName, marks),
    );
  }
  for (const zone of zones) consider([[zone.name, 1]], (marks) => zoneRow(zone, agents, tiles, marks));
  ranked.sort((a, b) => b.score - a.score || a.row.name.localeCompare(b.row.name));
  const groups: SpotlightGroup[] = [{ rows: ranked.map(({ row }) => row) }, { label: SETTINGS_GROUP, rows: settingRows(wanted, simplified) }];
  return groups.filter((group) => group.rows.length > 0);
}

/**
 * The settings sections and controls that hold `wanted` where the Settings window's search looks (`searchSettings`): a
 * section's name or its group's, a control's label or its other words, as a whole run of letters, case and accents
 * aside. Unlike the window, which lists every section found, these are ranked, a match in the name first, and cut to
 * `SETTINGS_LIMIT`. Each opens its section.
 */
function settingRows(wanted: string, simplified: boolean): SpotlightRow[] {
  const needle = searchable(wanted);
  const found: { score: number; row: SpotlightRow }[] = [];
  const consider = (key: string, pane: string, name: string, sub: string, also?: string) => {
    const named = fuzzyMatch(needle, searchable(name), true);
    const other = also === undefined ? undefined : fuzzyMatch(needle, searchable(also), true);
    const score = Math.max(named?.score ?? 0, (other?.score ?? 0) * FIELD_WEIGHTS.also);
    if (score > 0) found.push({ score, row: { key: `setting:${key}`, subject: { kind: 'setting', pane }, name, sub, marks: named?.positions ?? [] } });
  };
  for (const group of SETTINGS_GROUPS) {
    for (const section of group.sections) {
      const pane = `${group.id}.${section.id}`;
      consider(pane, pane, section.name, `Settings · ${group.name}`, group.name);
      for (const control of controlsIn(pane, simplified)) consider(control.id, pane, control.label, `Settings · ${group.name} › ${section.name}`, control.also);
    }
  }
  found.sort((a, b) => b.score - a.score || a.row.name.localeCompare(b.row.name));
  return found.slice(0, SETTINGS_LIMIT).map(({ row }) => row);
}

/** A field to match: its text, how much a match in it counts, and whether only a whole run of letters does. */
type Field = readonly [text: string | null | undefined, weight: number, runOnly?: boolean];

/** How much a match in each field counts against one in the name. */
const FIELD_WEIGHTS = { issue: 0.9, branch: 0.8, zone: 0.7, asks: 0.5, also: 0.7 };

function agentRow(agent: Agent, zoneName: (zoneId: string | null) => string, marks: readonly number[], shows: NeedsYouShows): SpotlightRow {
  const detail = needsYouNow(agent, shows) ? askOf(agent) : agent.branch;
  return { key: `agent:${agent.sessionId}`, subject: { kind: 'agent', agent }, name: agent.name, sub: joined(zoneName(agent.zoneId), detail), marks };
}

function shellRow(shell: Shell, zoneName: (zoneId: string | null) => string, marks: readonly number[]): SpotlightRow {
  return { key: `shell:${shell.id}`, subject: { kind: 'shell', shell }, name: shell.name, sub: joined(zoneName(shell.zoneId), shell.cwd), marks };
}

function zoneRow(zone: Zone, agents: readonly Agent[], shells: readonly Shell[], marks: readonly number[]): SpotlightRow {
  const count = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
  const agentCount = agents.filter((agent) => agent.zoneId === zone.id).length;
  const shellCount = shells.filter((shell) => shell.zoneId === zone.id).length;
  return { key: `zone:${zone.id}`, subject: { kind: 'zone', zone }, name: zone.name, sub: `${count(agentCount, 'agent')} · ${count(shellCount, 'shell')}`, marks };
}

/** What an agent that needs you asks: a permission, its question, a plan to review, or what it last said, on one line. */
function askOf(agent: Agent): string {
  const [prompt] = agent.permissions;
  if (prompt !== undefined) return `permission: ${prompt.toolName}`;
  if (agent.ask !== null) return `asks: ${agent.ask.question}`;
  if (planPending(agent)) return 'plan to review';
  if (agent.flag !== null) return `flagged: ${agent.flag.reason}`;
  return agent.lastMessage?.replace(/\s+/g, ' ').trim() || 'waiting for you';
}

const joined = (...parts: string[]) => parts.filter((part) => part !== '').join(' · ');

/** Whether the letter at `index` starts a word: the first, or one after a space, dash, slash or other non-letter. */
const startsWord = (text: string, index: number) => index === 0 || !/[\p{L}\p{N}]/u.test(text[index - 1]!);

/**
 * Whether `query`'s letters appear in `text` in order, ignoring case, and how well: a whole run of them scores above
 * scattered letters, and a run starting a word above one inside a word. Undefined if they don't, or with `runOnly`, if
 * they are not one run.
 */
export function fuzzyMatch(query: string, text: string, runOnly = false): { score: number; positions: number[] } | undefined {
  const needle = query.toLowerCase();
  const hay = text.toLowerCase();
  if (needle === '') return undefined;
  // A run: the first that starts a word, else the first.
  let best = -1;
  for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, at + 1)) {
    if (best === -1) best = at;
    if (startsWord(hay, at)) {
      best = at;
      break;
    }
  }
  if (best !== -1) {
    const score = 100 + (startsWord(hay, best) ? 30 : 0) + (hay === needle ? 20 : 0) - Math.min(best, 50) * 0.1;
    return { score, positions: Array.from({ length: needle.length }, (_, offset) => best + offset) };
  }
  if (runOnly) return undefined;
  // Scattered: the earliest place for each letter, after the last.
  const positions: number[] = [];
  let from = 0;
  for (const letter of needle) {
    const at = hay.indexOf(letter, from);
    if (at === -1) return undefined;
    positions.push(at);
    from = at + 1;
  }
  const gaps = positions.at(-1)! - positions[0]! - (positions.length - 1);
  const starts = positions.filter((at) => startsWord(hay, at)).length;
  return { score: Math.min(99, Math.max(1, 60 - gaps * 2 + starts * 3 - positions[0]! * 0.1)), positions };
}
