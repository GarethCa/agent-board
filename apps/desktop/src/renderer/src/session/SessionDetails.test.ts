import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Agent } from '@agent-board/daemon/protocol';
import { TooltipProvider } from '../ui';
import { SessionDetails, type SessionDetailsProps } from './SessionDetails';

const agent = {
  state: 'running',
  endedAt: null,
  issue: null,
  lastMessage: null,
  branch: 'agent/x',
  worktree: '/tmp/wt',
  pullRequests: [],
  subagents: [],
  schedule: null,
} as unknown as Agent;

const render = (collapsed: boolean) => {
  const props: SessionDetailsProps = { sessionId: 'a', agent, live: true, collapsed, onCollapsed: () => {}, onFocusPane: () => {}, onProblem: () => {}, onOpenLink: () => {} };
  return renderToStaticMarkup(createElement(TooltipProvider, null, createElement(SessionDetails, props)));
};

/** The lucide icon names drawn in the markup (`lucide-<name>` classes), minus the collapse and expand toggles and the headings' chevrons. */
const iconsIn = (html: string) =>
  new Set([...html.matchAll(/lucide-([a-z0-9-]+)/g)].map(([, name]) => name!).filter((name) => !/^(sidebar|panel-left|chevron)/.test(name)));

describe('the details strip', () => {
  it('draws the rail’s section icons before its headings, aria-hidden', () => {
    const rail = iconsIn(render(true));
    const strip = iconsIn(render(false));
    for (const icon of ['circle-dot', 'folder-git-2', 'git-pull-request', 'bot', 'cable', 'calendar-clock']) expect(rail).toContain(icon);
    // The strip also lists the controls the rail hides while they can't act.
    for (const icon of rail) expect(strip).toContain(icon);
    expect(render(false)).not.toMatch(/<svg(?![^>]*aria-hidden="true")/);
  });
});
