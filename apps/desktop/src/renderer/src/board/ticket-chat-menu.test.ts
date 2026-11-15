import { describe, expect, it, vi } from 'vitest';
import type { Agent } from '@agent-board/daemon/protocol';
import type { MenuAction } from '../ui';
import { boardRow, ticketChatEntries, ticketMenuEntries } from './ticket-chat-menu';

const chat = (over: Partial<Agent> = {}) => ({ name: 'chat', ticketChat: true, chatKind: 'implementer', plainFolder: false, endedAt: null, ...over }) as Agent;

type Row = { heading: string } | { id: string; label: string; checked: boolean | undefined; hint: string | undefined };

const rows = (agent: Agent, set = vi.fn()): Row[] =>
  ticketChatEntries(agent, set).map((entry) => {
    if (entry === 'separator' || 'heading' in entry) return entry as { heading: string };
    const row = entry as MenuAction & { id: string };
    return { id: row.id, label: row.label, checked: row.checked, hint: row.hint };
  });

describe("a ticket tile's ticket chat rows", () => {
  it('picks the kind it is, under its heading', () => {
    expect(rows(chat())).toEqual([
      { heading: 'Ticket chat' },
      { id: 'ticket-chat-lead', label: 'Its own lead', checked: false, hint: undefined },
      { id: 'ticket-chat-implementer', label: 'The implementer', checked: true, hint: undefined },
    ]);
    expect(rows(chat({ chatKind: 'lead' })).filter((row) => 'id' in row && row.checked)).toEqual([expect.objectContaining({ id: 'ticket-chat-lead' })]);
  });

  it('says a switch that waits for the builder, or for the chat, to hand off', () => {
    const toImplementer = rows(chat({ chatKind: 'lead', chatSwitch: 'implementer' }));
    expect(toImplementer[1]).toMatchObject({ id: 'ticket-chat-lead', label: 'Its own lead', checked: true });
    expect(toImplementer).toContainEqual(expect.objectContaining({ id: 'ticket-chat-implementer', checked: false, hint: 'after the builder hands off' }));
    expect(rows(chat({ chatSwitch: 'lead' }))).toContainEqual(expect.objectContaining({ id: 'ticket-chat-lead', checked: false, hint: 'after the chat hands off' }));
  });

  it('asks the daemon for the kind picked', () => {
    const set = vi.fn();
    const entries = ticketChatEntries(chat(), set);
    const lead = entries.find((entry) => entry !== 'separator' && 'id' in entry && entry.id === 'ticket-chat-lead');
    (lead as { onSelect(): void }).onSelect();
    expect(set).toHaveBeenCalledWith('lead');
  });

  it('has none for an agent that is no ticket chat, works outside git, or has ended', () => {
    expect(ticketChatEntries(chat({ ticketChat: false, chatKind: undefined }), vi.fn())).toEqual([]);
    expect(ticketChatEntries(chat({ plainFolder: true }), vi.fn())).toEqual([]);
    expect(ticketChatEntries(chat({ endedAt: '2026-11-15T00:00:00Z' }), vi.fn())).toEqual([]);
  });
});

describe("a ticket tile's ⋯ menu", () => {
  const view = { id: 'ticket-view', label: 'Show as card', onSelect: vi.fn() };
  const own = [{ id: 'rename', label: 'Rename', onSelect: vi.fn() }];
  const ids = (entries: ReturnType<typeof ticketMenuEntries>) =>
    entries.map((entry) => (entry === 'separator' ? '—' : 'heading' in entry ? `# ${entry.heading}` : (entry as { id: string }).id));

  it('has its view rows first, Open as board among them, then who builds, then the agent’s own rows', () => {
    expect(ids(ticketMenuEntries([view, boardRow(vi.fn())], ticketChatEntries(chat(), vi.fn()), own))).toEqual([
      'ticket-view',
      'ticket-board',
      '—',
      '# Ticket chat',
      'ticket-chat-lead',
      'ticket-chat-implementer',
      '—',
      'rename',
    ]);
  });

  it('has no who-builds section for a chat that has none', () => {
    expect(ids(ticketMenuEntries([view], [], own))).toEqual(['ticket-view', '—', 'rename']);
  });

  it('opens the ticket’s own board from Open as board', () => {
    const open = vi.fn();
    const row = boardRow(open) as MenuAction;
    expect(row.label).toBe('Open as board');
    row.onSelect();
    expect(open).toHaveBeenCalledOnce();
  });
});
