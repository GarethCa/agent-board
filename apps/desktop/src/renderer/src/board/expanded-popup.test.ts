import { createElement, createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ToastProvider } from '../ui';
import { AgentView, type AgentViewTile } from './agent-view/AgentView';
import { galleryAgent } from './TileGallery';

// The pop-up's own session, drawn as an agent's expanded tile; its body stands in, as a capture window's does.
const draw = (tile?: Partial<AgentViewTile>) =>
  renderToStaticMarkup(
    createElement(ToastProvider, null, createElement(AgentView, {
      agent: galleryAgent('waiting'),
      nodeId: 'agent:a1',
      onClose: () => {},
      root: createRef<HTMLElement>(),
      splitting: { split: undefined, onSplit: () => {}, agents: [] },
      frame: {
        buttons: createElement('button', { type: 'button' }, 'Collapse'),
        menuEnd: [],
        drops: [],
        notice: undefined,
        onAttachState: () => {},
        tile: {
          nodeId: 'agent:a1',
          headClassName: 'expanded-tile-head',
          bodyClassName: 'expanded-tile-body nodrag',
          headTabIndex: undefined,
          onHeadDoubleClick: () => {},
          status: createElement('span', { 'data-testid': 'tile-status' }),
          narrow: () => false,
          standIn: createElement('div', { 'data-testid': 'terminal-hidden' }),
          lead: createElement('button', { type: 'button' }, 'Pop out'),
          ...tile,
        },
      },
    })),
  );

describe("an agent's expanded tile, drawn as its pop-up", () => {
  it("has the pop-up's header, its Chat | Terminal switch and ⋯, which drags the tile and no window", () => {
    const html = draw();
    expect(html).toMatch(/<header class="session-window-head agent-popup-head expanded-tile-head"/);
    expect(html).not.toContain('data-drag-region');
    expect(html).toContain('aria-label="View of every agent in this pop-up"');
    expect(html).toContain('aria-label="More"');
    expect(html).toContain('data-testid="tile-status"');
  });

  it("holds the tile's own buttons in place of the pop-up's Expand, Pop out and back to its tile", () => {
    const html = draw();
    expect(html).toContain('>Collapse<');
    expect(html).not.toContain('aria-label="Expand"');
    expect(html).not.toContain('aria-label="Back to its tile"');
  });

  it("keeps ⋯ just before its closing button, after its window buttons, as the pop-up does", () => {
    const html = draw();
    const at = (text: string) => html.indexOf(text);
    expect(at('>Pop out<')).toBeGreaterThan(-1);
    expect(at('>Pop out<')).toBeLessThan(at('aria-label="More"'));
    expect(at('aria-label="More"')).toBeLessThan(at('>Collapse<'));
  });

  it("has no tab row while it is one agent alone, and no split", () => {
    const html = draw();
    expect(html).not.toContain('data-testid="agent-popup-tabs"');
    expect(html).not.toContain('data-testid="agent-popup-split"');
  });

  it("puts its body in the tile's, which the board neither drags nor pans", () => {
    const html = draw();
    expect(html).toMatch(/class="agent-popup-body expanded-tile-body nodrag"[^>]*>.*data-testid="terminal-hidden"/s);
  });
});
