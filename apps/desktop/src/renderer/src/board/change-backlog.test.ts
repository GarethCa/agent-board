import { describe, expect, it } from 'vitest';
import { changeBacklog } from './change-backlog';

const append = (list: string[], change: string) => [...list, change];

describe('changeBacklog', () => {
  it('keeps the changes that arrive while the list is in flight, and replays them over it', () => {
    const backlog = changeBacklog<string>();

    expect(backlog.hold('a')).toBe(true);
    expect(backlog.hold('b')).toBe(true);

    expect(backlog.replayOver(['listed'], append)).toEqual(['listed', 'a', 'b']);
  });

  it('keeps nothing once it has replayed: later changes are applied directly', () => {
    const backlog = changeBacklog<string>();
    backlog.replayOver([], append);

    expect(backlog.hold('late')).toBe(false);
    expect(backlog.replayOver(['listed'], append)).toEqual(['listed']);
  });

  it('can start stopped, keeping only from start() until it replays or is dropped', () => {
    const backlog = changeBacklog<string>({ keeping: false });
    expect(backlog.hold('before')).toBe(false);

    backlog.start();
    expect(backlog.hold('during')).toBe(true);
    backlog.drop();
    expect(backlog.hold('after a failed list')).toBe(false);

    backlog.start();
    backlog.hold('retry');
    expect(backlog.replayOver(['listed'], append)).toEqual(['listed', 'retry']);
  });
});
