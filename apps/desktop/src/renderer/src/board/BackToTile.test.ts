import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '../ui';

const left: { surface: unknown; leave: () => void; select?: (nodeId: string) => void }[] = [];
vi.mock('../keys/escape-hatch', () => ({ leaveToTile: (surface: unknown, leave: () => void, select?: (nodeId: string) => void) => left.push({ surface, leave, select }) }));
const selectNode = vi.fn();
vi.mock('./commands', () => ({ useBoardCommands: () => ({ selectNode }) }));

const { BackToTileButton } = await import('./BackToTile');

const surface = { id: 'expanded' } as unknown as HTMLElement;
const props = (leave = () => {}) => ({ from: { current: surface }, leave, label: 'Collapse' });
const render = (label = 'Collapse') => renderToStaticMarkup(createElement(TooltipProvider, null, createElement(BackToTileButton, { ...props(), label })));

describe('BackToTileButton', () => {
  it('is a – under the name its view gives it', () => {
    const html = render('Close session window');
    expect(html).toContain('lucide-minus');
    expect(html).toContain('aria-label="Close session window"');
    expect(html).toContain('data-testid="back-to-tile"');
  });

  it('leaves through the one back-to-tile path, from its view, so the focus lands on the tile and the board selects it', () => {
    left.length = 0;
    const leave = vi.fn();
    const button = BackToTileButton(props(leave)) as ReactElement<{ onClick: () => void }>;
    button.props.onClick();
    expect(left).toHaveLength(1);
    expect(left[0]!.surface).toBe(surface);
    left[0]!.leave();
    expect(leave).toHaveBeenCalledOnce();
    left[0]!.select?.('tile:agent:a');
    expect(selectNode).toHaveBeenCalledWith('tile:agent:a');
  });
});
