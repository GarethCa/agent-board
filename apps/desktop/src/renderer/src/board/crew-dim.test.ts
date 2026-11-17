// While an orchestrator's crew is focused (its tile hovered or selected), the board dims every agent tile outside the
// crew. A tile in the crew carries `data-crew-lit`, which keeps it at full opacity: a ticket's tile as much as any other.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import type { Agent, AgentState, Zone } from '@agent-board/daemon/protocol';
import { focusedCrews, hoverCrew, leaveCrew, selectCrews, typeInTile } from './crew-view';
import { selectedOrchestrators } from './crews';
import { HybridTile } from './HybridTile';
import { galleryAgent } from './TileGallery';
import type { TileData, TileNodeType } from './tile';
import { withTiles, type BoardNode } from './tiles';
import { zoneNode } from './ZoneNode';

const css = readFileSync(join(import.meta.dirname, '..', 'app.css'), 'utf8');

const LEAD = { sessionId: 'lead', name: 'Release lead' };

const ticketChat = (state: AgentState): Agent => ({
  ...galleryAgent(state),
  sessionId: `ticket-${state}`,
  name: 'ACME-12',
  ticketChat: true,
  issue: { provider: 'linear', id: 'ACME-12', title: 'Fix the checkout flake', url: '' },
  subagents: [],
  pullRequests: [],
});

const plain = (state: AgentState): Agent => ({ ...galleryAgent(state), sessionId: `mine-${state}`, subagents: [], pullRequests: [] });

/** The tile's root as the board draws it, started by `from` or by hand. */
function root(agent: Agent, from?: TileData['from'], crew?: number): string {
  // The board gives a ticket's chat its helpers, even none: that is what draws it as a ticket's tile.
  const helpers = agent.ticketChat ? { helpers: [] } : {};
  const tile = { label: agent.name, harness: agent.harness, agent, from, ...helpers, ...(crew === undefined ? {} : { crew }) };
  const html = renderToStaticMarkup(createElement(HybridTile, { id: `agent:${agent.sessionId}`, tile } as never));
  return /<div[^>]*data-testid="agent-tile"[^>]*>/.exec(html)?.[0] ?? '';
}

/** Whether the crew-focus rule dims it: an agent tile without `data-crew-lit`. */
const dimmed = (tile: string) => /class="[^"]*\bhybrid-tile-agent\b/.test(tile) && !tile.includes('data-crew-lit');

afterEach(() => {
  typeInTile(undefined);
  leaveCrew(LEAD.sessionId);
  selectCrews([]);
});

/** A ticket's chat that has started a builder, and the lead with an agent of its own, laid out by the board. */
function board(): BoardNode[] {
  const zone = zoneNode({ id: 'z', x: 0, y: 0, width: 800, height: 300, repoRoot: null, folder: '', name: 'z', color: '#4c6ef5', spacing: 'normal' } as Zone);
  const inZone = (agent: Agent, fields: Partial<Agent> = {}): Agent => ({ ...agent, zoneId: 'z', position: null, ...fields });
  const chat = inZone(ticketChat('running'), { sessionId: 'chat', ticket: null });
  const builder = inZone(plain('running'), { sessionId: 'builder', ticket: 'chat', spawnedBy: 'chat' });
  const lead = inZone(plain('idle'), { sessionId: LEAD.sessionId });
  const worker = inZone(plain('running'), { sessionId: 'worker', spawnedBy: LEAD.sessionId });
  return withTiles([zone], [chat, builder, lead, worker], [], []);
}

const select = (nodes: BoardNode[], id: string) => nodes.map((node) => (node.id === id ? { ...node, selected: true } : node));
const tileOf = (nodes: BoardNode[], id: string) => nodes.find((node): node is TileNodeType => node.id === id)!;

describe('the crew-focus dim', () => {
  it('dims an agent tile without data-crew-lit while a crew is focused', () => {
    expect(css).toMatch(/:root\[data-crew-focus\] \.react-flow__node \.hybrid-tile-agent:not\(\[data-crew-lit\]\) \{\s*opacity: 0\.4;/);
  });

  const LIVE: AgentState[] = ['running', 'waiting', 'idle'];

  it.each(LIVE)("leaves a %s ticket tile its orchestrator started at full opacity while that orchestrator's crew is focused", (state) => {
    hoverCrew(LEAD.sessionId);
    const tile = root(ticketChat(state), LEAD);
    expect(tile).toContain('data-ticket-tile');
    expect(tile).toContain('data-crew="lead"');
    expect(dimmed(tile)).toBe(false);
  });

  it.each(LIVE)('leaves a %s agent tile (not a ticket\'s) its orchestrator started at full opacity, as a ticket tile is', (state) => {
    hoverCrew(LEAD.sessionId);
    const tile = root(plain(state), LEAD);
    expect(tile).not.toContain('data-ticket-tile');
    expect(dimmed(tile)).toBe(false);
  });

  it('dims a ticket tile outside the focused crew, as it does any other tile', () => {
    hoverCrew(LEAD.sessionId);
    expect(dimmed(root(ticketChat('running')))).toBe(true);
    expect(dimmed(root(plain('running')))).toBe(true);
  });

  it('leaves no crew focused once the pointer leaves its orchestrator, so the board dims nothing', () => {
    hoverCrew(LEAD.sessionId);
    leaveCrew(LEAD.sessionId);
    expect(focusedCrews().size).toBe(0);
  });

  it("keeps a selected orchestrator's crew focused, and its ticket tile lit, until it is unselected", () => {
    const nodes = select(board(), `agent:${LEAD.sessionId}`);
    selectCrews(selectedOrchestrators(nodes));
    expect([...focusedCrews()]).toEqual([LEAD.sessionId]);
    expect(dimmed(root(ticketChat('idle'), LEAD))).toBe(false);
    selectCrews(selectedOrchestrators(board()));
    expect(focusedCrews().size).toBe(0);
  });

  it("lets go of a selected orchestrator's crew while the user types in its tile, so nothing dims, and focuses it again after", () => {
    selectCrews(selectedOrchestrators(select(board(), `agent:${LEAD.sessionId}`)));
    hoverCrew(LEAD.sessionId);
    typeInTile(LEAD.sessionId);
    expect(focusedCrews().size).toBe(0);
    expect(root(plain('running'), LEAD)).not.toContain('data-crew-lit');
    typeInTile(undefined);
    expect([...focusedCrews()]).toEqual([LEAD.sessionId]);
    expect(dimmed(root(plain('running'), LEAD))).toBe(false);
  });

  it("leaves a selected ticket chat that has a helper lit: it leads its helpers' crew, and is in it", () => {
    const nodes = select(board(), 'agent:chat');
    const { data } = tileOf(nodes, 'agent:chat');
    expect(data.crew).toBe(1);
    expect(data.helpers).toHaveLength(1);
    selectCrews(selectedOrchestrators(nodes));
    expect([...focusedCrews()]).toEqual(['chat']);
    const tile = root(data.agent!, undefined, data.crew);
    expect(tile).toContain('data-crew="chat"');
    expect(dimmed(tile)).toBe(false);
  });
});
