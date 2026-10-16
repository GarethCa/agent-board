import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, onTestFinished } from 'vitest';
import { migrate } from '../src/migrate.ts';
import { COMPACT_WINDOW_RANGE } from '../src/protocol.ts';
import { createSettings } from '../src/settings.ts';

function setup() {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  onTestFinished(() => db.close());
  const settings = createSettings(db, () => {});
  const set = (params: object) => (settings.handlers<null>()['settings.set'] as (params: object, context: null) => unknown)(params, null);
  return { settings, set };
}

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
