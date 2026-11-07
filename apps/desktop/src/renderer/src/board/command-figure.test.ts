import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Agent } from '@agent-board/daemon/protocol';
import { CommandFigure, TileRobot } from './CommandFigure';
import { HybridTile } from './HybridTile';
import { galleryAgent } from './TileGallery';

const onCommand: Agent = galleryAgent('on-command');
const running: Agent = galleryAgent('running');

describe("the on-command robot an expanded and a compact tile share", () => {
  it('stands for an agent on a command, and for no other state', () => {
    expect(renderToStaticMarkup(createElement(CommandFigure, { agent: onCommand }))).toContain('data-pose="on-command"');
    expect(renderToStaticMarkup(createElement(CommandFigure, { agent: running }))).toBe('');
  });

  it('leaves the tile to its own character while a style is picked, so a tile never draws two', () => {
    const html = renderToStaticMarkup(createElement(HybridTile, { id: 't1', tile: { label: onCommand.name, harness: onCommand.harness, agent: onCommand } } as never));
    expect(html).toMatch(/data-testid="tile-character" data-pose="on-command"/);
    expect(renderToStaticMarkup(createElement(TileRobot, { agent: onCommand, sending: false }))).toBe('');
    expect(renderToStaticMarkup(createElement(TileRobot, { agent: running, sending: true }))).toBe('');
    expect(html).not.toContain('hybrid-tile-handoff');
  });
});
