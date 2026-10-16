import { describe, expect, it, vi } from 'vitest';
import { createDeliveries, type DeliveryRow } from '../src/deliveries.ts';
import { invalidParams } from '../src/params.ts';
import type { RunStart } from '../src/schedules.ts';

interface Row extends DeliveryRow {
  session_id: string;
}

const row = (sessionId: string, fields: Partial<Row> = {}): Row => ({
  session_id: sessionId,
  name: sessionId,
  ended_at: null,
  harness_session_id: null,
  ...fields,
});

/** Deliveries over the agents `rows`, recording what is written, relaunched and announced. */
function setup(rows: Row[], notReady?: string) {
  const writes: [string, string][] = [];
  const relaunches: { sessionId: string; prompt: string | undefined; why: string; codexSessionId: string | null | undefined }[] = [];
  const announced: { sessionId: string; handingOff: boolean }[] = [];
  const byId = new Map(rows.map((each) => [each.session_id, each]));
  const deliveries = createDeliveries<Row>({
    write: (sessionId, data) => void writes.push([sessionId, data]),
    getRow: (sessionId) => byId.get(sessionId),
    requireAgent(sessionId) {
      const found = byId.get(sessionId);
      if (found === undefined) throw invalidParams(`no agent ${sessionId}`);
      return { name: found.name, endedAt: found.ended_at, state: 'idle' };
    },
    whyNotReady: () => notReady,
    relaunch(target, prompt, why, codexSessionId): RunStart {
      relaunches.push({ sessionId: target.session_id, prompt, why, codexSessionId });
      return { started: true };
    },
    announce: (sessionId) => void announced.push({ sessionId, handingOff: deliveries.isHandingOff(sessionId) }),
    log: () => {},
  });
  return { deliveries, writes, relaunches, announced };
}

describe('deliveries', () => {
  it("types a hand-off at a live agent's prompt and submits it, showing the sender handing off until it lands", async () => {
    const { deliveries, writes, announced } = setup([row('from', { name: 'planner' }), row('to')]);
    expect(await deliveries.deliver('from', 'to', 'plan', 'the plan')).toEqual({ started: true });
    expect(writes.map(([sessionId]) => sessionId)).toEqual(['to', 'to']);
    expect(writes[0]![1]).toContain('the plan');
    expect(writes[1]![1]).toBe('\r');
    expect(announced).toEqual([
      { sessionId: 'from', handingOff: true },
      { sessionId: 'from', handingOff: false },
    ]);
  });

  it('relaunches an ended agent with the hand-off, carrying on its Codex conversation', async () => {
    const { deliveries, writes, relaunches } = setup([row('from'), row('to', { ended_at: '2026-10-15T10:00:00Z', harness_session_id: 'conv' })]);
    expect(await deliveries.deliver('from', 'to', 'plan', 'the plan')).toEqual({ started: true });
    expect(writes).toEqual([]);
    expect(relaunches).toEqual([{ sessionId: 'to', prompt: expect.stringContaining('the plan'), why: 'for a hand-off from from', codexSessionId: 'conv' }]);
  });

  it('holds a hand-off back as busy while the live agent is not ready', async () => {
    const { deliveries, writes } = setup([row('from'), row('to')], 'it was still working');
    expect(await deliveries.deliver('from', 'to', 'plan', 'the plan')).toEqual({ started: false, reason: 'it was still working', busy: true });
    expect(writes).toEqual([]);
  });

  it("forgets a deleted sender's hand-offs still landing", async () => {
    const { deliveries } = setup([row('from'), row('to')]);
    const delivered = deliveries.deliver('from', 'to', 'plan', 'the plan');
    expect(deliveries.isHandingOff('from')).toBe(true);
    deliveries.forget('from');
    expect(deliveries.isHandingOff('from')).toBe(false);
    await delivered;
    expect(deliveries.isHandingOff('from')).toBe(false);
  });

  it("types a scheduled run at a ready agent's prompt as one line, and submits it", async () => {
    const { deliveries, writes } = setup([row('a')]);
    expect(deliveries.runScheduled('a', 'Check the build\n\n  then the tests')).toEqual({ started: true });
    await vi.waitFor(() => expect(writes).toEqual([['a', 'Check the build then the tests'], ['a', '\r']]));
  });

  it('relaunches an ended agent for its scheduled run', () => {
    const { deliveries, writes, relaunches } = setup([row('a', { ended_at: '2026-10-15T10:00:00Z', harness_session_id: 'conv' })]);
    expect(deliveries.runScheduled('a', 'run')).toEqual({ started: true });
    expect(relaunches).toEqual([{ sessionId: 'a', prompt: 'run', why: 'for its scheduled run', codexSessionId: undefined }]);
    expect(writes).toEqual([]);
  });

  it('tells why a scheduled run is not started in an agent not ready, or deleted', () => {
    expect(setup([row('a')], 'it was waiting for you').deliveries.runScheduled('a', 'run')).toEqual({ started: false, reason: 'it was waiting for you' });
    expect(setup([]).deliveries.runScheduled('a', 'run')).toEqual({ started: false, reason: 'the agent has been deleted' });
  });

  it('types an answer after the one still landing, never into it', async () => {
    const { deliveries, writes } = setup([row('a')]);
    await Promise.all([deliveries.answer('a', 'one'), deliveries.answer('a', 'two')]);
    expect(writes.map(([, data]) => data)).toEqual(['one', '\r', 'two', '\r']);
  });
});
