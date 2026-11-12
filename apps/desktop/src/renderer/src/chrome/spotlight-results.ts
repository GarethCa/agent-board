// What the ⌘K switcher lists: grouped before anything is typed, one ranked fuzzy list after. Pure, so the
// grouping and the ranking are unit-tested.
import { needsYouNow, permissionPrompt, planPending, questionPrompt, type Agent, type LibraryPrefab, type NeedsYouShows, type Shell, type Zone } from '@agent-board/daemon/protocol';
import type { Placement, SessionWindows } from '../windows/session-windows';
import { extendedShortcuts } from '../keys/extended-shortcuts';
import { binding, isActive, keyText, type KeyId } from '../keys/registry';
import { SETTINGS_GROUPS } from './settings-ia';
import { controlsIn, drawnSections, searchable } from './settings-search';

/** What a row of the switcher is about: a setting's row opens the Settings window at its section (`group.section`). */
export type SpotlightSubject =
  | { kind: 'agent'; agent: Agent }
  | { kind: 'shell'; shell: Shell }
  | { kind: 'zone'; zone: Zone }
  | { kind: 'setting'; pane: string }
  | { kind: 'action'; action: SpotlightAction }
  | { kind: 'crew'; prefab: string | null }
  | { kind: 'filter'; prefix: FilterPrefix };

/** What an action row does: start an agent, open the Settings window, or park a thought. */
export type SpotlightAction = 'newAgent' | 'openSettings' | 'parkThought';

/** A row's subject that the window ⌘K opened in shows: a session or a zone. */
export type BoardSubject = Exclude<SpotlightSubject, { kind: 'setting' | 'action' | 'crew' | 'filter' }>;

/** What a colon prefix narrows the sessions to: those in a zone, with a pull request, or on an issue. */
export type FilterPrefix = 'zone:' | 'pr:' | 'issue:';

/** The field a row's snippet came from, as its label reads. */
export type SnippetLabel = 'issue' | 'PR' | 'desc' | 'branch' | 'zone' | 'status' | 'said';

/** The words of a field other than the name that a row matched by, labelled with the field. */
export interface SpotlightSnippet {
  label: SnippetLabel;
  text: string;
  /** Which letters of `text` the query matched. */
  marks: readonly number[];
}

export interface SpotlightRow {
  key: string;
  subject: SpotlightSubject;
  name: string;
  /** Its zone and branch or folder; for an agent that needs you, what it asks instead of the branch. */
  sub: string;
  /** Which letters of the name the query matched, for the row to underline. */
  marks: readonly number[];
  /** Whether `sub` is what the agent says it is for (`Agent.purpose`), drawn as prose rather than a path. */
  purpose?: boolean;
  /** Set when it matched best by another field than its name: shown in place of `sub`, labelled. */
  snippet?: SpotlightSnippet;
  /** Set on a row of the Windows group: where its session window is (its sub line says so too). */
  window?: Placement;
}

/** A run of rows, under a heading before anything is typed; one with no heading once something is. */
export interface SpotlightGroup {
  label?: string;
  rows: readonly SpotlightRow[];
}

/** The heading of the agents that need you, before anything is typed: the left column beside Recent. */
export const NEEDS_YOU_GROUP = 'Needs you';

/** The heading of the sessions most recently active, before anything is typed: the right column beside Needs you. */
export const RECENT_GROUP = 'Recent';

/** The heading of the filters offered once a colon is typed. */
export const FILTERS_GROUP = 'Filters';

/** A move through the rows by arrow key. */
export type SpotlightStep = 'up' | 'down' | 'left' | 'right';

/** Whether the groups lay Needs you and Recent side by side, as before anything is typed: both are there. */
export function sideBySide(groups: readonly SpotlightGroup[]): boolean {
  return groups.some((group) => group.label === NEEDS_YOU_GROUP) && groups.some((group) => group.label === RECENT_GROUP);
}

/**
 * The row an arrow key moves to from the row `key`. The groups are bands top to bottom, Needs you and Recent one band
 * of two columns: ↑ ↓ move within a column and on to the band above or below, round from the last to the first; ← →
 * cross to the same place in the other column, and stay put outside it. The first row if `key` is not listed. When the
 * columns are `stacked` (a narrow window puts Recent under Needs you), they are two bands, one after the other.
 */
