// What the ⌘K switcher lists: grouped before anything is typed, one ranked fuzzy list after. Pure, so the
// grouping and the ranking are unit-tested.
import { needsYouNow, permissionPrompt, planPending, questionPrompt, type Agent, type LibraryPrefab, type NeedsYouShows, type Shell, type Zone } from '@agent-board/daemon/protocol';
import type { Placement, SessionWindows } from '../windows/session-windows';
import { SETTINGS_GROUPS } from './settings-ia';
import { controlsIn, drawnSections, searchable } from './settings-search';

/** What a row of the switcher is about: a setting's row opens the Settings window at its section (`group.section`). */
export type SpotlightSubject =
  | { kind: 'agent'; agent: Agent }
  | { kind: 'shell'; shell: Shell }
  | { kind: 'zone'; zone: Zone }
  | { kind: 'setting'; pane: string }
  | { kind: 'action'; action: SpotlightAction }
  | { kind: 'crew'; prefab: string | null };

/** What an action row does: start an agent, or open the Settings window. */
export type SpotlightAction = 'newAgent' | 'openSettings';

/** A row's subject that the window ⌘K opened in shows: a session or a zone. */
export type BoardSubject = Exclude<SpotlightSubject, { kind: 'setting' | 'action' | 'crew' }>;

export interface SpotlightRow {
  key: string;
  subject: SpotlightSubject;
  name: string;
  /** Its zone and branch or folder; for an agent that needs you, what it asks instead of the branch. */
  sub: string;
  /** Which letters of the name the query matched, for the row to underline. */
  marks: readonly number[];
  /** Set on a row of the Windows group: where its session window is (its sub line says so too). */
  window?: Placement;
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

/** What ⌘K can do besides jump, under the Simplified design: the name it is found by, and the other words that find it. */
const ACTIONS: readonly { action: SpotlightAction; name: string; sub: string; also: string }[] = [
  { action: 'newAgent', name: 'New agent', sub: 'Start an agent in a zone', also: 'start create run' },
  { action: 'openSettings', name: 'Open Settings', sub: 'Settings window', also: 'preferences options' },
];

/**
 * The switcher's rows for `query`. Before anything is typed: the agents that need you, then the other sessions most
 * recently active, then the zones, leaving out an empty group. Once something is: the sessions and zones that match,
 * best first, ranked on the name, then the issue, the branch, the zone and what the agent asks, in that order; then,
 * under Settings, the few settings sections and controls that match best.
 *
 * Under the Simplified design (`simplified`) there is more: a Windows group leads, with the session windows that are
 * open, then minimised, then out in their own window (the view's own last), before typing and for those whose name
 * matches once something is typed, and a session with a window is listed there only; and once something is typed an
 * Actions group, with New agent (where one can start) and Open Settings, comes above Settings. Classic has neither.
 */
export function spotlightGroups(query: string, { agents, shells, zones, shows, windows = [], current, canStartAgent = false, prefabs = [], simplified = false, windowsListed = simplified }: SpotlightSources): SpotlightGroup[] {
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
      { label: 'Needs you', rows: needing.map((agent) => agentRow(agent, zoneName, [], shows)) },
      { label: 'Recent', rows: recent.map(({ row }) => row) },
      { label: 'Zones', rows: [...zones].sort((a, b) => a.name.localeCompare(b.name)).map((zone) => zoneRow(zone, agents, tiles, [])) },
    ];
    return groups.filter((group) => group.rows.length > 0);
  }

  // The windows that match lead, in their own group, whatever else matches better: they are what is on screen. A
  // session whose window matched is listed there only; one that matched by its branch or issue stays in the list.
  const matchedWindows = windowRows((name) => fuzzyMatch(wanted, name)?.positions);
  const inWindows = new Set(matchedWindows.map(({ id }) => id));
  const ranked: { score: number; row: SpotlightRow }[] = [];
  const consider = (fields: readonly Field[], row: (marks: readonly number[]) => SpotlightRow) => {
    let score = 0;
    for (const [text, weight, runOnly] of fields) score = Math.max(score, (text ? (fuzzyMatch(wanted, text, runOnly)?.score ?? 0) : 0) * weight);
    if (score === 0) return;
    const [name] = fields[0]!;
    ranked.push({ score, row: row(fuzzyMatch(wanted, name ?? '')?.positions ?? []) });
  };
  for (const agent of agents) {
    if (inWindows.has(agent.sessionId)) continue;
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
    if (inWindows.has(shell.id)) continue;
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
  const groups: SpotlightGroup[] = [{ label: matchedWindows.length > 0 ? WINDOWS_GROUP : undefined, rows: matchedWindows.map(({ row }) => row) }, { rows: ranked.map(({ row }) => row) }, { label: ACTIONS_GROUP, rows: simplified ? actionRows(wanted, canStartAgent) : [] }, { label: CREWS_GROUP, rows: canStartAgent ? crewRows(wanted, prefabs) : [] }, { label: SETTINGS_GROUP, rows: settingRows(wanted, simplified) }];
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
function actionRows(wanted: string, canStartAgent: boolean): SpotlightRow[] {
  const found: { score: number; row: SpotlightRow }[] = [];
  for (const { action, name, sub, also } of ACTIONS) {
    if (action === 'newAgent' && !canStartAgent) continue;
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
