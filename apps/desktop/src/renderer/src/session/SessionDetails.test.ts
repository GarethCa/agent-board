import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ExternalSession } from '@agent-board/daemon/protocol';
import { ToastProvider, TooltipProvider } from '../ui';
import { SessionDetails, type SessionDetailsProps } from './SessionDetails';

const external = {
  id: 'claude:a',
  harness: 'claude',
  sessionId: 'a',
  name: 'outside',
  cwd: '/tmp/wt',
  worktree: '/tmp/wt',
  branch: 'feature/x',
  description: null,
  status: null,
  subagents: [],
} as unknown as ExternalSession;

const render = (collapsed: boolean) => {
  const props: SessionDetailsProps = { sessionId: undefined, external, live: false, collapsed, onCollapsed: () => {}, onProblem: () => {} };
  return renderToStaticMarkup(createElement(ToastProvider, null, createElement(TooltipProvider, null, createElement(SessionDetails, props))));
};

/** The lucide icon names drawn in the markup (`lucide-<name>` classes), minus the collapse and expand toggles and the headings' chevrons. */
const iconsIn = (html: string) =>
  new Set([...html.matchAll(/lucide-([a-z0-9-]+)/g)].map(([, name]) => name!).filter((name) => !/^(sidebar|panel-left|chevron)/.test(name)));

describe('the details strip', () => {
  it('draws the rail’s section icons before its headings, aria-hidden', () => {
    const rail = iconsIn(render(true));
    const strip = iconsIn(render(false));
    for (const icon of ['file-text', 'folder-git-2', 'bot']) expect(rail).toContain(icon);
    for (const icon of rail) expect(strip).toContain(icon);
    expect(render(false)).not.toMatch(/<svg(?![^>]*aria-hidden="true")/);
  });

  it('shows no agent’s sections: an agent’s window has its shelves', () => {
    const strip = render(false);
    for (const icon of ['circle-dot', 'git-pull-request', 'users-round', 'pin', 'calendar-clock']) expect(iconsIn(strip)).not.toContain(icon);
  });
});
