import { describe, expect, it, vi } from 'vitest';
import type { Agent, PullRequest, TicketWatch } from '@agent-board/daemon/protocol';
import type { MenuAction } from '../ui';
import { menuIds, type ModelEntry } from './menu-model';
import { closeTicketLines, closeTicketTeam, prLabel, stopTeam, ticketChatMenu, ticketChatRow, tileMenuEntries, type TicketChatMenuActions } from './ticket-chat-menu';

const agent = (over: Partial<Agent> = {}) =>
  ({ sessionId: 'chat', name: 'chat', ticketChat: true, chatKind: 'implementer', plainFolder: false, endedAt: null, state: 'idle', pullRequests: [], ...over }) as Agent;
const chat = agent;
const pr = (over: Partial<PullRequest> = {}): PullRequest => ({ number: 725, title: 'Fix it', url: 'https://github.com/o/r/pull/725', state: 'open', checks: 'pending', ...over });
const watched = (number: number, passing: number, total: number) =>
  ({ pullRequest: { repo: 'o/r', number, url: '', state: 'open' }, seen: { checks: { state: 'pending', passing, total } } }) as unknown as TicketWatch;

const actions = (): TicketChatMenuActions => ({
  openBoard: vi.fn(),
  openWatches: vi.fn(),
  openPullRequest: vi.fn(),
  setChatKind: vi.fn(),
  closeTicket: vi.fn(),
});

const own: ModelEntry[] = [
  { id: 'open', label: 'Open', onSelect: vi.fn() },
  { id: 'pop-out', label: 'Pop out', onSelect: vi.fn() },
  'separator',
  { id: 'delete', label: 'Delete agent', onSelect: vi.fn() },
];
const view: ModelEntry = { id: 'ticket-view-card', label: 'Show as card', onSelect: vi.fn() };

/** The menu's top-level ids, a separator as '—'. */
const top = (entries: readonly ModelEntry[]) => entries.map((entry) => (entry === 'separator' ? '—' : 'heading' in entry ? `# ${entry.heading}` : entry.id));
const row = (entries: readonly ModelEntry[], id: string) => entries.find((entry) => entry !== 'separator' && !('heading' in entry) && entry.id === id) as MenuAction & { id: string; entries?: ModelEntry[] };

