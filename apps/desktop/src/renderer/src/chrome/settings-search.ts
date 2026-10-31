// Searching settings, from the table of where each one lives (settings-ia.ts): the Settings window's field filters its
// sidebar with it, and ⌘K lists settings from the same table. Pure, so what finds what is unit-tested.
import { SETTINGS_CONTROLS, SETTINGS_GROUPS, type SettingsControl, type SettingsGroup, type SettingsSection } from './settings-ia';

/** A section that matched, and its controls that did: all of the ones drawn, if its own name or its group's matched. */
export interface SettingsHit {
  group: SettingsGroup;
  section: SettingsSection;
  controls: readonly SettingsControl[];
}

/** Text as searching compares it: lower case, with no accents, so "Pàth" finds "path". */
export const searchable = (text: string) =>
  text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();

/** The controls the window draws in `home`: under Classic, not the ones only the Simplified design draws. */
export const controlsIn = (home: string, simplified: boolean) =>
  SETTINGS_CONTROLS.filter((control) => control.home === home && (simplified || !control.simplifiedOnly));

/**
 * The sections that hold `query`, in the sidebar's order: in their own name or their group's, or in a control's label
 * or the other words it goes by (`also`). Empty for an empty query.
 */
export function searchSettings(query: string, { simplified }: { simplified: boolean }): SettingsHit[] {
  const wanted = searchable(query.trim());
  if (wanted === '') return [];
  const holds = (text: string | undefined) => text !== undefined && searchable(text).includes(wanted);
  return SETTINGS_GROUPS.flatMap((group) =>
    group.sections.flatMap((section) => {
      const drawn = controlsIn(`${group.id}.${section.id}`, simplified);
      const controls = holds(group.name) || holds(section.name) ? drawn : drawn.filter((control) => holds(control.label) || holds(control.also));
      return controls.length === 0 ? [] : [{ group, section, controls }];
    }),
  );
}
