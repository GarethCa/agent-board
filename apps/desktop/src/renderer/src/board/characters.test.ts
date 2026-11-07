import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CharacterStyleChoices } from '../chrome/CharactersSetting';
import { characterMotionOf, characterStyleOf } from './characters';

describe('the Characters setting', () => {
  it('is Bean & Block unless another style is stored', () => {
    expect(characterStyleOf(undefined)).toBe('bean');
    expect(characterStyleOf('sparkles')).toBe('bean');
    for (const style of ['off', 'bean', 'pebble', 'pixel']) expect(characterStyleOf(style)).toBe(style);
  });

  it('moves on a change unless Still is stored', () => {
    expect(characterMotionOf(undefined)).toBe('move');
    expect(characterMotionOf('wobble')).toBe('move');
    expect(characterMotionOf('still')).toBe('still');
  });

  it("previews each style's two bodies large, in the pose with the most distinct silhouette", () => {
    const html = renderToStaticMarkup(createElement(CharacterStyleChoices));
    const previews = [...html.matchAll(/data-pose="([^"]+)"[^>]*data-body="(\w+)" data-style="(\w+)"[^>]*height="(\d+)"/g)].map((found) => found.slice(1, 5).join('/'));
    expect(previews).toEqual(['bean', 'pebble', 'pixel'].flatMap((style) => [`done/bean/${style}/40`, `done/block/${style}/40`]));
  });
});
