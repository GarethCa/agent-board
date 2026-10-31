// Where every setting lives in the Settings window: seven groups in its sidebar, each a page of sections, and every
// control in exactly one section. The window draws its sidebar and headings from here; searching settings reads the
// same table, so a control that moves is still found by its label.

export type SettingsGroupId = 'general' | 'board' | 'agents' | 'alerts' | 'usage' | 'accounts' | 'advanced';

export interface SettingsSection {
  id: string;
  name: string;
}

export interface SettingsGroup {
  id: SettingsGroupId;
  name: string;
  sections: readonly SettingsSection[];
}

/** The sidebar, in order: how the app looks and talks to you, the board, agents, alerts, usage, other programs, and plumbing. */
export const SETTINGS_GROUPS: readonly SettingsGroup[] = [
  {
    id: 'general',
    name: 'General',
    sections: [
      { id: 'design', name: 'Design' },
      { id: 'appearance', name: 'Appearance' },
      { id: 'keyboard', name: 'Keyboard' },
    ],
  },
  {
    id: 'board',
    name: 'Board',
    sections: [
      { id: 'opening', name: 'Opening tiles' },
      { id: 'connections', name: 'Connections' },
      { id: 'crews', name: 'Crews' },
      { id: 'notes', name: 'Agent notes' },
      { id: 'tidying', name: 'Tidying' },
    ],
  },
  {
    id: 'agents',
    name: 'Agents',
    sections: [
      { id: 'chat', name: 'Chat' },
      { id: 'context', name: 'Context' },
      { id: 'links', name: 'Links' },
    ],
  },
  { id: 'alerts', name: 'Alerts', sections: [{ id: 'notifications', name: 'Notifications' }] },
  {
    id: 'usage',
    name: 'Usage',
    sections: [
      { id: 'plan', name: 'Plan usage' },
      { id: 'thresholds', name: 'Thresholds' },
      { id: 'pacing', name: 'Pacing' },
    ],
  },
  { id: 'accounts', name: 'Accounts', sections: [{ id: 'terminals', name: 'Other terminals' }] },
  {
    id: 'advanced',
    name: 'Advanced',
    sections: [
      { id: 'programs', name: 'Programs' },
      { id: 'handoffs', name: 'Held hand-offs' },
      { id: 'cli', name: 'Command line' },
      { id: 'webTabs', name: 'Web tabs' },
      { id: 'service', name: 'Background service' },
    ],
  },
];

/** A section's place: `group.section`. */
export type SettingsHome = `${SettingsGroupId}.${string}`;

export interface SettingsControl {
  id: string;
  /** What the control is called where it is drawn. */
  label: string;
  home: SettingsHome;
  /** Drawn only under the Simplified design: anything that lists controls leaves it out under Classic. */
  simplifiedOnly?: true;
  /** Other words searching finds it by: what it sets, what it was called, where it used to be. */
  also?: string;
}

