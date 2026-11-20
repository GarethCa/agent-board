import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { popupFrostOf } from './popup-frost';

const read = (...path: string[]) => readFileSync(join(import.meta.dirname, '..', ...path), 'utf8');
const app = read('app.css');
const tokens = read('tokens.css');

describe('the frost behind a pop-up', () => {
  it('is on by default, and off only when turned off', () => {
    expect(popupFrostOf(undefined)).toBe(true);
    expect(popupFrostOf('on')).toBe(true);
    expect(popupFrostOf('off')).toBe(false);
  });

  it('blurs the board as well as dimming it, and turned off only dims it', () => {
    const frosted = /\.agent-popup-scrim\[data-frost\] \{([^}]*)\}/.exec(app)?.[1] ?? '';
    expect(frosted).toMatch(/backdrop-filter: blur\(var\(--blur-popup\)\);/);
    expect(frosted).toMatch(/background: var\(--scrim-popup-frost\);/);
    const plain = /\n\.agent-popup-scrim \{([^}]*)\}/.exec(app)?.[1] ?? '';
    expect(plain).not.toMatch(/backdrop-filter/);
    expect(plain).toMatch(/background: var\(--scrim-popup\);/);
    expect(tokens).toMatch(/--blur-popup: \d+px;/);
  });

  it('with reduced transparency asked for, drops the blur for a deeper dim', () => {
    const media = app.slice(app.indexOf('@media (prefers-reduced-transparency: reduce)'));
    expect(media).toMatch(/^@media \(prefers-reduced-transparency: reduce\) \{\s*\.agent-popup-scrim\[data-frost\] \{\s*backdrop-filter: none;\s*background: var\(--scrim-popup-solid\);/);
  });
});
