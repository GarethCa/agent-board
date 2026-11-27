import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PopupViewSwitch } from './agent-view/AgentViewHeader';

const css = readFileSync(join(import.meta.dirname, '..', 'app.css'), 'utf8');
const draw = (agentOn: boolean) => renderToStaticMarkup(createElement(PopupViewSwitch, { viewKey: 'a1', agentOn }));

describe("the pop-up header's Chat | Terminal switch", () => {
  it('names every agent in the pop-up, and dims, saying so, while a view or shell tab is on', () => {
    const on = draw(true);
    expect(on).toContain('aria-label="View of every agent in this pop-up"');
    expect(on).not.toContain('data-dimmed');
    expect(on).toContain('title="Every agent in this pop-up"');
    const off = draw(false);
    expect(off).toContain('data-dimmed="true"');
    expect(off).toContain('title="Applies when an agent tab is on"');
    expect(css).toMatch(/\.agent-popup-switch\[data-dimmed\]\s*\{[^}]*opacity/);
  });

  it('keeps its words in each button, which fold to its icons in a narrow header', () => {
    const html = draw(true);
    expect(html.match(/class="ui-segmented-label"/g)).toHaveLength(2);
    expect(html).toContain('>Chat<');
    expect(html).toContain('>Terminal<');
    expect(css).toMatch(/\.agent-popup-head\s*\{[^}]*container-type:\s*inline-size/);
    expect(css).toMatch(/@container \(max-width: 720px\)\s*\{\s*\.agent-popup-switch \.ui-segmented-label\s*\{[^}]*clip-path/);
  });
});
