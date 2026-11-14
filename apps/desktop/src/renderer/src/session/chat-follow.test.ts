import { describe, expect, it } from 'vitest';
import { STICK_DISTANCE, stillFollowing } from './chat-follow';

const at = (scrollTop: number, scrollHeight = 1000, clientHeight = 400) => ({ scrollHeight, scrollTop, clientHeight });

describe('stillFollowing', () => {
  it('follows a chat scrolled to its end, or near it', () => {
    expect(stillFollowing(false, at(600), 0)).toBe(true);
    expect(stillFollowing(false, at(600 - STICK_DISTANCE + 1), 0)).toBe(true);
  });

  it('keeps following when the chat’s own scroll to its end comes after what it holds has grown again', () => {
    // Scrolled to 600 of 1000; by the time that scroll's event comes, a row has grown by 80.
    expect(stillFollowing(true, at(600, 1080), 600)).toBe(true);
  });

  it('stops following when the reader scrolls up, away from the end', () => {
    expect(stillFollowing(true, at(400), 600)).toBe(false);
  });

  it('does not start following again until the reader is back near the end', () => {
    expect(stillFollowing(false, at(500), 400)).toBe(false);
    expect(stillFollowing(false, at(590), 500)).toBe(true);
  });
});
