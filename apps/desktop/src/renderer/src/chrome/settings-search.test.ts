import { describe, expect, it } from 'vitest';
import { searchSettings, type SettingsHit } from './settings-search';

/** Each hit as `Group › Section: control, control`. */
const shown = (hits: readonly SettingsHit[]) =>
  hits.map((hit) => `${hit.group.name} › ${hit.section.name}: ${hit.controls.map((control) => control.label).join(', ')}`);

describe('searchSettings', () => {
  it('finds a section by its name, with every control in it', () => {
    expect(shown(searchSettings('appearance', { simplified: false }))).toEqual(['General › Appearance: Mode, Theme']);
  });

  it('finds controls by their labels across groups, in the order the sidebar lists them', () => {
    expect(shown(searchSettings('path', { simplified: false }))).toEqual(['Advanced › Programs: Claude path, Codex path']);
    expect(shown(searchSettings('notif', { simplified: false }))).toEqual([
      'Alerts › Notifications: Needs you shows, OS notifications, Also while agent-board is in front, A tile muted from its ⋯ menu never notifies',
    ]);
  });

  it('finds a control by the other words it goes by, so one that moved or was renamed is still found', () => {
    expect(shown(searchSettings('spacing', { simplified: false }))).toEqual(['Board › Tidying: Arrange spacing']);
    expect(shown(searchSettings('hooks', { simplified: false }))).toEqual(['Accounts › Other terminals: Other terminals']);
    expect(shown(searchSettings('dark', { simplified: false }))).toEqual(['General › Appearance: Mode']);
  });

  it('ignores case, accents and the space around the words', () => {
    expect(shown(searchSettings('  CLAUDE PÁTH ', { simplified: false }))).toEqual(['Advanced › Programs: Claude path']);
  });

  it('leaves out the controls only the Simplified design draws, under Classic', () => {
    expect(shown(searchSettings('technical', { simplified: false }))).toEqual([]);
    expect(shown(searchSettings('technical', { simplified: true }))).toEqual(['General › Design: Show technical details']);
    // A section found by its name lists only the controls drawn.
    expect(shown(searchSettings('design', { simplified: false }))).toEqual(['General › Design: Use the Simplified design']);
  });

  it('finds nothing for an empty query, or one that matches nothing', () => {
    expect(searchSettings('', { simplified: false })).toEqual([]);
    expect(searchSettings('   ', { simplified: false })).toEqual([]);
    expect(searchSettings('zzzz', { simplified: false })).toEqual([]);
  });
});
