import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cardSaves } from './card-saves';

const PAUSE = 400;

describe('cardSaves: saving where a question card was moved', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function saves(asked = new Set(['q1'])) {
    const place = vi.fn(() => Promise.resolve());
    const onError = vi.fn();
    return { place, onError, asked, saves: cardSaves(place, PAUSE, (askId) => asked.has(askId), onError) };
  }

  it('saves the last place once the moves stop', () => {
    const { place, saves: s } = saves();
    s.moved('question:a1', 'a1', 'q1', { x: 0, y: 5 });
    vi.advanceTimersByTime(PAUSE - 1);
    s.moved('question:a1', 'a1', 'q1', { x: 0, y: 10 });
    vi.advanceTimersByTime(PAUSE - 1);
    expect(place).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(place).toHaveBeenCalledExactlyOnceWith('a1', 'q1', { x: 0, y: 10 });
  });

  it('drops the save of a question answered within the pause: no place, no error', async () => {
    const { place, onError, asked, saves: s } = saves();
    s.moved('question:a1', 'a1', 'q1', { x: 0, y: 5 });
    // Answered by the next key: its card goes.
    asked.delete('q1');
    s.keepOnly(asked);
    await vi.advanceTimersByTimeAsync(PAUSE * 2);
    expect(place).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('reports a failed save only while its question is still asked', async () => {
    const asked = new Set(['q1', 'q2']);
    const onError = vi.fn();
    const failing = cardSaves(() => Promise.reject(new Error('the agent no longer asks that')), PAUSE, (askId) => asked.has(askId), onError);
    failing.moved('question:a1', 'a1', 'q1', { x: 0, y: 5 });
    failing.moved('question:a2', 'a2', 'q2', { x: 0, y: 5 });
    await vi.advanceTimersByTimeAsync(PAUSE - 1);
    // q1 answered as its save went.
    asked.delete('q1');
    await vi.advanceTimersByTimeAsync(1);
    expect(onError).toHaveBeenCalledOnce();
  });

  it('sends nothing once disposed', async () => {
    const { place, saves: s } = saves();
    s.moved('question:a1', 'a1', 'q1', { x: 0, y: 5 });
    s.dispose();
    await vi.advanceTimersByTimeAsync(PAUSE * 2);
    expect(place).not.toHaveBeenCalled();
  });
});
