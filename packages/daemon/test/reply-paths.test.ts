import { describe, expect, it } from 'vitest';
import { createReplyPaths } from '../src/reply-paths.ts';

/** Reply paths on a clock the test moves, with the agents on the board it sets. */
function paths(windowMs = 1000) {
  let time = 0;
  const onBoard = new Set(['captain', 'lead', 'worker']);
  const replies = createReplyPaths({ windowMs, now: () => time, onBoard: (id) => onBoard.has(id) });
  return { replies, onBoard, advance: (ms: number) => (time += ms) };
}

describe('reply paths', () => {
  it('let the receiver answer the sender, one way only', () => {
    const { replies } = paths();
    replies.open('lead', 'captain');
    expect(replies.has('lead', 'captain')).toBe(true);
    expect(replies.has('captain', 'lead')).toBe(false);
    expect(replies.has('worker', 'captain')).toBe(false);
    expect(replies.has('lead', undefined)).toBe(false);
  });

  it('last the window from the latest message, and are forgotten once it ends', () => {
    const { replies, advance } = paths(1000);
    replies.open('lead', 'captain');
    advance(600);
    replies.open('lead', 'captain');
    advance(600);
    expect(replies.has('lead', 'captain')).toBe(true);
    advance(400);
    expect(replies.has('lead', 'captain')).toBe(false);
    expect(replies.size()).toBe(0);
  });

  it('forget every path to and from a removed agent', () => {
    const { replies, onBoard } = paths();
    replies.open('lead', 'captain');
    replies.open('worker', 'captain');
    replies.open('captain', 'lead');
    replies.open('worker', 'lead');
    replies.forget('captain');
    expect(replies.size()).toBe(1);
    expect(replies.has('worker', 'lead')).toBe(true);
    // A sender gone from the board is answered no more, even before its removal is heard.
    onBoard.delete('lead');
    expect(replies.has('worker', 'lead')).toBe(false);
  });
});
