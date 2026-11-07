// The board's view settings: what a double-click on a tile opens, how a crew and agent notes look, which connections
// are drawn, which sidebar an agent's window shows, and whether terminals draw with the GPU. Kept in the daemon's view state, and held here once per window, so the board and the Settings window read
// and set the same values. Main tells every window of a change, so each follows live.
import { useSyncExternalStore } from 'react';
import { VIEW_KEYS } from '../../../shared/view-saver';
import { clickOpensFrom, type ClickOpens } from './click-opens';
import { connectionsViewFrom, type ConnectionsView } from './connections-view';
import { crewLookFrom, lightCrew, type CrewLook } from './crew-view';
import { agentNoteLookFrom, type AgentNoteLook } from './items/agent-note-look';
import { agentSidebarFrom, type AgentSidebar } from '../session/agent-sidebar';
import { gpuTerminalsFrom } from '../session/terminal-gpu';
import { keepTerminalsFrom } from '../session/kept-terminals';

export interface ViewSettings {
  clickOpens: ClickOpens;
  crewLook: CrewLook;
  connections: ConnectionsView;
  agentNoteLook: AgentNoteLook;
  agentSidebar: AgentSidebar;
  gpuTerminals: boolean;
  keepTerminals: boolean;
}

export const DEFAULT_VIEW_SETTINGS: ViewSettings = {
  clickOpens: clickOpensFrom(undefined),
  crewLook: crewLookFrom(undefined),
  connections: connectionsViewFrom(undefined),
  agentNoteLook: agentNoteLookFrom(undefined),
  agentSidebar: agentSidebarFrom(undefined),
  gpuTerminals: gpuTerminalsFrom(undefined),
  keepTerminals: keepTerminalsFrom(undefined),
};

/** Each setting's view state key and the reader of what was saved under it (read back untyped). */
const SETTINGS = {
  clickOpens: { key: VIEW_KEYS.clickOpens, from: clickOpensFrom },
  crewLook: { key: VIEW_KEYS.crewLook, from: crewLookFrom },
  connections: { key: VIEW_KEYS.connections, from: connectionsViewFrom },
  agentNoteLook: { key: VIEW_KEYS.agentNoteLook, from: agentNoteLookFrom },
  agentSidebar: { key: VIEW_KEYS.agentSidebar, from: agentSidebarFrom },
  gpuTerminals: { key: VIEW_KEYS.gpuTerminals, from: gpuTerminalsFrom },
  keepTerminals: { key: VIEW_KEYS.keepTerminals, from: keepTerminalsFrom },
} as const;

let current: ViewSettings = DEFAULT_VIEW_SETTINGS;
/** Whether the saved settings have been read, for what must not act on a default the user changed. */
let loaded = false;
const listeners = new Set<() => void>();

/** Holds `next`, and tells the subscribers if any setting differs: `current` is a new object only then. */
function update(next: Partial<ViewSettings>): void {
  const merged = { ...current, ...next };
  if ((Object.keys(merged) as (keyof ViewSettings)[]).every((name) => merged[name] === current[name])) return;
  current = merged;
  for (const listener of listeners) listener();
}

export function viewSettings(): ViewSettings {
  return current;
}

/** Sets one setting, here at once and saved for every window. */
export function setViewSetting<Name extends keyof ViewSettings>(name: Name, value: ViewSettings[Name]): void {
  update({ [name]: value });
  void window.agentBoard.view.set(SETTINGS[name].key, value).catch(() => {});
}

/** Sets how crews show, and puts out the light on a crew chip under the pointer, which may go with the change and take its mouse-leave with it. */
export function setCrewLook(value: CrewLook): void {
  setViewSetting('crewLook', value);
  lightCrew(undefined);
}

/** Holds settings as the board read them with its view state, without saving them back. */
export function restoreViewSettings(saved: Partial<Record<keyof ViewSettings, unknown>>): void {
  const next: Partial<ViewSettings> = {};
  for (const name of Object.keys(SETTINGS) as (keyof ViewSettings)[]) {
    if (name in saved) Object.assign(next, { [name]: SETTINGS[name].from(saved[name]) });
  }
  update(next);
}

/** Reads the saved settings now, and holds each change another window makes. Returns the function that stops following. */
export function followViewSettings(): () => void {
  void Promise.all(
    (Object.keys(SETTINGS) as (keyof ViewSettings)[]).map((name) => window.agentBoard.view.get(SETTINGS[name].key).then((saved) => [name, saved] as const)),
  ).then(
    (read) => restoreViewSettings(Object.fromEntries(read)),
    () => {},
  ).finally(() => {
    loaded = true;
    for (const listener of listeners) listener();
  });
  return window.agentBoard.view.onChanged((key, value) => {
    const name = (Object.keys(SETTINGS) as (keyof ViewSettings)[]).find((each) => SETTINGS[each].key === key);
    if (name !== undefined) restoreViewSettings({ [name]: value });
  });
}

/** Calls `listener` at each change of a setting, for what outlives every component that reads them. */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Whether the saved settings have been read (or failed to be), for what must not act on a default. */
export function viewSettingsLoaded(): boolean {
  return loaded;
}

/** Whether the saved settings have been read, for a component that must not act on a default. */
export function useViewSettingsLoaded(): boolean {
  return useSyncExternalStore(subscribe, viewSettingsLoaded);
}

/** The settings, for a component that shows them. */
export function useViewSettings(): ViewSettings {
  return useSyncExternalStore(subscribe, viewSettings);
}