describe("a ticket's chat ⋯ menu", () => {
  it("has the ticket's items first, then its views and the agent's own rows, and Close ticket… last", () => {
    const entries = ticketChatMenu({ chat: chat({ watch: watched(725, 3, 7), pullRequests: [pr()] }), helpers: [], views: [view], own, actions: actions() });
    expect(top(entries)).toEqual(['ticket-board', 'ticket-watches', 'ticket-pr', 'ticket-chat', '—', 'ticket-view-card', '—', 'open', 'pop-out', '—', 'close-ticket']);
    expect(row(entries, 'ticket-board').label).toBe("Open the ticket's board");
    expect(row(entries, 'ticket-watches').label).toBe('Watches…');
    expect(row(entries, 'ticket-pr').label).toBe('PR #725 · checks 3 of 7');
    expect(row(entries, 'ticket-chat').label).toBe('Chat kind: the implementer');
    expect(row(entries, 'close-ticket').label).toBe('Close ticket…');
  });

  it('leaves out Watches… with nothing to open it, the PR row with no pull request, and Chat kind for a chat with none', () => {
    const entries = ticketChatMenu({ chat: chat({ plainFolder: true }), helpers: [], views: [], own, actions: { ...actions(), openWatches: undefined } });
    expect(top(entries)).toEqual(['ticket-board', '—', 'open', 'pop-out', '—', 'close-ticket']);
    // A chat with no watch has no Watches… either.
    expect(menuIds(ticketChatMenu({ chat: chat(), helpers: [], views: [], own, actions: actions() }))).not.toContain('ticket-watches');
  });

  it('runs each ticket row', () => {
    const acts = actions();
    const helperPr = pr({ number: 9 });
    const helper = agent({ sessionId: 'h1', name: 'builder', ticket: 'chat', pullRequests: [helperPr] } as Partial<Agent>);
    const entries = ticketChatMenu({ chat: chat({ watch: watched(9, 0, 0) }), helpers: [helper], views: [], own, actions: acts });
    for (const id of ['ticket-board', 'ticket-watches', 'ticket-pr', 'close-ticket']) row(entries, id).onSelect();
    expect(acts.openBoard).toHaveBeenCalledOnce();
    expect(acts.openWatches).toHaveBeenCalledOnce();
    // The PR is the helper's: it opens as the helper's.
    expect(acts.openPullRequest).toHaveBeenCalledWith(helper, helperPr);
    expect(acts.closeTicket).toHaveBeenCalledOnce();
  });

  it('has no Stop session: the chat never ends alone, leaving its helpers running', () => {
    const run: ModelEntry = { id: 'run', label: 'Run', entries: [{ id: 'pause', label: 'Pause', onSelect: vi.fn() }, 'separator', { id: 'stop', label: 'Stop session', onSelect: vi.fn() }] };
    const entries = ticketChatMenu({ chat: chat(), helpers: [], views: [], own: [...own, run], actions: actions() });
    expect(menuIds(row(entries, 'run').entries!)).toEqual(['pause']);
    // A plain agent keeps it.
    expect(menuIds(row(tileMenuEntries({ chat: chat(), helpers: undefined, views: [], own: [run], actions: actions() }), 'run').entries!)).toEqual(['pause', 'stop']);
  });

  it('has Delete agent only once Close ticket… has ended the chat and its helpers, as deleting the chat leaves its helpers running', () => {
    const ended = '2026-11-20T00:00:00Z';
    const live = ticketChatMenu({ chat: chat({ endedAt: ended }), helpers: [agent({ sessionId: 'h1' })], views: [], own, actions: actions() });
    expect(menuIds(live)).not.toContain('delete');
    const closed = ticketChatMenu({ chat: chat({ endedAt: ended }), helpers: [agent({ sessionId: 'h1', endedAt: ended })], views: [], own, actions: actions() });
    expect(top(closed)).toEqual(['ticket-board', '—', 'open', 'pop-out', '—', 'delete', '—', 'close-ticket']);
  });

  it('keeps Close ticket… last, disabled, once the chat and its helpers have all ended', () => {
    const ended = '2026-11-20T00:00:00Z';
    const entries = ticketChatMenu({ chat: chat({ endedAt: ended }), helpers: [agent({ sessionId: 'h1', endedAt: ended })], views: [], own, actions: actions() });
    expect(entries.at(-1)).toMatchObject({ id: 'close-ticket', disabled: true, hint: 'Its chat and helpers have ended' });
    // A paused helper still closes.
    const paused = ticketChatMenu({ chat: chat({ endedAt: ended }), helpers: [agent({ sessionId: 'h1', state: 'hibernated', endedAt: ended })], views: [], own, actions: actions() });
    expect(paused.at(-1)).toMatchObject({ id: 'close-ticket', disabled: false });
  });
});

describe('a plain agent', () => {
  it('has no ticket items: its own menu is drawn as it is', () => {
    expect(tileMenuEntries({ chat: agent({ ticketChat: false }), helpers: undefined, views: [], own, actions: actions() })).toBe(own);
  });
});

describe('Chat kind ▸', () => {
  const rows = (entry: ModelEntry | undefined) =>
    (entry as { entries: ModelEntry[] }).entries.map((each) => {
      const action = each as MenuAction & { id: string };
      return { id: action.id, label: action.label, checked: action.checked, hint: action.hint };
    });

  it('names the kind it is, and picks it among its own lead and the implementer', () => {
    expect(ticketChatRow(chat(), vi.fn())).toMatchObject({ id: 'ticket-chat', label: 'Chat kind: the implementer' });
    expect(rows(ticketChatRow(chat(), vi.fn()))).toEqual([
      { id: 'ticket-chat-lead', label: 'Its own lead', checked: false, hint: undefined },
      { id: 'ticket-chat-implementer', label: 'The implementer', checked: true, hint: undefined },
    ]);
    expect(ticketChatRow(chat({ chatKind: 'lead' }), vi.fn())).toMatchObject({ label: 'Chat kind: its own lead' });
  });

  it('says a switch that waits for the builder, or for the chat, to hand off', () => {
    expect(rows(ticketChatRow(chat({ chatKind: 'lead', chatSwitch: 'implementer' }), vi.fn()))).toContainEqual(
      expect.objectContaining({ id: 'ticket-chat-implementer', checked: false, hint: 'after the builder hands off' }),
    );
    expect(rows(ticketChatRow(chat({ chatSwitch: 'lead' }), vi.fn()))).toContainEqual(expect.objectContaining({ id: 'ticket-chat-lead', hint: 'after the chat hands off' }));
  });

  it('asks the daemon for the kind picked', () => {
    const set = vi.fn();
    const lead = (ticketChatRow(chat(), set) as { entries: (MenuAction & { id: string })[] }).entries.find((each) => each.id === 'ticket-chat-lead')!;
    lead.onSelect();
    expect(set).toHaveBeenCalledWith('lead');
  });

  it('is not there for an agent that is no ticket chat, works outside git, or has ended', () => {
    expect(ticketChatRow(chat({ ticketChat: false, chatKind: undefined }), vi.fn())).toBeUndefined();
    expect(ticketChatRow(chat({ plainFolder: true }), vi.fn())).toBeUndefined();
    expect(ticketChatRow(chat({ endedAt: '2026-11-15T00:00:00Z' }), vi.fn())).toBeUndefined();
  });
});

