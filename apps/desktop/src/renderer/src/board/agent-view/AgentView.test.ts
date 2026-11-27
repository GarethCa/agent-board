import { createElement, createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ToastProvider } from '../../ui';
import { galleryAgent } from '../TileGallery';
import { AgentView, type PopUpBoard } from './AgentView';
import { NowAction } from './NowAction';

const board: PopUpBoard = { agents: [], desk: { gap: 16, size: 1 }, onError: () => () => {} };

// Drawn in a tile whose body stands in, as a capture window's does: the header and the row are what is checked here.
const draw = (helpers: readonly ReturnType<typeof galleryAgent>[] | undefined, given: { board?: PopUpBoard; popped?: readonly string[] } = {}) =>
  renderToStaticMarkup(
    createElement(
      ToastProvider,
      null,
      createElement(AgentView, {
        agent: { ...galleryAgent('waiting'), name: 'The chat' },
        helpers,
        ...given,
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
            lead: undefined,
          },
        },
      }),
    ),
  );

describe("an open agent's view", () => {
  it('draws one agent alone with its mark, name and status, and no row of tabs', () => {
    const html = draw(undefined);
    expect(html).toContain('session-window-mark');
    expect(html).toContain('data-testid="tile-status"');
    expect(html).not.toContain('class="agent-popup-title"');
    expect(html).not.toContain('role="tabpanel"');
  });

  it("draws a ticket with its title in place of the agent's mark and name, and always its row", () => {
    const html = draw([]);
    expect(html).toContain('class="agent-popup-title"');
    expect(html).not.toContain('session-window-mark');
    expect(html).not.toContain('data-testid="tile-status"');
    expect(html).toContain('role="tabpanel"');
  });

  it('keeps the same header, buttons and body for either', () => {
    for (const html of [draw(undefined), draw([])]) {
      expect(html).toMatch(/<header class="session-window-head agent-popup-head expanded-tile-head"/);
      expect(html).toContain('aria-label="More"');
      expect(html).toContain('>Collapse<');
      expect(html).toMatch(/class="agent-popup-body expanded-tile-body nodrag"[^>]*>.*data-testid="terminal-hidden"/s);
    }
  });

  it("gives one agent alone none of a ticket's: no Board view, so no + in its header, whatever its caller passes", () => {
    const alone = draw(undefined);
    expect(alone).not.toContain('data-testid="agent-popup-plus"');
    expect(draw(undefined, { board, popped: ['agent-2'] })).toBe(alone);
  });

  it("gives a ticket its Board, a tab in its row", () => {
    expect(draw([])).not.toContain('>Board<');
    expect(draw([], { board })).toContain('>Board<');
  });
});

describe("the header's buttons for what the agent is doing now", () => {
  const now = (onMerge?: () => void) =>
    renderToStaticMarkup(createElement(ToastProvider, null, createElement(NowAction, { agent: galleryAgent('running'), placement: 'board', onMerge })));

  it("puts a ticket's Merge after Stop, only when it can merge", () => {
    expect(now()).not.toContain('data-testid="agent-popup-merge"');
    const html = now(() => {});
    expect(html).toMatch(/>Stop<.*data-testid="agent-popup-merge"[^>]*>.*Merge</s);
  });
});
