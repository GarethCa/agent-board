import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (...path: string[]) => readFileSync(join(import.meta.dirname, '..', ...path), 'utf8');
const app = read('app.css');
const ui = read('ui', 'ui.css');
const tokens = read('tokens.css');

/** The declarations of the rule whose selector is exactly `selector`, in `css`. */
function rule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|\\n)${escaped} \\{([^}]*)\\}`).exec(css)?.[1] ?? '';
}

describe("a header's long title keeps its buttons inside it", () => {
  it("lets the agent's name give way, with an ellipsis, in a session window, an expanded tile and the pop-up", () => {
    const name = rule(app, '.session-window-name');
    expect(name).toMatch(/flex: 0 1 auto;/);
    expect(name).toMatch(/min-width: 0;/);
    expect(name).toMatch(/overflow: hidden;/);
    expect(name).toMatch(/text-overflow: ellipsis;/);
    expect(name).toMatch(/white-space: nowrap;/);
  });

  it("keeps the branch chip a hundred times quicker to give way than the name, so the name still keeps its room first", () => {
    expect(rule(app, '.session-window-where')).toMatch(/flex: 0 100 auto;/);
  });

  it("lets a ticket's title give way in its expanded tile and its pop-up", () => {
    for (const selector of ['.ticket-open-title', '.agent-popup-title']) {
      const title = rule(app, selector);
      expect(title, selector).toMatch(/min-width: 0;/);
      expect(title, selector).toMatch(/overflow: hidden;/);
      expect(title, selector).toMatch(/text-overflow: ellipsis;/);
    }
    expect(rule(app, '.ticket-open-title')).toMatch(/flex: 0 1 auto;/);
  });

  it('never shrinks a button, so each keeps its size at the header’s end', () => {
    expect(rule(ui, '.ui-button')).toMatch(/flex: none;/);
  });
});

describe("an agent's pop-up", () => {
  it('keeps a small margin of board round it, and has no pixel cap: its size is worked out on the board (popup-size.ts)', () => {
    expect(rule(app, '.agent-popup-scrim')).toMatch(/padding: var\(--space-4\);/);
    expect(tokens).toMatch(/--space-4: 16px;/);
    expect(rule(app, '.agent-popup-frame')).toMatch(/max-width: 100%;/);
    expect(rule(app, '.agent-popup-frame')).toMatch(/max-height: 100%;/);
    expect(rule(app, '.agent-popup')).toMatch(/width: 100%;/);
    expect(tokens).not.toMatch(/--popup-width|--popup-height/);
  });

  it('is the size it was given, its border inside it, so it neither spills past its frame nor sits off centre', () => {
    expect(rule(app, '.agent-popup')).toMatch(/box-sizing: border-box;/);
  });
});
