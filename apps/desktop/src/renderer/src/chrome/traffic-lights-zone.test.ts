import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postcss from 'postcss';
import { describe, expect, it } from 'vitest';

/** Each rule's declarations in the renderer's stylesheets, by selector. */
const rules = new Map<string, Record<string, string>>();
for (const sheet of ['chrome/chrome.css', 'app.css', 'overview/overview.css', 'tokens.css']) {
  postcss.parse(readFileSync(join(import.meta.dirname, '..', sheet), 'utf8')).walkRules((rule) => {
    const decls: Record<string, string> = { ...rules.get(rule.selector) };
    rule.walkDecls((decl) => void (decls[decl.prop] = decl.value));
    rules.set(rule.selector, decls);
  });
}
const rule = (selector: string) => rules.get(selector) ?? {};

// Every window keeps clear of the traffic lights' one safe zone (shared/traffic-lights.ts), which the page sets and
// which is 0 off macOS and in full screen, so the same rules hold everywhere.
describe('the traffic lights’ safe zone in the stylesheets', () => {
  it('is 0 until the page sets it', () => {
    expect(rule(':root')['--traffic-lights-right']).toBe('0px');
    expect(rule(':root')['--traffic-lights-bottom']).toBe('0px');
  });

  it('keeps the board’s top-left island past it', () => {
    expect(rule('.island-top-left').left).toBe('max(var(--island-inset), calc(var(--traffic-lights-right) + var(--space-2)))');
  });

  it('keeps a popped-out window’s header past it', () => {
    expect(rule(':is(.session-window-own-window, .agent-popup-own-window) .session-window-head')['padding-left']).toBe(
      'max(var(--space-4), calc(var(--traffic-lights-right) + var(--space-1-5)))',
    );
  });

  it('keeps an agent’s pop-up over the board below it', () => {
    expect(rule('.agent-popup-scrim').padding).toBe('max(var(--space-4), var(--traffic-lights-bottom)) var(--space-4) var(--space-4)');
  });

  it('keeps the Settings and Overview titles clear of it, centred', () => {
    expect(rule('.settings-window-bar')['padding-inline']).toBe('var(--traffic-lights-right)');
    expect(rule('.overview-bar')['padding-inline']).toBe('var(--traffic-lights-right)');
  });

  it('is the only room kept for the lights: no window keeps a width of its own', () => {
    for (const decls of rules.values()) expect(Object.keys(decls)).not.toContain('--size-traffic-lights');
  });
});