/** Every control, in the order its section draws them. */
export const SETTINGS_CONTROLS: readonly SettingsControl[] = [
  { id: 'simplifiedDesign', label: 'Use the Simplified design', home: 'general.design', also: 'look classic new' },
  { id: 'technicalDetails', label: 'Show technical details', home: 'general.design', simplifiedOnly: true, also: 'branches models pull requests terminals' },
  { id: 'statusLook', label: "Show each agent's status as", home: 'general.design', simplifiedOnly: true, also: 'characters icons glyph' },
  { id: 'mode', label: 'Mode', home: 'general.appearance', also: 'light dark system' },
  { id: 'theme', label: 'Theme', home: 'general.appearance', also: 'colour color palette pack' },
  { id: 'extendedShortcuts', label: 'Extended keyboard shortcuts', home: 'general.keyboard', also: 'keys hotkeys' },
  { id: 'clickOpens', label: 'Double-clicking a tile opens', home: 'board.opening', also: 'double-click expand session window' },
  { id: 'connections', label: 'Show connections', home: 'board.connections', also: 'edges rails lines' },
  { id: 'crewLook', label: 'Agents an orchestrator starts', home: 'board.crews', also: 'orchestrator crew layout' },
  { id: 'agentNoteLook', label: 'How a note an agent writes looks', home: 'board.notes', also: 'document terminal card' },
  { id: 'arrangeSpacing', label: 'Arrange spacing', home: 'board.tidying', also: 'tidy gap layout' },
  { id: 'opensOn', label: 'Agent windows open on', home: 'agents.chat', simplifiedOnly: true, also: 'chat terminal timeline view default open' },
  { id: 'chatStyle', label: 'Style', home: 'agents.chat', also: 'cards timeline rail status line conversation' },
  { id: 'compactWindow', label: "Compact agents' context at", home: 'agents.context', also: 'context window tokens' },
  { id: 'clickableLinks', label: 'Clickable links from Claude', home: 'agents.links', also: 'urls open browser' },
  { id: 'needsYouShows', label: 'Needs you shows', home: 'alerts.notifications', also: 'inbox turns' },
  { id: 'osNotifications', label: 'OS notifications', home: 'alerts.notifications', also: 'alerts banners' },
  { id: 'notifyInFront', label: 'Also while agent-board is in front', home: 'alerts.notifications', also: 'focused foreground' },
  { id: 'mutedAgents', label: 'A tile muted from its ⋯ menu never notifies', home: 'alerts.notifications', also: 'mute silence' },
  { id: 'usageReading', label: 'Used so far', home: 'usage.plan', also: 'limits plan' },
  { id: 'usageOnBoard', label: 'Show usage on the board', home: 'usage.plan' },
  { id: 'usageThresholds', label: 'Only High zones start new agents at', home: 'usage.thresholds', also: 'limit high zones' },
  { id: 'usagePacing', label: 'Let the Captain pace work by usage', home: 'usage.pacing', also: 'captain pace' },
  { id: 'otherTerminals', label: 'Other terminals', home: 'accounts.terminals', also: 'hooks external sessions' },
  { id: 'claudePath', label: 'Claude path', home: 'advanced.programs', also: 'binary executable' },
  { id: 'codexPath', label: 'Codex path', home: 'advanced.programs', also: 'binary executable' },
  { id: 'heldHandOffs', label: 'Held hand-offs', home: 'advanced.handoffs', also: 'payloads approvals' },
  { id: 'cliInstall', label: 'Install command-line tool', home: 'advanced.cli', also: 'terminal shell link' },
  { id: 'keepWebLogins', label: 'Keep logins between sessions', home: 'advanced.webTabs', also: 'cookies browser' },
  { id: 'clearBrowsingData', label: 'Clear browsing data', home: 'advanced.webTabs', also: 'cookies cache browser' },
  { id: 'daemonStatus', label: 'Build', home: 'advanced.service', also: 'version daemon background service' },
];

/** The section at `home`, if there is one. */
export function sectionOf(home: string): SettingsSection | undefined {
  const [group, section] = home.split('.');
  return SETTINGS_GROUPS.find((each) => each.id === group)?.sections.find((each) => each.id === section);
}

/** Which page the window shows: a group, and the section it was opened at, if any. */
export interface SettingsPane {
  group: SettingsGroupId;
  section?: string;
}

/** A pane as saved (`group` or `group.section`); one no longer in the table falls back to its group, or General. */
export function settingsPaneFrom(saved: string | undefined): SettingsPane {
  const [groupId, sectionId] = (saved ?? '').split('.');
  const group = SETTINGS_GROUPS.find((each) => each.id === groupId);
  if (group === undefined) return { group: 'general' };
  return group.sections.some((each) => each.id === sectionId) ? { group: group.id, section: sectionId } : { group: group.id };
}

/** A pane as it is saved, and as the main process is asked to open it. */
export function settingsPaneText(pane: SettingsPane): string {
  return pane.section === undefined ? pane.group : `${pane.group}.${pane.section}`;
}
