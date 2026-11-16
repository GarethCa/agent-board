import { afterEach, describe, expect, it } from 'vitest';
import { goingThroughNow, goThrough, moveGoingThrough, readGoingThrough, stopGoingThrough, stopGoingThroughUnless } from './queue-board';

afterEach(stopGoingThrough);

describe('the queue going through its things', () => {
  it('keeps its place outside the tile, so a tile drawn again off screen and back shows the same thing', () => {
    goThrough('q1');
    moveGoingThrough('q1', { key: 'job:c', index: 2 });
    expect(readGoingThrough()).toMatchObject({ queueId: 'q1', place: { key: 'job:c', index: 2 } });
    expect(goingThroughNow()).toBe('q1');
  });

  it('moves only the queue going through', () => {
    goThrough('q1');
    moveGoingThrough('q2', { key: 'job:c', index: 2 });
    expect(readGoingThrough()?.place).toEqual({ key: undefined, index: 0 });
  });

  it('starts at the first thing each time it is started, as a new start, so the tile takes the focus again', () => {
    goThrough('q1');
    const first = readGoingThrough()!.start;
    moveGoingThrough('q1', { key: 'job:c', index: 2 });
    goThrough('q1');
    expect(readGoingThrough()).toMatchObject({ place: { key: undefined, index: 0 } });
    expect(readGoingThrough()!.start).toBeGreaterThan(first);
  });

  it('stops once its queue is gone from the board or is no longer the user’s', () => {
    goThrough('q1');
    stopGoingThroughUnless(['q1', 'q2']);
    expect(goingThroughNow()).toBe('q1');
    stopGoingThroughUnless(['q2']);
    expect(goingThroughNow()).toBeUndefined();
  });
});