export function spotlightStep(groups: readonly SpotlightGroup[], key: string | undefined, step: SpotlightStep, stacked = false): string | undefined {
  const bands: string[][][] = [];
  groups.forEach((group, index) => {
    const column = group.rows.map((row) => row.key);
    if (!stacked && group.label === RECENT_GROUP && groups[index - 1]?.label === NEEDS_YOU_GROUP) bands.at(-1)!.push(column);
    else bands.push([column]);
  });
  const filled = bands.filter((band) => band.some((column) => column.length > 0));
  let at: { band: number; column: number; row: number } | undefined;
  filled.forEach((band, b) =>
    band.forEach((column, c) => {
      const r = key === undefined ? -1 : column.indexOf(key);
      if (r !== -1) at = { band: b, column: c, row: r };
    }),
  );
  if (at === undefined) return filled[0]?.[0]?.[0];
  const band = filled[at.band]!;
  const here = band[at.column]!;
  if (step === 'left' || step === 'right') {
    const other = band[step === 'left' ? at.column - 1 : at.column + 1];
    return other === undefined || other.length === 0 ? key : other[Math.min(at.row, other.length - 1)];
  }
  const down = step === 'down';
  const next = at.row + (down ? 1 : -1);
  if (next >= 0 && next < here.length) return here[next];
  const into = filled[(at.band + (down ? 1 : -1) + filled.length) % filled.length]!;
  const column = into[Math.min(at.column, into.length - 1)]!.length > 0 ? into[Math.min(at.column, into.length - 1)]! : into.find((rows) => rows.length > 0)!;
  return down ? column[0] : column.at(-1);
}

/** The colon prefixes, in the order a lone colon lists them, with what each keeps. */
const FILTERS: readonly { prefix: FilterPrefix; sub: string }[] = [
  { prefix: 'zone:', sub: 'Only the sessions in one zone' },
  { prefix: 'pr:', sub: 'Only agents with a pull request, by its number or title' },
  { prefix: 'issue:', sub: 'Only agents on an issue, by its id or title' },
];

export interface SpotlightSources {
  agents: readonly Agent[];
  shells: readonly Shell[];
  zones: readonly Zone[];
  /** What the needs-you inbox lists: the agents in it lead, as there. */
  shows: NeedsYouShows;
  /** The board's session windows, listed first under the Simplified design (it has no dock); none if unset. */
  windows?: SessionWindows;
  /** The id of the session or shell the view in focus shows, if any: its window is listed last, as picking it only closes. */
  current?: string;
  /** Whether a new agent can start from here, so New agent is offered among the actions; not if unset. */
  canStartAgent?: boolean;
  /** The crew prefabs to find, yours first. */
  prefabs?: readonly Pick<LibraryPrefab, 'name' | 'purpose'>[];
  /** Whether the Simplified design is on, so the settings it alone draws are found; Classic's if unset. */
  simplified?: boolean;
  /** Whether the extended keyboard shortcuts work, so an action's key is shown only while it does; the setting's own by default. */
  extended?: boolean;
  /** Whether the Windows group is listed: always under the Simplified design (the default), and under Classic with the windows the dock leaves out. */
  windowsListed?: boolean;
}

/** How many sessions Recent lists before anything is typed: the rest are a few letters away. */
export const RECENT_LIMIT = 6;

/** How many settings a query lists, under the sessions and zones: the Settings window's own search lists them all. */
export const SETTINGS_LIMIT = 5;

/** The heading the settings found are listed under. */
export const SETTINGS_GROUP = 'Settings';

/** The heading the session windows that are open or minimised are listed under, above every other group. */
const WINDOWS_GROUP = 'Windows';

/** The heading the crew prefabs found are listed under, below the actions: picking one opens its prompt box. */
export const CREWS_GROUP = 'Crews';

/** The heading the actions found are listed under, above the settings. */
export const ACTIONS_GROUP = 'Actions';

/**
 * What ⌘K can do besides jump: the name it is found by, the other words that find it, and whether Classic offers it
 * too (the rest are the Simplified design's).
 */
