import { describe, expect, it } from 'vitest';
import { SETTINGS_CONTROLS, SETTINGS_GROUPS, settingsPaneFrom, sectionOf } from './settings-ia';

describe('the Settings window’s groups', () => {
  it('are the seven, in order', () => {
    expect(SETTINGS_GROUPS.map((group) => group.name)).toEqual(['General', 'Board', 'Agents', 'Alerts', 'Usage', 'Accounts', 'Advanced']);
  });

  it('hold every control the app has, each in exactly one section: nothing is lost in the move', () => {
    // Every control Settings had in the board menu, by id.
    const today = [
      'otherTerminals',
      'heldHandOffs',
      'claudePath',
      'codexPath',
      'compactWindow',
      'clickableLinks',
      'mode',
      'theme',
      'keepWebLogins',
      'clearBrowsingData',
      'clickOpens',
      'connections',
      'arrangeSpacing',
      'agentNoteLook',
      'crewLook',
      'needsYouShows',
      'osNotifications',
      'notifyInFront',
      'mutedAgents',
      'chatStyle',
      'usageReading',
      'usageOnBoard',
      'usageThresholds',
      'usagePacing',
      'extendedShortcuts',
      'cliInstall',
      'simplifiedDesign',
      'daemonStatus',
      // Added since, under the Simplified design only.
      'technicalDetails',
      'statusLook',
      'opensOn',
    ];
    const ids = SETTINGS_CONTROLS.map((control) => control.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual([...today].sort());
    for (const control of SETTINGS_CONTROLS) expect(sectionOf(control.home), control.id).toBeDefined();
  });

  it('puts the controls that moved where they now live', () => {
    const home = (id: string) => SETTINGS_CONTROLS.find((control) => control.id === id)?.home;
    expect(home('otherTerminals')).toBe('accounts.terminals');
    expect(home('arrangeSpacing')).toBe('board.tidying');
    expect(home('chatStyle')).toBe('agents.chat');
    expect(home('needsYouShows')).toBe('alerts.notifications');
    expect(home('cliInstall')).toBe('advanced.cli');
    expect(home('keepWebLogins')).toBe('advanced.webTabs');
    expect(home('daemonStatus')).toBe('advanced.service');
    expect(home('simplifiedDesign')).toBe('general.design');
    expect(home('technicalDetails')).toBe('general.design');
    expect(home('statusLook')).toBe('general.design');
  });

  it('have no empty group or section', () => {
    for (const group of SETTINGS_GROUPS) {
      expect(group.sections.length, group.id).toBeGreaterThan(0);
      for (const section of group.sections) expect(SETTINGS_CONTROLS.some((control) => control.home === `${group.id}.${section.id}`), `${group.id}.${section.id}`).toBe(true);
    }
  });
});

describe('settingsPaneFrom', () => {
  it('reads a saved pane back, a group alone or a group and its section', () => {
    expect(settingsPaneFrom('usage')).toEqual({ group: 'usage' });
    expect(settingsPaneFrom('board.tidying')).toEqual({ group: 'board', section: 'tidying' });
  });

  it('falls back to General for anything it no longer knows', () => {
    expect(settingsPaneFrom(undefined)).toEqual({ group: 'general' });
    expect(settingsPaneFrom('webTabs')).toEqual({ group: 'general' });
    expect(settingsPaneFrom('board.nowhere')).toEqual({ group: 'board' });
  });
});
