import { describe, expect, it } from 'vitest';
import { createSizeVotes } from './terminal-sizing.ts';

const DESK = { cols: 200, rows: 50 };
const PHONE = { cols: 40, rows: 20 };
const POPOUT = { cols: 120, rows: 40 };

describe('terminal sizing with several viewers', () => {
  it('has no size to give until a client that counts asks for one', () => {
    const votes = createSizeVotes<string>();
    expect(votes.size()).toBeUndefined();

    votes.resized('phone', PHONE, { counts: false });

    expect(votes.size()).toBeUndefined();
  });

  it('takes the size of the client that resized last, when each counts', () => {
    const votes = createSizeVotes<string>();
    votes.resized('desk', DESK, { counts: true });
    votes.resized('popout', POPOUT, { counts: true });

    expect(votes.size()).toEqual(POPOUT);

    votes.resized('desk', DESK, { counts: true });
    expect(votes.size()).toEqual(DESK);
  });

  it('gives the size to the client that typed last', () => {
    const votes = createSizeVotes<string>();
    votes.resized('desk', DESK, { counts: true });
    votes.resized('popout', POPOUT, { counts: true });

    votes.typed('desk');

    expect(votes.size()).toEqual(DESK);
  });

  it("counts a client that may only size after typing once it has typed, at the size it last asked for", () => {
    const votes = createSizeVotes<string>();
    votes.resized('desk', DESK, { counts: true });
    votes.resized('phone', PHONE, { counts: false });
    expect(votes.size()).toEqual(DESK);

    votes.typed('phone');
    expect(votes.size()).toEqual(PHONE);

    votes.resized('phone', { cols: 60, rows: 20 }, { counts: false });
    expect(votes.size()).toEqual({ cols: 60, rows: 20 });

    votes.typed('desk');
    expect(votes.size()).toEqual(DESK);
  });

  it('hands the size to the next most recent client when the last one leaves', () => {
    const votes = createSizeVotes<string>();
    votes.resized('desk', DESK, { counts: true });
    votes.resized('popout', POPOUT, { counts: true });

    expect(votes.left('popout')).toBe(true);
    expect(votes.size()).toEqual(DESK);

    expect(votes.left('desk')).toBe(true);
    expect(votes.size()).toBeUndefined();
    expect(votes.left('never-viewed')).toBe(false);
  });

  it('passes over a client that typed but never asked for a size', () => {
    const votes = createSizeVotes<string>();
    votes.resized('desk', DESK, { counts: true });

    votes.typed('cli');

    expect(votes.size()).toEqual(DESK);
  });
});
