import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postcss from 'postcss';
import { describe, expect, it } from 'vitest';

/** Each rule's declarations in chrome.css, by selector. */
const rules = new Map<string, Record<string, string>>();
postcss.parse(readFileSync(join(import.meta.dirname, 'chrome.css'), 'utf8')).walkRules((rule) => {
  const decls: Record<string, string> = { ...rules.get(rule.selector) };
  rule.walkDecls((decl) => void (decls[decl.prop] = decl.value));
  rules.set(rule.selector, decls);
});
const rule = (selector: string) => rules.get(selector) ?? {};

// Playwright can't drag an OS window, so the drag regions (ADR-0001) are checked here, in the stylesheet.
describe('the window drag regions on macOS', () => {
  it('are the strip along the top, the traffic lights’ corner and the board menu’s empty space', () => {
    expect(rule(":root[data-chrome='inset'] .window-drag-strip")['-webkit-app-region']).toBe('drag');
    expect(rule(":root[data-chrome='inset'] .window-drag-corner")['-webkit-app-region']).toBe('drag');
    expect(rule(":root[data-chrome='inset'] [data-drag-region]")['-webkit-app-region']).toBe('drag');
  });

  // A drag region swallows a double-click (macOS zooms the window), so a name in a header must opt out to be renamed.
  it('leave every control, and a name that renames on a double-click, in a drag region clickable', () => {
    expect(rule(":root[data-chrome='inset'] [data-drag-region] :is(button, input, a, img, [tabindex], .editable-name)")['-webkit-app-region']).toBe('no-drag');
  });

  it('drop the corner while a session window is shown, as it would cover the window’s header', () => {
    expect(rule(":root[data-chrome='inset'] .board:has(.session-window-board) .window-drag-corner").display).toBe('none');
  });

  it('are drawn nowhere outside macOS', () => {
    expect(rule('.window-drag-strip').display).toBe('none');
    expect(rule('.window-drag-corner').display).toBe('none');
  });
});
