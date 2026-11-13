import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TooltipProvider } from '../ui';
import { ChatControls, type ChatControlsProps } from './ChatControls';

const render = (props: Partial<ChatControlsProps> = {}) =>
  renderToStaticMarkup(createElement(TooltipProvider, null, createElement(ChatControls, { sessionId: 'a', styleSwitch: true, runsShow: 'always', onRuns: () => {}, ...props })));

describe('ChatControls', () => {
  it('holds the chat style switch, then Expand all and Collapse all, under their names', () => {
    const html = render();
    expect(html).toContain('class="chat-controls"');
    expect(html).toContain('aria-label="Chat style"');
    expect(html).toContain('aria-label="Expand all"');
    expect(html).toContain('aria-label="Collapse all"');
    expect(html.indexOf('Chat style')).toBeLessThan(html.indexOf('Expand all'));
  });

  it('keeps the labels it folds to icons when short of room', () => {
    const html = render();
    expect(html).toContain('<span class="chat-runs-label">Expand all</span>');
    expect(html).toContain('<span class="chat-runs-label">Collapse all</span>');
  });

  it('leaves the style switch out where the header has the view switch (Simplified)', () => {
    const html = render({ styleSwitch: false });
    expect(html).not.toContain('aria-label="Chat style"');
    expect(html).toContain('aria-label="Expand all"');
  });

  it('marks Expand all and Collapse all to always show, or to wait for hover, as the setting says', () => {
    expect(render()).toContain('<span class="chat-runs-actions" data-shows="always">');
    expect(render({ runsShow: 'hover' })).toContain('<span class="chat-runs-actions" data-shows="hover">');
  });
});
