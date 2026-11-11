import { describe, expect, it } from 'vitest';
import { stateClock } from './state-since.ts';

const T0 = '2026-11-11T01:00:00.000Z';
const T1 = '2026-11-11T01:05:00.000Z';
const T2 = '2026-11-11T01:09:00.000Z';

describe('stateClock', () => {
  it('keeps the time a state began while it is read again', () => {
    const clock = stateClock();
    expect(clock.since('a', 'running', T0, null)).toBe(T0);
    expect(clock.since('a', 'running', T1, null)).toBe(T0);
  });

  it('starts a new state at the read that first sees it', () => {
    const clock = stateClock();
    clock.since('a', 'running', T0, null);
    expect(clock.since('a', 'idle', T1, null)).toBe(T1);
    expect(clock.since('a', 'idle', T2, null)).toBe(T1);
    expect(clock.since('a', 'running', T2, null)).toBe(T2);
  });

  it("starts an agent first read at its row's own time for its state, when it has one", () => {
    const clock = stateClock();
    expect(clock.since('a', 'hibernated', T2, T0)).toBe(T0);
    // Only on first sight: a later change is the clock's to time.
    expect(clock.since('a', 'running', T2, T1)).toBe(T2);
  });

  it('times a hand-off as part of the state it came from', () => {
    const clock = stateClock();
    clock.since('a', 'idle', T0, null);
    expect(clock.since('a', 'handing-off', T1, null)).toBe(T0);
    expect(clock.since('a', 'idle', T2, null)).toBe(T0);
  });

  it('starts a forgotten agent afresh', () => {
    const clock = stateClock();
    clock.since('a', 'running', T0, null);
    clock.forget('a');
    expect(clock.since('a', 'running', T1, null)).toBe(T1);
  });

  it('keeps each agent apart', () => {
    const clock = stateClock();
    clock.since('a', 'running', T0, null);
    expect(clock.since('b', 'running', T1, null)).toBe(T1);
    expect(clock.since('a', 'running', T2, null)).toBe(T0);
  });
});
