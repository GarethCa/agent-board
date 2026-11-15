import { describe, expect, it } from 'vitest';
import type { PullRequest } from '@agent-board/daemon/protocol';
import {
  keepTicketViews,
  liveWhileOpen,
  opensAsBoard,
  restingOver,
  restsInTerminal,
  shownHelper,
  shownTicketViews,
  ticketsLeavingTerminal,
  TICKET_TERMINAL_SIZE,
  ticketOver,
  ticketTilesOpenAsFrom,
  ticketViewOf,
  ticketViewsFrom,
  withTicketTerminals,
  withTicketView,
} from './ticket-view';

describe('the Ticket tiles open as setting', () => {
  it('is Terminal unless Card or Board was saved', () => {
    expect(ticketTilesOpenAsFrom(undefined)).toBe('terminal');
    expect(ticketTilesOpenAsFrom('nonsense')).toBe('terminal');
    expect(ticketTilesOpenAsFrom('card')).toBe('card');
    expect(ticketTilesOpenAsFrom('board')).toBe('board');
    expect(ticketTilesOpenAsFrom('terminal')).toBe('terminal');
  });
});

describe('whether a ticket opens as its board', () => {
  it('follows the view its tile shows, else the setting, by its chat’s session id', () => {
    expect(opensAsBoard('a', {}, 'board')).toBe(true);
    expect(opensAsBoard('a', {}, 'terminal')).toBe(false);
    expect(opensAsBoard('a', { 'agent:a': 'board' }, 'card')).toBe(true);
    expect(opensAsBoard('a', { 'agent:a': 'terminal' }, 'board')).toBe(false);
  });

  it('is false for an over ticket, which the shown views rest as its card, whatever the default', () => {
    const shown = shownTicketViews({}, new Set(['agent:a']));
    expect(opensAsBoard('a', shown, 'board')).toBe(false);
  });
});

describe('a ticket tile’s own view', () => {
  it('can be the board: it rests as its card, and a double-click takes the user into its board', () => {
    expect(ticketViewOf({}, 'agent:a', 'board')).toBe('board');
    expect(ticketViewOf({ 'agent:a': 'board' }, 'agent:a', 'terminal')).toBe('board');
    expect(restsInTerminal(['agent:a'], new Set(), {}, 'board', 'agent:a')).toBe(false);
  });

  it('is the default until the tile is switched by hand, and the default changes no tile switched', () => {
    const views = withTicketView({}, 'agent:a', 'card');
    expect(ticketViewOf(views, 'agent:a', 'terminal')).toBe('card');
    expect(ticketViewOf(views, 'agent:b', 'terminal')).toBe('terminal');
    expect(ticketViewOf(views, 'agent:b', 'card')).toBe('card');
    expect(ticketViewOf(views, 'agent:a', 'card')).toBe('card');
  });

  it('keeps the same object when nothing changes', () => {
    const views = withTicketView({}, 'agent:a', 'card');
    expect(withTicketView(views, 'agent:a', 'card')).toBe(views);
    expect(withTicketView(views, 'agent:a', 'terminal')).toEqual({ 'agent:a': 'terminal' });
  });

  it('is read back from the view state, dropping what is not a view', () => {
    expect(ticketViewsFrom({ 'agent:a': 'card', 'agent:b': 'terminal', 'agent:c': 'board', 'agent:d': 3, 'agent:e': 'nonsense' })).toEqual({
      'agent:a': 'card',
      'agent:b': 'terminal',
      'agent:c': 'board',
    });
    expect(ticketViewsFrom(null)).toEqual({});
    expect(ticketViewsFrom(['card'])).toEqual({});
  });

  it('is forgotten once its tile goes', () => {
    const views = { 'agent:a': 'card', 'agent:b': 'terminal' } as const;
    expect(keepTicketViews(views, new Set(['agent:a', 'agent:b']))).toBe(views);
    expect(keepTicketViews(views, new Set(['agent:b']))).toEqual({ 'agent:b': 'terminal' });
  });
});