const ACTIONS: readonly { action: SpotlightAction; name: string; sub: string; also: string; classic?: true; key?: KeyId }[] = [
  { action: 'newAgent', name: 'New agent', sub: 'Start an agent in a zone', also: 'start create run' },
  { action: 'openSettings', name: 'Open Settings', sub: 'Settings window', also: 'preferences options' },
  { action: 'parkThought', name: 'Park a thought', sub: 'A line at the back of your queue', also: 'note idea later remember jot', classic: true, key: 'move.parkThought' },
];

/**
 * The switcher's rows for `query`. Before anything is typed: the agents that need you, then the other sessions most
 * recently active, then the zones, leaving out an empty group. Once something is: the sessions and zones that match,
 * best first. Each field's score is weighted (`FIELD_WEIGHTS`): the name, then the issue or pull request number, what
 * the agent is for, the branch, the pull request's title, the zone, the status line and the last thing it said; a row
 * that matched outside its name carries a labelled snippet of the field. Then, under Settings, the few settings
 * sections and controls that match best. A `zone:`, `pr:` or `issue:` prefix gives one list, narrowed to it and
 * ranked on the rest of the query; a lone colon, or a colon and the start of a prefix, gives the Filters group.
 *
 * Under the Simplified design (`simplified`) there is more: a Windows group leads, with the session windows that are
 * open, then minimised, then out in their own window (the view's own last), before typing and for those whose name
 * matches once something is typed, and a session with a window is listed there only; and once something is typed an
 * Actions group, with New agent (where one can start) and Open Settings, comes above Settings. Classic has no Windows
 * group, and its Actions group holds Park a thought alone.
 */
