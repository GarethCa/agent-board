import { afterEach, describe, expect, it } from 'vitest';
import { menuSectionOpen, setMenuSectionOpen, type MenuSection } from './board-menu-fold';

const SECTIONS: MenuSection[] = ['zones', 'sessions', 'help', 'quick-settings'];

// The stores keep what they were given in memory here (there is no localStorage), so each test puts every section back
// to how a first use finds it, whatever order the tests run in.
afterEach(() => {
  for (const section of SECTIONS) setMenuSectionOpen(section, section === 'zones');
});

describe('the board menu sections', () => {
  it('start with only Zones open', () => {
    expect(SECTIONS.filter(menuSectionOpen)).toEqual(['zones']);
  });

  it('stay as each was left', () => {
    setMenuSectionOpen('zones', false);
    setMenuSectionOpen('help', true);
    expect(SECTIONS.filter(menuSectionOpen)).toEqual(['help']);
  });
});
