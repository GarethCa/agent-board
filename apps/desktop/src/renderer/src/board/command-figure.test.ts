import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Agent } from '@agent-board/daemon/protocol';
import { CommandFigure } from './CommandFigure';
import { HybridTile } from './HybridTile';
import { galleryAgent } from './TileGallery';

const onCommand: Agent = galleryAgent('on-command');
const running: Agent = galleryAgent('running');

describe("the on-command robot an expanded and a compact tile share", () => {
  it('stands for an agent on a command, and for no other state', () => {
    expect(renderToStaticMarkup(createElement(CommandFigure, { agent: onCommand }))).toContain('data-pose="on-command"');
    expect(renderToStaticMarkup(createElement(CommandFigure, { agent: running }))).toBe('');
  });

  it("perches on the compact tile through the same component", () => {
    const html = renderToStaticMarkup(createElement(HybridTile, { id: 't1', tile: { label: onCommand.name, harness: onCommand.harness, agent: onCommand } } as never));
    expect(html).toContain('data-pose="on-command"');
  });
});
