// The board's view settings: what a double-click on a tile opens, how a crew and agent notes look, and which connections
// are drawn. Kept in the daemon's view state, and held here once per window, so the board and the Settings window read
// and set the same values. Main tells every window of a change, so each follows live.
import { useSyncExternalStore } from 'react';
import { VIEW_KEYS } from '../../../shared/view-saver';
import { clickOpensFrom, type ClickOpens } from './click-opens';
import { connectionsViewFrom, type ConnectionsView } from './connections-view';
import { crewLookFrom, lightCrew, type CrewLook } from './crew-view';
import { agentNoteLookFrom, type AgentNoteLook } from './items/agent-note-look';

export interface ViewSettings {
  clickOpens: ClickOpens;
  crewLook: CrewLook;
  connections: ConnectionsView;
  agentNoteLook: AgentNoteLook;
}

export const DEFAULT_VIEW_SETTINGS: ViewSettings = {
  clickOpens: clickOpensFrom(undefined),
  crewLook: crewLookFrom(undefined),
  connections: connectionsViewFrom(undefined),
  agentNoteLook: agentNoteLookFrom(undefined),
};

/** Each setting's view state key and the reader of what was saved under it (read back untyped). */
const SETTINGS = {
  clickOpens: { key: VIEW_KEYS.clickOpens, from: clickOpensFrom },
  crewLook: { key: VIEW_KEYS.crewLook, from: crewLookFrom },
  connections: { key: VIEW_KEYS.connections, from: connectionsViewFrom },
  agentNoteLook: { key: VIEW_KEYS.agentNoteLook, from: agentNoteLookFrom },
} as const;

let current: ViewSettings = DEFAULT_VIEW_SETTINGS;
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
  );
  return window.agentBoard.view.onChanged((key, value) => {
    const name = (Object.keys(SETTINGS) as (keyof ViewSettings)[]).find((each) => SETTINGS[each].key === key);
    if (name !== undefined) restoreViewSettings({ [name]: value });
  });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The settings, for a component that shows them. */
export function useViewSettings(): ViewSettings {
  return useSyncExternalStore(subscribe, viewSettings);
}
