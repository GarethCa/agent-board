import { describe, expect, it } from 'vitest';
import { notReadBecause, readsItem } from './item-scope.ts';
import type { Agent } from './protocol.ts';

const agent = (sessionId: string, fields: Partial<Agent> = {}) => ({ sessionId, zoneId: 'web', ticket: null, ...fields }) as Agent;

describe('readsItem', () => {
  it('gives a zone’s item to its agents, a loose one to every agent, and any item to the agents it is about', () => {
    expect(readsItem(agent('a'), { zoneId: 'web', ticket: null }, false)).toBe(true);
    expect(readsItem(agent('a'), { zoneId: 'api', ticket: null }, false)).toBe(false);
    expect(readsItem(agent('a'), { zoneId: null, ticket: null }, false)).toBe(true);
    expect(readsItem(agent('a'), { zoneId: 'api', ticket: null }, true)).toBe(true);
  });

  it("gives an item on a ticket's board to its chat and its helpers only, though it is in no zone", () => {
    const nested = { zoneId: null, ticket: 'chat' };
    expect(readsItem(agent('chat', { ticketChat: true }), nested, false)).toBe(true);
    expect(readsItem(agent('builder', { ticket: 'chat' }), nested, false)).toBe(true);
    expect(readsItem(agent('other'), nested, false)).toBe(false);
    expect(readsItem(agent('builder', { ticket: 'another chat' }), nested, false)).toBe(false);
    expect(readsItem(agent('other'), nested, true)).toBe(true);
  });
});

describe('notReadBecause', () => {
  it('says where the item is', () => {
    expect(notReadBecause('that memory', { ticket: null })).toBe('that memory is in a zone you are not in');
    expect(notReadBecause('that memory', { ticket: 'chat' })).toBe("that memory is on a ticket's board you are not on");
  });
});