export function spotlightGroups(query: string, { agents, shells, zones, shows, windows = [], current, canStartAgent = false, prefabs = [], simplified = false, windowsListed = simplified, extended = extendedShortcuts() }: SpotlightSources): SpotlightGroup[] {
  const zoneName = (zoneId: string | null) => (zoneId === null ? 'Loose' : (zones.find((zone) => zone.id === zoneId)?.name ?? 'Loose'));
  // A shell that is a tab is its owner's window's, not a tile of its own.
  const tiles = shells.filter((shell) => shell.owner === null);
  const wanted = query.trim();
  // Under the Simplified design a session with a window on the board is listed once, under Windows, whatever it asks.
  const listed = windowsListed ? windowSessions(windows) : new Set<string>();
  const windowRows = (match: (name: string) => readonly number[] | undefined): { id: string; row: SpotlightRow }[] => {
    if (!windowsListed) return [];
    const found: { score: number; id: string; row: SpotlightRow }[] = [];
    for (const entry of windows) {
      const agent = entry.kind === 'session' ? agents.find((each) => each.sessionId === entry.id) : undefined;
      const shell = entry.kind === 'shell' ? tiles.find((each) => each.id === entry.id) : undefined;
      const base = agent !== undefined ? agentRow(agent, zoneName, [], shows) : shell !== undefined ? shellRow(shell, zoneName, []) : undefined;
      if (base === undefined) continue;
      const marks = match(base.name);
      if (marks === undefined) continue;
      // The session the view shows already goes last: ↵ on it only closes, so the others are the ones to reach.
      const score = PLACEMENT_ORDER.indexOf(entry.placement) + (entry.id === current ? PLACEMENT_ORDER.length : 0);
      found.push({ score, id: entry.id, row: { ...base, key: `window:${entry.id}`, sub: joined(PLACEMENT_LABELS[entry.placement], base.sub), marks, window: entry.placement } });
    }
    // Open before minimised before out in an OS window; the order they were opened within each.
    return found.sort((a, b) => a.score - b.score);
  };
  if (wanted === '') {
    const needing = agents.filter((agent) => needsYouNow(agent, shows) && !listed.has(agent.sessionId));
    const rest = [
      ...agents.filter((agent) => !needsYouNow(agent, shows) && !listed.has(agent.sessionId)).map((agent) => ({ at: agent.finishedAt ?? agent.createdAt, row: agentRow(agent, zoneName, [], shows) })),
      ...tiles.filter((shell) => !listed.has(shell.id)).map((shell) => ({ at: shell.createdAt, row: shellRow(shell, zoneName, []) })),
    ];
    const recent = rest.sort((a, b) => b.at.localeCompare(a.at)).slice(0, RECENT_LIMIT);
    const groups: SpotlightGroup[] = [
      { label: WINDOWS_GROUP, rows: windowRows(() => []).map(({ row }) => row) },
      // A narrow column beside Recent: what it asks, without its zone.
      { label: NEEDS_YOU_GROUP, rows: needing.map((agent) => ({ ...agentRow(agent, zoneName, [], shows), sub: askOf(agent) })) },
      { label: RECENT_GROUP, rows: recent.map(({ row }) => row) },
      { label: 'Zones', rows: [...zones].sort((a, b) => a.name.localeCompare(b.name)).map((zone) => zoneRow(zone, agents, tiles, [])) },
    ];
    return groups.filter((group) => group.rows.length > 0);
  }

  // A colon alone, or a colon and the start of a filter's name, offers the filters.
  if (wanted.startsWith(':')) {
    const typed = wanted.slice(1).toLowerCase();
    const offered = FILTERS.filter(({ prefix }) => prefix.startsWith(typed));
    if (offered.length > 0) return [{ label: FILTERS_GROUP, rows: offered.map(({ prefix, sub }) => ({ key: `filter:${prefix}`, subject: { kind: 'filter', prefix }, name: prefix, sub, marks: [] })) }];
  }
  const { filters, rest } = parseFilters(wanted);
  if (filters.length > 0) return [{ rows: filteredRows(filters, rest, { agents, tiles, zoneName, shows }) }];

  // The windows that match lead, in their own group, whatever else matches better: they are what is on screen. A
  // session whose window matched is listed there only; one that matched by its branch or issue stays in the list.
  const matchedWindows = windowRows((name) => fuzzyMatch(wanted, name)?.positions);
  const inWindows = new Set(matchedWindows.map(({ id }) => id));
  const ranked: { score: number; row: SpotlightRow }[] = [];
  const consider = (name: string, fields: readonly Field[], row: (marks: readonly number[]) => SpotlightRow) => {
    const best = bestMatch(wanted, name, fields);
    if (best === undefined) return;
    const base = row(fuzzyMatch(wanted, name)?.positions ?? []);
    ranked.push({ score: best.score, row: best.snippet === undefined ? base : { ...base, snippet: best.snippet } });
  };
  for (const agent of agents) {
    if (inWindows.has(agent.sessionId)) continue;
    consider(agent.name, agentFields(agent, zoneName), (marks) => agentRow(agent, zoneName, marks, shows));
  }
  for (const shell of tiles) {
    if (inWindows.has(shell.id)) continue;
    consider(shell.name, [{ text: zoneName(shell.zoneId), weight: FIELD_WEIGHTS.zone, label: 'zone' }], (marks) => shellRow(shell, zoneName, marks));
  }
  for (const zone of zones) consider(zone.name, [], (marks) => zoneRow(zone, agents, tiles, marks));
  ranked.sort((a, b) => b.score - a.score || a.row.name.localeCompare(b.row.name));
  const groups: SpotlightGroup[] = [{ label: matchedWindows.length > 0 ? WINDOWS_GROUP : undefined, rows: matchedWindows.map(({ row }) => row) }, { rows: ranked.map(({ row }) => row) }, { label: ACTIONS_GROUP, rows: actionRows(wanted, canStartAgent, simplified, extended) }, { label: CREWS_GROUP, rows: canStartAgent ? crewRows(wanted, prefabs) : [] }, { label: SETTINGS_GROUP, rows: settingRows(wanted, simplified) }];
  return groups.filter((group) => group.rows.length > 0);
}

/**
 * Whether "New agent named …" leads the list, so ↵ starts it: unless what was typed is in a crew's name, when ↵ opens
 * that crew and it is offered last. A match only on what a crew is for doesn't count: `build` may well name an agent.
 */
export const newAgentLeads = (groups: readonly SpotlightGroup[]): boolean => !groups.some((group) => group.label === CREWS_GROUP && group.rows.some((row) => row.marks.length > 0));

