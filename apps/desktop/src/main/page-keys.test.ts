import { describe, expect, it } from 'vitest';
import { isAccelerator, pageKeys, type PageInput } from './page-keys';

const press = (more: Partial<PageInput>): PageInput => ({ key: 'd', code: 'KeyD', meta: false, control: false, shift: false, alt: false, ...more });

describe('the chords a web page kept', () => {
  it('reads an accelerator as the chord it is on each platform', () => {
    expect(isAccelerator('CommandOrControl+D', press({ control: true }), false)).toBe(true);
    expect(isAccelerator('CommandOrControl+D', press({ control: true }), true)).toBe(false);
    expect(isAccelerator('CommandOrControl+D', press({ meta: true }), true)).toBe(true);
    expect(isAccelerator('CommandOrControl+D', press({ control: true, shift: true }), false)).toBe(false);
    expect(isAccelerator('CommandOrControl+Shift+A', press({ key: 'A', code: 'KeyA', control: true, shift: true }), false)).toBe(true);
    // By its code too, as a layout or ⇧ changes the key: ⇧[ is "{".
    expect(isAccelerator('CommandOrControl+Shift+[', press({ key: '{', code: 'BracketLeft', control: true, shift: true }), false)).toBe(true);
    expect(isAccelerator('CommandOrControl+\\', press({ key: '\\', code: 'Backslash', control: true }), false)).toBe(true);
    expect(isAccelerator('CommandOrControl++', press({ key: '+', code: 'Equal', control: true }), false)).toBe(true);
  });

  it('drops the accelerator that fires for a press a page kept, once, in that window only, and soon after', () => {
    let time = 0;
    const keys = pageKeys(false, () => time);
    keys.kept(1, press({ control: true }));
    expect(keys.took(2, 'CommandOrControl+D')).toBe(false);
    expect(keys.took(1, 'CommandOrControl+T')).toBe(false);
    expect(keys.took(1, 'CommandOrControl+D')).toBe(true);
    expect(keys.took(1, 'CommandOrControl+D')).toBe(false);

    keys.kept(1, press({ control: true }));
    time = 5000;
    expect(keys.took(1, 'CommandOrControl+D')).toBe(false);

    // A bare key the page types is never a chord.
    keys.kept(1, press({}));
    expect(keys.took(1, 'CommandOrControl+D')).toBe(false);
    expect(keys.took(1, undefined)).toBe(false);
  });
});
