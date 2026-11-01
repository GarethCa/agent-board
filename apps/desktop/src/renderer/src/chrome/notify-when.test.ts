import { describe, expect, it } from 'vitest';
import { NOTIFY_WHEN, needsYouShowsFrom, showsInFrontSwitch } from './notify-when';

describe('Notify me when', () => {
  it('offers explicit requests first, then finished turns too, as the words say', () => {
    expect(NOTIFY_WHEN.map(({ value, label }) => [label, value])).toEqual([
      ['Something needs me', 'explicit'],
      ['Something needs me or finishes', 'turns'],
    ]);
  });

  it('writes the setting a choice stands for, and the default for anything else', () => {
    expect(needsYouShowsFrom('turns')).toBe('turns');
    expect(needsYouShowsFrom('explicit')).toBe('explicit');
    expect(needsYouShowsFrom('never')).toBe('explicit');
  });

  it('draws the in-front switch only with technical details shown', () => {
    expect(showsInFrontSwitch(true)).toBe(true);
    expect(showsInFrontSwitch(false)).toBe(false);
  });
});
