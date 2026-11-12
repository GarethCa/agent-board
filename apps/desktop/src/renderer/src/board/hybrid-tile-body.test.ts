import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import type { Agent } from '@agent-board/daemon/protocol';
import { HybridTile } from './HybridTile';
import { lastMessageCard } from './tile-parts';
import { galleryAgent } from './TileGallery';
import { QUIET_TILE } from './tile-shows';
import { restoreViewSettings } from './view-settings';

const AT = '2026-10-22T12:00:00.000Z';

/** The agent's tile as the board draws it. */
function render(agent: Agent): string {
  return renderToStaticMarkup(createElement(HybridTile, { id: 't1', tile: { label: agent.name, harness: agent.harness, agent } } as never));
}

const idle: Agent = { ...galleryAgent('waiting'), lastMessage: '…and that is why the retry never fired.', description: 'Fix the checkout flake' };

describe("an agent tile's body", () => {
  it('stands its character beside what it says, and aside for a row with a button of its own, which needs the width', () => {
    expect(render(idle)).toContain('data-testid="tile-character"');
    const untyped = render({ ...idle, untypedPrompt: 'Pick a database' });
    expect(untyped).toContain('tile-untyped');
    expect(untyped).not.toContain('data-testid="tile-character"');
  });

  it("says the board can't follow a session that sent no hooks, with Open and Restart, over its flag, once its task is typed", () => {
    const silent = render({ ...idle, hooksSilent: true, flag: { id: 1, reason: 'Pick a cache', at: AT, to: 'user', via: null } });
    expect(silent).toContain('data-testid="tile-hooks-silent"');
    expect(silent).toContain('No hooks from this session:</strong> the board can&#x27;t follow its turns');
    expect(silent).toContain('data-testid="hooks-silent-open"');
    expect(silent).toContain('data-testid="hooks-silent-restart"');
    // Unpressed, it says what it does; a first press only asks "Restart?" (two-step.test.ts).
    expect(silent).toMatch(/data-testid="hooks-silent-restart"[^>]*>(?:<[^>]+>)*[^<]*Stop and restart</);
    expect(silent).not.toContain('Restart?');
    expect(silent).not.toContain('data-testid="tile-flag"');
    // Its untyped task comes first: a task never typed is what to act on, and hooks off is often why it was never typed.
    const untyped = render({ ...idle, hooksSilent: true, untypedPrompt: 'Pick a database' });
    expect(untyped).toContain('data-testid="tile-untyped"');
    expect(untyped).not.toContain('tile-hooks-silent');
    expect(render(idle)).not.toContain('tile-hooks-silent');
  });

  it("offers no Stop and restart on a session that can't restart in place: a reviewer, or one run in its shell", () => {
    const reviewer = render({ ...idle, hooksSilent: true, reviewOf: 'impl-1' });
    expect(reviewer).toContain('data-testid="tile-hooks-silent"');
    expect(reviewer).toContain('data-testid="hooks-silent-open"');
    expect(reviewer).not.toContain('hooks-silent-restart');
    const inShell = render({ ...idle, hooksSilent: true, shellHarness: 'claude' });
    expect(inShell).not.toContain('hooks-silent-restart');
  });

  it('says what the agent is for, not its last message, when it waits', () => {
    const html = render(idle);
    expect(html).toContain('Fix the checkout flake');
    expect(html).not.toContain('tile-ask');
    expect(html).not.toContain('the retry never fired');
  });

  it('says its status line over its task', () => {
    const html = render({ ...idle, status: { summary: 'Retry fix in', progress: null, updatedAt: AT, setBy: null } });
    expect(html).toContain('>Retry fix in<');
    expect(html).not.toContain('tile-set-by');
  });

  it('marks a line its orchestrator set, and leaves who to its hover card', () => {
    const html = render({ ...idle, status: { summary: 'Retry fix in', progress: null, updatedAt: AT, setBy: 'web-app orchestrator' } });
    expect(html).toContain('Retry fix in');
    expect(html).toContain('data-testid="tile-set-by-mark"');
    expect(html).not.toContain('data-testid="tile-set-by"');
  });

  it('gives its task as a native tooltip only when it has no hover card, so one tooltip shows at a time', () => {
    const description = (html: string) => /<span[^>]*data-testid="tile-description"[^>]*>/.exec(html)![0];
    // Its branch repeats its issue, so it goes to the hover card, which then leads with the task.
    const quiet = render({ ...idle, lastMessage: null });
    expect(description(quiet)).not.toContain('title=');
    // Nothing for a hover card: the task is the body's tooltip.
    const plain = render({ ...idle, lastMessage: null, branch: '', issue: null });
    expect(description(plain)).toContain('title="Fix the checkout flake"');
  });

  it('still shows a permission prompt, a question and a plan in place of the line', () => {
    const status = { summary: 'Retry fix in', progress: null, updatedAt: AT, setBy: 'web-app orchestrator' };
    const prompt = render({
      ...idle,
      status,
      state: 'needs-permission',
      permissions: [{ id: 'p', toolName: 'Bash', toolInput: { command: 'rm -rf dist' }, subagent: null, requestedAt: AT, heldUntil: null, asksInTerminal: false, sessionGrant: null, questions: null }],
    });
    expect(prompt).toContain('tile-ask');
    expect(prompt).toContain('rm -rf dist');
    expect(prompt).not.toContain('tile-set-by');

    const question = render({ ...idle, status, ask: { question: 'Postgres or SQLite?', options: ['Postgres', 'SQLite'], questions: [{ question: 'Postgres or SQLite?', options: ['Postgres', 'SQLite'] }], answers: [null], card: null } as unknown as Agent['ask'] });
    expect(question).toContain('Postgres or SQLite?');
    expect(question).toContain('tile-ask');
  });

  it('points at a question on its steps card rather than repeating it', () => {
    const html = render({ ...idle, ask: { question: 'Postgres or SQLite?', options: ['Postgres', 'SQLite'], questions: [], answers: [], card: 'card-1' } as unknown as Agent['ask'] });
    expect(html).toContain('tile-ask');
    expect(html).toContain('>Asking you on a steps card<');
    expect(html).not.toContain('>Postgres or SQLite?');
  });

  it('still shows a pending plan in place of the line', () => {
    const html = render({ ...idle, plan: { title: 'Move the dock', decision: null } as unknown as Agent['plan'] });
    expect(html).toContain('tile-ask');
    expect(html).toContain('Waiting for you to decide on its plan: Move the dock');
  });
});

