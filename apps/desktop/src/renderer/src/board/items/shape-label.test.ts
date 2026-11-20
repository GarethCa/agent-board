import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ShapeBody } from './ShapeNode';

const css = readFileSync(join(import.meta.dirname, '..', '..', 'app.css'), 'utf8');

/** The `.shape-label` a shape of `shape` draws its text in. */
function labelOf(shape: string): string {
  const html = renderToStaticMarkup(createElement(ShapeBody, { style: { shape, text: 'Load balancer' } as never, width: 120, height: 100, children: 'Load balancer' }));
  return /<div class="shape-label"[^>]*>/.exec(html)?.[0] ?? '';
}

/** The declarations of the rule whose selector is exactly `selector`. */
const ruleOf = (selector: string): string => new RegExp(`(?:^|\\n)${selector.replace(/[[\]().]/g, '\\$&')} \\{([^}]*)\\}`).exec(css)?.[1] ?? '';

describe("a shape's label", () => {
  it('under a figure is marked as outside the shape; inside an outline it is not', () => {
    expect(labelOf('load-balancer')).toContain('data-outside');
    expect(labelOf('fork-join')).toContain('data-outside');
    expect(labelOf('rectangle')).not.toContain('data-outside');
  });

  it('inside an outline starts at its top when it overflows', () => {
    expect(ruleOf('.shape-label')).toMatch(/place-items: safe center;/);
  });

  it('under a figure stays centred on its strip, so its last line is not cut off', () => {
    expect(ruleOf('.shape-label[data-outside]')).toMatch(/place-items: center;/);
  });

  it('under a figure keeps its descenders, though its strip is shorter than its line', () => {
    expect(ruleOf('.shape-label')).toMatch(/overflow: hidden;/);
    expect(ruleOf('.shape-label[data-outside]')).toMatch(/overflow: clip;\s*overflow-clip-margin: var\(--space-1\);/);
  });
});
