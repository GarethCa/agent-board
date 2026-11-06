import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, onTestFinished } from 'vitest';
import { migrate } from '../src/migrate.ts';
import { COMPACT_WINDOW_RANGE } from '../src/protocol.ts';
import { createSettings, defaultEffort } from '../src/settings.ts';

function setup() {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  onTestFinished(() => db.close());
  const settings = createSettings(db, () => {});
  const set = (params: object) => (settings.handlers<null>()['settings.set'] as (params: object, context: null) => unknown)(params, null);
  return { settings, set };
}

describe('the spacing new zones take', () => {
  it('is roomy until it is changed, and keeps any of the three', () => {
    const { settings, set } = setup();
    expect(settings.get().arrangeSpacing).toBe('roomy');
    set({ arrangeSpacing: 'compact' });
    expect(settings.get().arrangeSpacing).toBe('compact');
    expect(() => set({ arrangeSpacing: 'huge' })).toThrow(/arrangeSpacing must be one of compact, normal, roomy/);
    expect(settings.get().arrangeSpacing).toBe('compact');
  });
});

describe('the compact window setting', () => {
  it('is off until it is changed', () => {
    expect(setup().settings.get().compactWindow).toBe(0);
  });

  it('keeps a window in tokens, and 0 turns it off again', () => {
    const { settings, set } = setup();
    set({ compactWindow: 400_000 });
    expect(settings.get().compactWindow).toBe(400_000);
    set({ compactWindow: 0 });
    expect(settings.get().compactWindow).toBe(0);
  });

  it('accepts the ends of the range Claude Code takes', () => {
    const { settings, set } = setup();
    set({ compactWindow: COMPACT_WINDOW_RANGE.min });
    expect(settings.get().compactWindow).toBe(100_000);
    set({ compactWindow: COMPACT_WINDOW_RANGE.max });
    expect(settings.get().compactWindow).toBe(1_000_000);
  });

  it.each([-1, 1.5, 99_999, 1_000_001, '400000', null])('refuses %j and keeps what it was', (value) => {
    const { settings, set } = setup();
    set({ compactWindow: 200_000 });
    expect(() => set({ compactWindow: value })).toThrow(/compactWindow must be/);
    expect(settings.get().compactWindow).toBe(200_000);
  });
});

describe('the clickable links setting', () => {
  it('is on until it is turned off, and stays as it was set', () => {
    const { settings, set } = setup();
    expect(settings.get().clickableLinks).toBe(true);
    set({ clickableLinks: false });
    expect(settings.get().clickableLinks).toBe(false);
    set({ clickableLinks: true });
    expect(settings.get().clickableLinks).toBe(true);
  });

  it('refuses anything but a boolean', () => {
    const { settings, set } = setup();
    expect(() => set({ clickableLinks: 'no' })).toThrow();
    expect(settings.get().clickableLinks).toBe(true);
  });
});

describe('the keep web logins setting', () => {
  it('is on until it is turned off, and stays as it was set', () => {
    const { settings, set } = setup();
    expect(settings.get().keepWebLogins).toBe(true);
    set({ keepWebLogins: false });
    expect(settings.get().keepWebLogins).toBe(false);
    set({ keepWebLogins: true });
    expect(settings.get().keepWebLogins).toBe(true);
  });

  it('refuses anything but a boolean', () => {
    const { settings, set } = setup();
    expect(() => set({ keepWebLogins: 1 })).toThrow();
    expect(settings.get().keepWebLogins).toBe(true);
  });
});

describe('the reasoning effort new agents start at', () => {
  it("is the harness's own until it is set, for every new agent and for a role of its own", () => {
    const { settings, set } = setup();
    expect(settings.get()).toMatchObject({ defaultEffort: null, roleEfforts: {} });
    expect(defaultEffort(settings.get(), 'claude', 'designer')).toBeNull();

    set({ defaultEffort: 'medium', roleEfforts: { designer: 'max', reviewer: 'high' } });

    expect(defaultEffort(settings.get(), 'claude', null)).toBe('medium');
    expect(defaultEffort(settings.get(), 'claude', 'implementer')).toBe('medium');
    expect(defaultEffort(settings.get(), 'claude', 'designer')).toBe('max');
    expect(defaultEffort(settings.get(), 'codex', 'reviewer')).toBe('high');
  });

  it('matches a role by its name in any case, as role templates do, and a follow-up reviewer as a reviewer', () => {
    const { settings, set } = setup();
    set({ defaultEffort: 'low', roleEfforts: { Designer: 'max', reviewer: 'high' } });
    expect(settings.get().roleEfforts).toEqual({ designer: 'max', reviewer: 'high' });
    expect(defaultEffort(settings.get(), 'claude', 'DESIGNER')).toBe('max');
    expect(defaultEffort(settings.get(), 'claude', 'follow-up-reviewer')).toBe('high');
  });

  it('gives a Codex agent its highest when the default is one Codex does not take', () => {
    const { settings, set } = setup();
    set({ roleEfforts: { designer: 'max' } });
    expect(defaultEffort(settings.get(), 'codex', 'designer')).toBe('xhigh');
  });

  it('goes back to the harness’s own with null, and a role’s with the role left out', () => {
    const { settings, set } = setup();
    set({ defaultEffort: 'high', roleEfforts: { designer: 'max' } });
    set({ defaultEffort: null, roleEfforts: {} });
    expect(settings.get()).toMatchObject({ defaultEffort: null, roleEfforts: {} });
  });

  it('refuses a level no harness takes, or a role with no name, and keeps what it was', () => {
    const { settings, set } = setup();
    set({ defaultEffort: 'low', roleEfforts: { designer: 'high' } });
    expect(() => set({ defaultEffort: 'huge' })).toThrow('defaultEffort must be one of low, medium, high, xhigh, max, or null');
    expect(() => set({ roleEfforts: { designer: 'huge' } })).toThrow('roleEfforts.designer must be one of low, medium, high, xhigh, max');
    expect(() => set({ roleEfforts: { ' ': 'high' } })).toThrow('roleEfforts takes a role by its name');
    expect(() => set({ roleEfforts: ['high'] })).toThrow('roleEfforts must be an object of role names to efforts');
    expect(settings.get()).toMatchObject({ defaultEffort: 'low', roleEfforts: { designer: 'high' } });
  });
});
