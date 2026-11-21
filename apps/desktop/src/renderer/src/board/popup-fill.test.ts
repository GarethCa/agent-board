import { describe, expect, it } from 'vitest';
import { popupFillOf } from './popup-fill';

describe('whether a pop-up fills a wide screen', () => {
  it('is off by default, and on only when turned on', () => {
    expect(popupFillOf(undefined)).toBe(false);
    expect(popupFillOf('off')).toBe(false);
    expect(popupFillOf('on')).toBe(true);
  });
});
