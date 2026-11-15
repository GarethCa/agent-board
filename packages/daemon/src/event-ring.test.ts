import { describe, expect, it } from 'vitest';
import { createEventRing } from './event-ring.ts';
import type { DaemonEvent } from './protocol.ts';

const zoneRemoved = (id: string): DaemonEvent => ({ type: 'zone.removed', id });

describe('event ring', () => {
  it('numbers events from 1, in one epoch, and puts both in the line it sends', () => {
    const ring = createEventRing({ epoch: 'e1' });
    expect(ring.last()).toBe(0);
    const first = ring.append(zoneRemoved('a'));
    const second = ring.append(zoneRemoved('b'));
    expect([first.seq, second.seq]).toEqual([1, 2]);
    expect(ring.last()).toBe(2);
    expect(JSON.parse(second.line)).toEqual({ jsonrpc: '2.0', method: 'event', params: { type: 'zone.removed', id: 'b' }, seq: 2, epoch: 'e1' });
    expect(second.line.endsWith('\n')).toBe(true);
  });

  it('makes a new random epoch for each ring unless given one', () => {
    expect(createEventRing().epoch).not.toBe(createEventRing().epoch);
  });

  it('hands back the events after a seq, in order, and none when caught up', () => {
    const ring = createEventRing();
    for (const id of ['a', 'b', 'c']) ring.append(zoneRemoved(id));
    expect(ring.after(1)?.map((entry) => entry.seq)).toEqual([2, 3]);
    expect(ring.after(0)?.map((entry) => entry.seq)).toEqual([1, 2, 3]);
    expect(ring.after(3)).toEqual([]);
  });

  it('has nothing to give a seq it never reached, or one it has let go of', () => {
    const ring = createEventRing({ maxEvents: 3 });
    for (const id of ['a', 'b', 'c', 'd', 'e']) ring.append(zoneRemoved(id));
    expect(ring.after(6)).toBeUndefined();
    expect(ring.after(-1)).toBeUndefined();
    expect(ring.after(1.5)).toBeUndefined();
    // It holds 3, 4 and 5: from 2 on is still whole, from 1 on lacks 2.
    expect(ring.after(2)?.map((entry) => entry.seq)).toEqual([3, 4, 5]);
    expect(ring.after(1)).toBeUndefined();
  });

  it('lets the oldest events go once it holds more characters than it may', () => {
    const size = createEventRing().append(zoneRemoved('a')).line.length;
    const ring = createEventRing({ maxChars: size * 2 });
    for (const id of ['a', 'b', 'c']) ring.append(zoneRemoved(id));
    expect(ring.after(1)?.map((entry) => entry.seq)).toEqual([2, 3]);
    expect(ring.after(0)).toBeUndefined();
  });

  it('keeps nothing of an event bigger than it may hold, and still numbers the ones after it', () => {
    const ring = createEventRing({ maxChars: 10 });
    ring.append(zoneRemoved('a'));
    expect(ring.after(0)).toBeUndefined();
    expect(ring.after(1)).toEqual([]);
    expect(ring.append(zoneRemoved('b')).seq).toBe(2);
  });

  it('stays whole across many more events than it holds', () => {
    const ring = createEventRing({ maxEvents: 100 });
    for (let index = 0; index < 10_000; index += 1) ring.append(zoneRemoved(String(index)));
    expect(ring.after(9_900)?.map((entry) => entry.seq)).toEqual(Array.from({ length: 100 }, (_, index) => 9_901 + index));
    expect(ring.after(9_899)).toBeUndefined();
  });
});