/** The prefabs whose name, or what it is for, holds `wanted`, and the library: `crew` alone finds them all. */
function crewRows(wanted: string, prefabs: NonNullable<SpotlightSources['prefabs']>): SpotlightRow[] {
  const found: { score: number; row: SpotlightRow }[] = [];
  const consider = (key: string, prefab: string | null, name: string, sub: string, also: string) => {
    const named = fuzzyMatch(wanted, name, true);
    const other = fuzzyMatch(wanted, also, true);
    const score = Math.max(named?.score ?? 0, (other?.score ?? 0) * FIELD_WEIGHTS.also);
    if (score > 0) found.push({ score, row: { key, subject: { kind: 'crew', prefab }, name, sub, marks: named?.positions ?? [] } });
  };
  for (const { name, purpose } of prefabs) consider(`crew:${name}`, name, name, purpose, `crew prefab ${purpose}`);
  consider('crew-library', null, 'Crew library', 'Every crew prefab, to start, edit or make one', 'prefab team');
  return found.sort((a, b) => b.score - a.score).map(({ row }) => row);
}

/** The actions whose name or other words hold `wanted`, a match in the name first. */
function actionRows(wanted: string, canStartAgent: boolean, simplified: boolean, extended: boolean): SpotlightRow[] {
  const found: { score: number; row: SpotlightRow }[] = [];
  for (const { action, name, sub: what, also, classic, key: id } of ACTIONS) {
    // Its key, while it works: with the extended keys off it is only here.
    const sub = id !== undefined && isActive(binding(id), extended, simplified) ? `${what} · ${keyText(id)}` : what;
    if ((action === 'newAgent' && !canStartAgent) || (!simplified && classic !== true)) continue;
    const named = fuzzyMatch(wanted, name, true);
    const other = fuzzyMatch(wanted, also, true);
    const score = Math.max(named?.score ?? 0, (other?.score ?? 0) * FIELD_WEIGHTS.also);
    if (score > 0) found.push({ score, row: { key: `action:${action}`, subject: { kind: 'action', action }, name, sub, marks: named?.positions ?? [] } });
  }
  return found.sort((a, b) => b.score - a.score).map(({ row }) => row);
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
    for (const section of drawnSections(group, simplified)) {
      const pane = `${group.id}.${section.id}`;
      consider(pane, pane, section.name, `Settings · ${group.name}`, group.name);
      for (const control of controlsIn(pane, simplified)) consider(control.id, pane, control.label, `Settings · ${group.name} › ${section.name}`, control.also);
    }
  }
  found.sort((a, b) => b.score - a.score || a.row.name.localeCompare(b.row.name));
  return found.slice(0, SETTINGS_LIMIT).map(({ row }) => row);
}

/** Where a window is, in the order the Windows group lists them: on the board, minimised, then out in its own window. */
const PLACEMENT_ORDER: readonly Placement[] = ['shown', 'docked', 'popped'];

/** What a window row's sub line starts with: where its window is. */
const PLACEMENT_LABELS: Record<Placement, string> = { shown: 'Open', docked: 'Minimised', popped: 'In its own window' };

/** The ids of the sessions and shells that have a window on the board or out. */
const windowSessions = (windows: SessionWindows): ReadonlySet<string> => new Set(windows.filter((entry) => entry.kind !== 'tabs').map((entry) => entry.id));

/**
 * A field other than the name to match: its text, how much a match in it counts, whether only a whole run of letters
 * does, and its label on the row's snippet. `match`, if given, is the part of `text` matched (a PR's number in
 * `#571 Its title`), from `offset` on.
 */
interface Field {
  text: string | null | undefined;
  weight: number;
  label: SnippetLabel;
  runOnly?: boolean;
  match?: { text: string; offset: number };
}

/** How much a match in each field counts against one in the name. */
const FIELD_WEIGHTS = { issue: 0.9, pr: 0.9, purpose: 0.85, branch: 0.8, prTitle: 0.75, zone: 0.7, status: 0.6, said: 0.5, also: 0.7 } as const;

/** How far into a snippet its first matched letter may sit before the start is cut to an ellipsis. */
const SNIPPET_LEAD = 24;

