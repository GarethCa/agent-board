import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import postcss from 'postcss';
import { describe, expect, it } from 'vitest';
import { cameraViewport, demoEasing, demoFrom } from './demo-mode';

describe('demo mode', () => {
  it('is on only when the main process opened the window with ?demo=1', () => {
    expect(demoFrom('?demo=1')).toBe(true);
    expect(demoFrom('?appearance=dark&demo=1')).toBe(true);
    expect(demoFrom('')).toBe(false);
    expect(demoFrom('?demo=0')).toBe(false);
    expect(demoFrom('?demo=')).toBe(false);
    expect(demoFrom('?placeholders=1')).toBe(false);
  });
});

describe("the demo camera's easings", () => {
  it('start at the start and end at the end', () => {
    for (const name of ['linear', 'ease-in', 'ease-out', 'ease-in-out'] as const) {
      expect(demoEasing(name)(0)).toBe(0);
      expect(demoEasing(name)(1)).toBe(1);
    }
  });

  it('ease in and out by default: slow at both ends, halfway at the middle', () => {
    const ease = demoEasing();
    expect(ease(0.5)).toBeCloseTo(0.5);
    expect(ease(0.1)).toBeLessThan(0.1);
    expect(ease(0.9)).toBeGreaterThan(0.9);
  });

  it('ease in slow and out fast, or the other way, or not at all', () => {
    expect(demoEasing('ease-in')(0.5)).toBeLessThan(0.5);
    expect(demoEasing('ease-out')(0.5)).toBeGreaterThan(0.5);
    expect(demoEasing('linear')(0.3)).toBe(0.3);
  });

  it('name the easings there are when given another', () => {
    expect(() => demoEasing('bounce' as never)).toThrow('linear, ease-in, ease-out, ease-in-out');
  });
});

describe("the demo camera's view of a part of the board", () => {
  const view = { width: 1000, height: 800, minZoom: 0.1, maxZoom: 2 };

  it('zooms in on a small part, as far as the board zooms', () => {
    expect(cameraViewport({ x: 0, y: 0, width: 100, height: 100 }, view)).toEqual({ x: 400, y: 300, zoom: 2 });
  });

  it('zooms out to fit a wide part, centred, with a margin round it', () => {
    // 65 px of margin each side of 1000 leaves 870 for the part's 2000.
    const viewport = cameraViewport({ x: 0, y: 0, width: 2000, height: 800 }, view);
    expect(viewport.zoom).toBeCloseTo(0.435);
    expect(viewport.x).toBeCloseTo(65);
    expect(viewport.y).toBeCloseTo(226);
  });
});

describe("demo mode's hidden chrome", () => {
  const renderer = join(import.meta.dirname, '..');
  /** The classes demo.css hides: the `display: none` rule's. */
  const hidden: string[] = [];
  postcss.parse(readFileSync(join(import.meta.dirname, 'demo.css'), 'utf8')).walkRules((rule) => {
    if (rule.some((node) => node.type === 'decl' && node.prop === 'display' && node.value === 'none')) {
      hidden.push(...[...rule.selector.matchAll(/\.([\w-]+)/g)].map((match) => match[1]!));
    }
  });
  /** Every class name the renderer's components write. */
  const rendered = new Set(
    readdirSync(renderer, { recursive: true, encoding: 'utf8' })
      .filter((file) => file.endsWith('.tsx'))
      .flatMap((file) => [...readFileSync(join(renderer, file), 'utf8').matchAll(/className="([^"]+)"/g)].flatMap((match) => match[1]!.split(/\s+/))),
  );

  it('hides the build mismatch, the daemon status, the restart banner and a held permission countdown', () => {
    expect(hidden.sort()).toEqual(['build-mismatch', 'daemon-status', 'inbox-prompt-countdown', 'restart-banner']);
  });

  it('hides classes the renderer still draws, so a renamed one fails here rather than showing in a recording', () => {
    expect(hidden.filter((name) => !rendered.has(name))).toEqual([]);
  });
});
