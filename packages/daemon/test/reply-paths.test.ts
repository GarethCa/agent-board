import { describe, expect, it } from 'vitest';
import type { OrchestrateScope } from '../src/protocol.ts';
import { createReplyPaths } from '../src/reply-paths.ts';

/** Reply paths on a clock the test moves, with agents whose scope it sets. */
function paths(windowMs = 1000) {
  let time = 0;
  const scopes = new Map<string, OrchestrateScope | null>([
    ['captain', 'board'],
    ['lead', 'zone'],
    ['worker', null],
  ]);
  const replies = createReplyPaths({ windowMs, now: () => time, scopeOf: (id) => scopes.get(id) });
  return { replies, scopes, advance: (ms: number) => (time += ms) };
}

describe('reply paths', () => {
  it('let the receiver answer the sender, one way only', () => {
    const { replies } = paths();
    replies.open('lead', 'captain', 'board');
    expect(replies.has('lead', 'captain')).toBe(true);
    expect(replies.has('captain', 'lead')).toBe(false);
    expect(replies.has('worker', 'captain')).toBe(false);
    expect(replies.has('lead', undefined)).toBe(false);
  });

  it('last the window from the latest message, and are forgotten once it ends', () => {
    const { replies, advance } = paths(1000);
    replies.open('lead', 'captain', 'board');
    advance(600);
    replies.open('lead', 'captain', 'board');
    advance(600);
    expect(replies.has('lead', 'captain')).toBe(true);
    advance(400);
    expect(replies.has('lead', 'captain')).toBe(false);
    expect(replies.size()).toBe(0);
  });

  it('close once the sender is let reach wider than it did as it asked, and stay closed', () => {
    const { replies, scopes } = paths();
    replies.open('worker', 'lead', 'zone');
    scopes.set('lead', 'repo');
    expect(replies.has('worker', 'lead')).toBe(false);
    scopes.set('lead', 'zone');
    expect(replies.has('worker', 'lead')).toBe(false);
  });

  it('stay open while the sender reaches as far or less', () => {
    const { replies, scopes } = paths();
    replies.open('lead', 'captain', 'board');
    scopes.set('captain', 'zone');
    expect(replies.has('lead', 'captain')).toBe(true);
    scopes.set('captain', null);
    expect(replies.has('lead', 'captain')).toBe(true);
  });

  it('forget every path to and from a removed agent', () => {
    const { replies, scopes } = paths();
    replies.open('lead', 'captain', 'board');
    replies.open('worker', 'captain', 'board');
    replies.open('captain', 'lead', 'zone');
    replies.open('worker', 'lead', 'zone');
    replies.forget('captain');
    expect(replies.size()).toBe(1);
    expect(replies.has('worker', 'lead')).toBe(true);
    // A sender gone from the board is answered no more, even before its removal is heard.
    scopes.delete('lead');
    expect(replies.has('worker', 'lead')).toBe(false);
  });
});