/** The pull request a row and a `pr:` filter go by: the newest from its branch, else one its work went into. */
const pullRequestOf = (agent: Agent) => agent.pullRequests?.[0] ?? agent.pushedPullRequests?.[0];

/** Prose on one line, as a snippet shows it and its marks count. */
const flat = (text: string | null | undefined) => text?.replace(/\s+/g, ' ').trim();

/** The fields an agent is found by besides its name, in the order they rank (`FIELD_WEIGHTS`). */
function agentFields(agent: Agent, zoneName: (zoneId: string | null) => string): Field[] {
  const pr = pullRequestOf(agent);
  const prText = pr === undefined ? undefined : `#${pr.number} ${flat(pr.title)}`;
  const issueText = agent.issue === null ? undefined : `${agent.issue.id} ${flat(agent.issue.title)}`;
  return [
    { text: issueText, weight: FIELD_WEIGHTS.issue, label: 'issue', match: agent.issue === null ? undefined : { text: agent.issue.id, offset: 0 } },
    // A number matches only as a run: 51 is not in #571.
    { text: prText, weight: FIELD_WEIGHTS.pr, label: 'PR', runOnly: true, match: pr === undefined ? undefined : { text: `#${pr.number}`, offset: 0 } },
    { text: flat(agent.purpose), weight: FIELD_WEIGHTS.purpose, label: 'desc', runOnly: true },
    { text: agent.branch, weight: FIELD_WEIGHTS.branch, label: 'branch' },
    { text: prText, weight: FIELD_WEIGHTS.prTitle, label: 'PR', runOnly: true, match: pr === undefined ? undefined : { text: flat(pr.title)!, offset: `#${pr.number} `.length } },
    { text: zoneName(agent.zoneId), weight: FIELD_WEIGHTS.zone, label: 'zone' },
    // Prose holds most letters somewhere: only a whole run of them counts.
    { text: flat(agent.status?.summary), weight: FIELD_WEIGHTS.status, label: 'status', runOnly: true },
    { text: flat(agent.ask?.question ?? agent.lastMessage), weight: FIELD_WEIGHTS.said, label: 'said', runOnly: true },
  ];
}

/**
 * How well `wanted` matches a row: its best score over the name (weight 1) and `fields`, and, when a field other than
 * the name scored best, the labelled snippet of it. Undefined if nothing matches.
 */
function bestMatch(wanted: string, name: string, fields: readonly Field[]): { score: number; snippet?: SpotlightSnippet } | undefined {
  let best: { score: number; snippet?: SpotlightSnippet } = { score: fuzzyMatch(wanted, name)?.score ?? 0 };
  for (const field of fields) {
    if (!field.text) continue;
    const part = field.match ?? { text: field.text, offset: 0 };
    const found = fuzzyMatch(wanted, part.text, field.runOnly);
    const score = (found?.score ?? 0) * field.weight;
    if (found === undefined || score <= best.score) continue;
    best = { score, snippet: snippetOf(field.label, field.text, found.positions.map((at) => at + part.offset)) };
  }
  return best.score === 0 ? undefined : best;
}

/** A snippet of `text` with `marks`: cut at a word before the first mark to an ellipsis, should it sit far in. */
function snippetOf(label: SnippetLabel, text: string, marks: readonly number[]): SpotlightSnippet {
  const first = marks[0] ?? 0;
  if (first <= SNIPPET_LEAD) return { label, text, marks };
  const space = text.lastIndexOf(' ', first - SNIPPET_LEAD / 2);
  const from = space === -1 ? first - SNIPPET_LEAD / 2 : space + 1;
  return { label, text: `…${text.slice(from)}`, marks: marks.map((at) => at - from + 1) };
}

/** A colon prefix and what was typed after it, as `parseFilters` reads them. */
export interface SpotlightFilter {
  prefix: FilterPrefix;
  value: string;
}

/**
 * The filters in what was typed, and the words left to rank by: `zone:hiit review` is the zone filter `hiit` and
 * `review`. A filter's value runs to the next space; it may be empty (`pr:` alone keeps any agent with a pull request).
 */
