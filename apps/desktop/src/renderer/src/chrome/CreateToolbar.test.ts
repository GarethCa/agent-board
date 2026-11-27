import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
// The recent shapes are read from storage on the client only.
vi.mock('../board/items/shapes/recents', () => ({ useRecentShapes: () => ['rectangle'], noteShapeUsed: () => undefined }));

import type { LibraryPrefab } from '@agent-board/daemon/protocol';
import type { Submenu } from '../ui';
import { CreateToolbar, type CreateToolbarProps } from './CreateToolbar';
import { crewMenu } from '../board/menu-model';

const noop = () => undefined;
const props: CreateToolbarProps = {
  mode: 'select',
  onMode: noop,
  tool: undefined,
  onTool: noop,
  onSticky: noop,
  onSteps: noop,
  onQueue: noop,
  onTodo: noop,
  ghostSize: { width: 256, height: 120 },
  onDropTool: noop,
};

/** Classic's toolbar as first drawn, before the board's folds are read. */
const toolbar = (): string => renderToStaticMarkup(createElement(CreateToolbar, props));

describe('Classic’s creation toolbar at narrow widths', () => {
  it('draws its drawing tools, and the Draw menu they fold into, so the stylesheet can show either at once', () => {
    const html = toolbar();
    const drawing = /<span class="create-toolbar-drawing">(.*?)<\/span><span class="create-toolbar-drawing-folded">/.exec(html)?.[1] ?? '';
    for (const label of ['Sticky note', 'Text', 'Shape', 'Zone', 'More to add']) expect(drawing).toContain(`aria-label="${label}"`);
    const folded = /<span class="create-toolbar-drawing-folded">(.*)/.exec(html)?.[1] ?? '';
    expect(folded).toMatch(/<button[^>]*>.*Draw/);
  });

  it('points the tour at the Zone tool while the row is unfolded, not at the hidden Draw menu', () => {
    const html = toolbar();
    expect(html.match(/data-tour="add-zone"/g)).toHaveLength(1);
    expect(/<button[^>]*aria-label="Zone"[^>]*data-tour="add-zone"|<button[^>]*data-tour="add-zone"[^>]*aria-label="Zone"/.test(html)).toBe(true);
  });
});

describe('New crew, in Simplified’s ▾ beside New agent', () => {
  it('lists your prefabs, then the built-ins, each under its heading, then the library', () => {
    const picked: (string | null)[] = [];
    const prefabs = [
      { name: 'Ticket', builtIn: true, members: [] },
      { name: 'Reviewer', builtIn: false, members: [] },
    ] as unknown as LibraryPrefab[];
    const menu = crewMenu(prefabs, (prefab) => picked.push(prefab)) as Submenu;
    expect(menu.label).toBe('New crew');
    expect(menu.entries.map((entry) => (entry === 'separator' ? '—' : 'heading' in entry ? `# ${entry.heading}` : entry.label))).toEqual(['# Your prefabs', 'Reviewer', '—', '# Built in', 'Ticket', '—', 'Library…']);
    for (const entry of menu.entries) if (typeof entry === 'object' && 'onSelect' in entry) entry.onSelect();
    expect(picked).toEqual(['Reviewer', 'Ticket', null]);
  });
});