describe('the PR row', () => {
  it('counts its checks from what the watches last read of that pull request', () => {
    expect(prLabel(pr(), watched(725, 3, 7))).toBe('PR #725 · checks 3 of 7');
  });

  it('says its checks in a word with no count for it, and nothing of checks it has none of', () => {
    expect(prLabel(pr({ checks: 'passing' }), undefined)).toBe('PR #725 · checks passing');
    expect(prLabel(pr({ checks: 'failing' }), watched(1, 2, 3))).toBe('PR #725 · checks failing');
    expect(prLabel(pr({ checks: 'none' }), undefined)).toBe('PR #725');
    expect(prLabel(pr({ state: 'merged', checks: 'passing' }), undefined)).toBe('PR #725 · merged');
    expect(prLabel(pr({ state: 'closed', checks: 'failing' }), undefined)).toBe('PR #725 · closed');
  });
});

describe('Close ticket…, confirmed', () => {
  const ended = '2026-11-20T00:00:00Z';
  const helper = (sessionId: string, over: Partial<Agent> = {}) => agent({ sessionId, name: sessionId, ticket: 'chat', ...over } as Partial<Agent>);
  const ids = (team: readonly Agent[]) => team.map((each) => each.sessionId);

  it('ends its live and paused helpers first, then its chat, and no one else', () => {
    const board = [chat(), helper('builder'), helper('reviewer', { state: 'hibernated', endedAt: ended }), helper('done', { endedAt: ended }), agent({ sessionId: 'other' })];
    expect(ids(closeTicketTeam(board, 'chat'))).toEqual(['builder', 'reviewer', 'chat']);
  });

  it('still ends its helpers once its chat has ended, and nothing for a chat gone from the board', () => {
    expect(ids(closeTicketTeam([chat({ endedAt: ended }), helper('builder')], 'chat'))).toEqual(['builder']);
    expect(closeTicketTeam([helper('builder')], 'chat')).toEqual([]);
  });

  it('stops each in turn, going on past one that fails, and says which failed', async () => {
    const stopped: string[] = [];
    const failed = await stopTeam([helper('reviewer'), helper('builder'), chat()], async (sessionId) => {
      if (sessionId === 'reviewer') throw new Error('reviewer has already ended');
      stopped.push(sessionId);
    });
    expect(stopped).toEqual(['builder', 'chat']);
    expect(failed.map(({ agent: each, error }) => [each.sessionId, (error as Error).message])).toEqual([['reviewer', 'reviewer has already ended']]);
  });
});

describe('Close ticket?', () => {
  it('says what ends, and that the branches stay', () => {
    expect(closeTicketLines(chat({ name: 'ACME-12' }), [])).toEqual([
      'ACME-12 ends. Its worktree, branch and conversation stay, and Restart carries it on.',
    ]);
    expect(closeTicketLines(chat({ name: 'ACME-12' }), [agent({ sessionId: 'h1' }), agent({ sessionId: 'h2', endedAt: '2026-11-20T00:00:00Z' })])).toEqual([
      'ACME-12 and its 1 helper end. Their worktrees, branches and conversations stay, and Restart carries each on.',
    ]);
  });

  it('names only the helpers once its chat has ended', () => {
    expect(closeTicketLines(chat({ endedAt: '2026-11-20T00:00:00Z' }), [agent({ sessionId: 'h1' })])).toEqual([
      'Its 1 helper ends. Its worktree, branch and conversation stay, and Restart carries it on.',
    ]);
  });
});
