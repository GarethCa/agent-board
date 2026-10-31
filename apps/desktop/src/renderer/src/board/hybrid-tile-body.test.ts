import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Agent } from '@agent-board/daemon/protocol';
import { HybridTile } from './HybridTile';
import { lastMessageCard } from './tile-parts';
import { galleryAgent } from './TileGallery';

const AT = '2026-10-22T12:00:00.000Z';

/** The agent's tile as the board draws it. */
function render(agent: Agent): string {
  return renderToStaticMarkup(createElement(HybridTile, { id: 't1', tile: { label: agent.name, harness: agent.harness, agent } } as never));
}

const idle: Agent = { ...galleryAgent('waiting'), lastMessage: '…and that is why the retry never fired.', description: 'Fix the checkout flake' };

describe("an agent tile's body", () => {
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

  it('says who set the line when its orchestrator did', () => {
    const html = render({ ...idle, status: { summary: 'Retry fix in', progress: null, updatedAt: AT, setBy: 'web-app orchestrator' } });
    expect(html).toContain('>Retry fix in<');
    expect(html).toMatch(/data-testid="tile-set-by"[^>]*>set by ◎ web-app orchestrator</);
  });

  it('still shows a permission prompt, a question and a plan in place of the line', () => {
    const status = { summary: 'Retry fix in', progress: null, updatedAt: AT, setBy: 'web-app orchestrator' };
    const prompt = render({
      ...idle,
      status,
      state: 'needs-permission',
      permissions: [{ id: 'p', toolName: 'Bash', toolInput: { command: 'rm -rf dist' }, subagent: null, requestedAt: AT, heldUntil: null }],
    });
    expect(prompt).toContain('tile-ask');
    expect(prompt).toContain('rm -rf dist');
    expect(prompt).not.toContain('tile-set-by');

    const question = render({ ...idle, status, ask: { question: 'Postgres or SQLite?', options: ['Postgres', 'SQLite'] } as unknown as Agent['ask'] });
    expect(question).toContain('Postgres or SQLite?');
    expect(question).toContain('tile-ask');
  });

  it('points at a question on its card rather than repeating it', () => {
    const html = render({ ...idle, ask: { question: 'Postgres or SQLite?', options: ['Postgres', 'SQLite'], onBoard: true } as unknown as Agent['ask'] });
    expect(html).toContain('tile-ask');
    expect(html).toContain('>Asking you ↗<');
    expect(html).not.toContain('>Postgres or SQLite?');
  });

  it('still shows a pending plan in place of the line', () => {
    const html = render({ ...idle, plan: { title: 'Move the dock', decision: null } as unknown as Agent['plan'] });
    expect(html).toContain('tile-ask');
    expect(html).toContain('Waiting for you to decide on its plan: Move the dock');
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