describe('the parts Settings turns back on', () => {
  afterEach(() => restoreViewSettings({ tileShows: QUIET_TILE }));
  const orchestrated: Agent = { ...idle, trustedByZone: true, status: { summary: 'Retry fix in', progress: null, updatedAt: AT, setBy: 'web-app orchestrator' } };

  it('keeps the quiet tile until one is turned on', () => {
    const html = render(orchestrated);
    expect(html).not.toContain('hybrid-tile-branch');
    expect(html).toContain('data-corner="hover"');
    expect(html).not.toContain('data-testid="tile-set-by"');
    expect(html).not.toContain('data-testid="tile-trusted-by-zone"');
  });

  it('draws each part turned on, on the tile itself', () => {
    restoreViewSettings({ tileShows: { branchAlways: true, cornerAlways: true, setBy: true, trusted: true } });
    const html = render(orchestrated);
    expect(html).toContain('hybrid-tile-branch');
    expect(html).not.toContain('data-corner="hover"');
    expect(html).toContain('data-testid="tile-set-by"');
    expect(html).toContain('data-testid="tile-trusted-by-zone"');
  });
});

describe('the card of its last message', () => {
  it('has the message, with the time its turn ended, while the body says what it does', () => {
    expect(lastMessageCard({ ...idle, finishedAt: AT })).toEqual({ text: idle.lastMessage, label: expect.stringMatching(/^Last message · \d/) });
    expect(lastMessageCard({ ...idle, finishedAt: null })).toEqual({ text: idle.lastMessage, label: 'Last message' });
  });

  it('is withheld while an ask or a notice takes the body, and with no message', () => {
    expect(lastMessageCard({ ...idle, ask: { question: 'Postgres?', options: [] } as unknown as Agent['ask'] })).toBeUndefined();
    expect(lastMessageCard({ ...idle, notice: 'Its process crashed.' })).toBeUndefined();
    expect(lastMessageCard({ ...idle, lastMessage: null })).toBeUndefined();
  });
});