describe('ticket tiles in the terminal view', () => {
  it('are expanded in place, at their last size or the terminal size', () => {
    const expanded = [{ id: 'agent:x', width: 900, height: 500 }];
    const next = withTicketTerminals(expanded, ['agent:a', 'agent:b'], new Set(), { 'agent:b': { width: 800, height: 400 } });
    expect(next).toEqual([...expanded, { id: 'agent:a', ...TICKET_TERMINAL_SIZE }, { id: 'agent:b', width: 800, height: 400 }]);
  });

  it('leave an expanded one where it is, and the array the same when all are open', () => {
    const expanded = [{ id: 'agent:a', width: 900, height: 500 }];
    expect(withTicketTerminals(expanded, ['agent:a'], new Set(), {})).toBe(expanded);
  });

  it('go back to their card when the default turns to Card, all but those switched by hand', () => {
    const views = { 'agent:b': 'terminal' } as const;
    const none = new Set<string>();
    expect(ticketsLeavingTerminal(['agent:a', 'agent:b'], none, views, 'terminal', 'card')).toEqual(['agent:a']);
    expect(ticketsLeavingTerminal(['agent:a', 'agent:b'], none, views, 'card', 'terminal')).toEqual([]);
    expect(ticketsLeavingTerminal(['agent:a'], none, {}, 'card', 'card')).toEqual([]);
    expect(ticketsLeavingTerminal(['agent:a'], new Set(['agent:a']), {}, 'terminal', 'card')).toEqual([]);
    // Board rests as the card on the board above it, so it takes them out of the terminal too.
    expect(ticketsLeavingTerminal(['agent:a', 'agent:b'], none, views, 'terminal', 'board')).toEqual(['agent:a']);
    expect(ticketsLeavingTerminal(['agent:a'], none, {}, 'board', 'card')).toEqual([]);
  });

  it('are not expanded while their session window has them', () => {
    expect(withTicketTerminals([], ['agent:a'], new Set(['agent:a']), {})).toEqual([]);
  });

  it('rest open: only a ticket tile in the terminal view, by default or by hand, is left open by a collapse the board makes', () => {
    const tickets = ['agent:a', 'agent:b'];
    const none = new Set<string>();
    const views = { 'agent:b': 'card' } as const;
    expect(restsInTerminal(tickets, none, views, 'terminal', 'agent:a')).toBe(true);
    expect(restsInTerminal(tickets, none, views, 'terminal', 'agent:b')).toBe(false);
    expect(restsInTerminal(tickets, none, { 'agent:a': 'terminal' }, 'card', 'agent:a')).toBe(true);
    expect(restsInTerminal(tickets, none, {}, 'card', 'agent:a')).toBe(false);
    expect(restsInTerminal(tickets, none, {}, 'terminal', 'agent:other')).toBe(false);
    expect(restsInTerminal(tickets, new Set(['agent:a']), {}, 'terminal', 'agent:a')).toBe(false);
  });
});

describe('a helper shown in its ticket’s tile', () => {
  const helpers = [{ sessionId: 'builder' }, { sessionId: 'reviewer' }];
  it('is the helper picked while the ticket still holds it, else the ticket’s chat', () => {
    expect(shownHelper('builder', helpers)).toBe(helpers[0]);
    expect(shownHelper('gone', helpers)).toBeUndefined();
    expect(shownHelper(undefined, helpers)).toBeUndefined();
  });
});

describe('a ticket that is over', () => {
  const live: Parameters<typeof ticketOver>[0] = { endedAt: null, state: 'idle', workFinishedAt: null, pullRequests: [] };
  const pr = (state: 'open' | 'merged'): PullRequest => ({ number: 7, title: 'Watch settings', url: '', state, checks: 'passing' });

  it('is one whose chat ended, is done, or whose pull request merged; its own or a helper’s', () => {
    expect(ticketOver(live, [])).toBe(false);
    expect(ticketOver({ ...live, endedAt: '2026-11-14T10:00:00Z' }, [])).toBe(true);
    expect(ticketOver({ ...live, state: 'done' }, [])).toBe(true);
    expect(ticketOver({ ...live, workFinishedAt: '2026-11-14T10:00:00Z' }, [])).toBe(true);
    expect(ticketOver({ ...live, pullRequests: [pr('merged')] }, [])).toBe(true);
    expect(ticketOver(live, [{ pullRequests: [pr('merged')] }])).toBe(true);
    expect(ticketOver(live, [{ pullRequests: [pr('open')] }])).toBe(false);
  });

  it('rests as its card whatever the default, unless switched by hand to its terminal', () => {
    expect(ticketViewOf({}, 'agent:a', 'terminal', true)).toBe('card');
    expect(ticketViewOf({ 'agent:a': 'terminal' }, 'agent:a', 'terminal', true)).toBe('terminal');
    expect(ticketViewOf({}, 'agent:a', 'terminal', false)).toBe('terminal');
  });
});

describe('a ticket going over while its tile is open', () => {
  const none: ReadonlySet<string> = new Set();
  const over = new Set(['agent:a']);

  it('keeps the tile in its view until it is closed, then rests as its card', () => {
    // Opened while live: held through the ticket going over.
    const opened = liveWhileOpen(none, ['agent:a'], none);
    const held = liveWhileOpen(opened, ['agent:a'], over);
    expect(held).toBe(opened);
    const resting = restingOver(over, held);
    expect(resting.has('agent:a')).toBe(false);
    expect(shownTicketViews({}, resting)).toEqual({});
    expect(restsInTerminal(['agent:a'], resting, {}, 'terminal', 'agent:a')).toBe(true);
    // Closed, it is let go, and rests as its card.
    const closed = liveWhileOpen(held, [], over);
    expect(closed.size).toBe(0);
    expect(shownTicketViews({}, restingOver(over, closed))).toEqual({ 'agent:a': 'card' });
    expect(restsInTerminal(['agent:a'], restingOver(over, closed), {}, 'terminal', 'agent:a')).toBe(false);
  });

  it('does not hold a tile opened after its ticket was over: it opens as its card', () => {
    const held = liveWhileOpen(none, ['agent:a'], over);
    expect(held.size).toBe(0);
    expect(shownTicketViews({}, restingOver(over, held))).toEqual({ 'agent:a': 'card' });
  });

  it('leaves a tile switched by hand in the view it was switched to', () => {
    expect(shownTicketViews({ 'agent:a': 'terminal' }, over)).toEqual({ 'agent:a': 'terminal' });
  });

  it('keeps the same objects when nothing changes', () => {
    const views = { 'agent:b': 'card' as const };
    expect(shownTicketViews(views, none)).toBe(views);
    expect(restingOver(over, none)).toBe(over);
    const held = liveWhileOpen(none, ['agent:b'], none);
    expect(liveWhileOpen(held, ['agent:b'], over)).toBe(held);
  });
});