export function parseFilters(query: string): { filters: SpotlightFilter[]; rest: string } {
  const filters: SpotlightFilter[] = [];
  const words: string[] = [];
  for (const word of query.trim().split(/\s+/)) {
    const prefix = FILTERS.find((filter) => word.toLowerCase().startsWith(filter.prefix))?.prefix;
    if (prefix === undefined) words.push(word);
    else filters.push({ prefix, value: word.slice(prefix.length) });
  }
  return { filters, rest: words.join(' ') };
}

/**
 * The sessions every filter keeps, ranked by `rest` as the list is (most recently active first with nothing left), each
 * with the field a `pr:` or `issue:` filter kept it by as its snippet. Only `zone:` keeps a shell.
 */
function filteredRows(
  filters: readonly SpotlightFilter[],
  rest: string,
  { agents, tiles, zoneName, shows }: { agents: readonly Agent[]; tiles: readonly Shell[]; zoneName: (zoneId: string | null) => string; shows: NeedsYouShows },
): SpotlightRow[] {
  const inZone = (zoneId: string | null, value: string) => value === '' || zoneName(zoneId).toLowerCase().includes(value.toLowerCase());
  const holds = (value: string, ...texts: (string | undefined)[]) => value === '' || texts.some((text) => text !== undefined && fuzzyMatch(value, text, true) !== undefined);
  const found: { score: number; at: string; row: SpotlightRow }[] = [];
  for (const agent of agents) {
    let kept: SpotlightSnippet | undefined;
    const keeps = filters.every(({ prefix, value }) => {
      if (prefix === 'zone:') return inZone(agent.zoneId, value);
      if (prefix === 'pr:') {
        const pr = pullRequestOf(agent);
        if (pr === undefined || !holds(value.replace(/^#/, ''), String(pr.number), pr.title)) return false;
        kept ??= { label: 'PR', text: `#${pr.number} ${flat(pr.title)}`, marks: [] };
        return true;
      }
      if (agent.issue === null || !holds(value, agent.issue.id, agent.issue.title)) return false;
      kept ??= { label: 'issue', text: `${agent.issue.id} ${flat(agent.issue.title)}`, marks: [] };
      return true;
    });
    if (!keeps) continue;
    const best = rest === '' ? { score: 1 } : bestMatch(rest, agent.name, agentFields(agent, zoneName));
    if (best === undefined) continue;
    const snippet = best.snippet ?? kept;
    const row = agentRow(agent, zoneName, rest === '' ? [] : (fuzzyMatch(rest, agent.name)?.positions ?? []), shows);
    found.push({ score: best.score, at: agent.finishedAt ?? agent.createdAt, row: snippet === undefined ? row : { ...row, snippet } });
  }
  if (filters.every(({ prefix }) => prefix === 'zone:')) {
    for (const shell of tiles) {
      if (!filters.every(({ value }) => inZone(shell.zoneId, value))) continue;
      const score = rest === '' ? 1 : (fuzzyMatch(rest, shell.name)?.score ?? 0);
      if (score > 0) found.push({ score, at: shell.createdAt, row: shellRow(shell, zoneName, rest === '' ? [] : (fuzzyMatch(rest, shell.name)?.positions ?? [])) });
    }
  }
  return found.sort((a, b) => b.score - a.score || b.at.localeCompare(a.at)).map(({ row }) => row);
}

/**
 * An agent's row: its sub line is what it asks while it needs you, else what it says it is for, else its zone and
 * branch.
 */
function agentRow(agent: Agent, zoneName: (zoneId: string | null) => string, marks: readonly number[], shows: NeedsYouShows): SpotlightRow {
  const row = { key: `agent:${agent.sessionId}`, subject: { kind: 'agent', agent }, name: agent.name, marks } as const;
  if (needsYouNow(agent, shows)) return { ...row, sub: joined(zoneName(agent.zoneId), askOf(agent)) };
  if (agent.purpose) return { ...row, sub: agent.purpose, purpose: true };
  return { ...row, sub: joined(zoneName(agent.zoneId), agent.branch) };
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
  // A permission comes before questions: it is what Needs you lists the agent for.
  const prompt = permissionPrompt(agent) ?? questionPrompt(agent);
  if (prompt?.questions != null) return `asks: ${prompt.questions[0]?.question ?? 'questions'}`;
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
