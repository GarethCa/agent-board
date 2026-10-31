import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, onTestFinished } from 'vitest';
import { migrate } from '../src/migrate.ts';
import { COMPACT_WINDOW_RANGE, DEFAULT_USAGE_THRESHOLDS } from '../src/protocol.ts';
import { createSettings } from '../src/settings.ts';

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

describe('usage pacing', () => {
  it('is off until the user turns it on, with the default thresholds', () => {
    const { settings, set } = setup();
    expect(settings.get()).toMatchObject({ usagePacing: false, usageThresholds: DEFAULT_USAGE_THRESHOLDS });
    set({ usagePacing: true });
    expect(settings.get().usagePacing).toBe(true);
  });

  it('keeps the thresholds given, each a whole percentage from 1 to 100, over the others', () => {
    const { settings, set } = setup();
    set({ usageThresholds: { fiveHourOnlyHigh: 70 } });
    expect(settings.get().usageThresholds).toEqual({ ...DEFAULT_USAGE_THRESHOLDS, fiveHourOnlyHigh: 70 });
    expect(() => set({ usageThresholds: { fiveHourPauseLow: 101 } })).toThrow(/whole percentage from 1 to 100/);
    expect(() => set({ usageThresholds: { daily: 50 } })).toThrow(/usageThresholds has no daily/);
    expect(settings.get().usageThresholds).toEqual({ ...DEFAULT_USAGE_THRESHOLDS, fiveHourOnlyHigh: 70 });
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
