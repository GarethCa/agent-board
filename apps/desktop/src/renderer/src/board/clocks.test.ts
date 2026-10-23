import { afterAll, describe, expect, it } from 'vitest';
import type { BoardItem, ClockData, ClockRun, ClockStatus } from '@agent-board/daemon/protocol';
import { clockCard, clockData, clockTethers, presetCron, runningAgent } from './clocks';
import { itemNode } from './items/items';
import { tileNodeId } from './tiles';

const savedTz = process.env.TZ;
process.env.TZ = 'Europe/London';
afterAll(() => {
  if (savedTz === undefined) delete process.env.TZ;
  else process.env.TZ = savedTz;
});

/** Saturday 10 October 2026, 07:30 local time. */
const NOW = new Date(2026, 9, 10, 7, 30);

const data = (fields: Partial<ClockData> = {}): ClockData => ({ ...clockData({}), prompt: 'Check the deps', agent: 'a', ...fields });

const run = (outcome: ClockRun['outcome'], fields: Partial<ClockRun> = {}): ClockRun => ({
  id: 1,
  dueAt: '',
  firedAt: '',
  outcome,
  reason: null,
  sessionId: null,
  agentName: null,
  finishedAt: null,
  result: null,
  ...fields,
});

const status = (fields: Partial<ClockStatus> = {}): ClockStatus => ({ id: 'c', nextRunAt: new Date(2026, 9, 10, 9).toISOString(), runs: [], ...fields });

const names: Record<string, string> = { a: 'Nightly deps check' };
const nameOf = (sessionId: string) => names[sessionId];

describe('clockData', () => {
  it('fills in what is missing as a new clock has it', () => {
    expect(clockData({ cron: '@hourly', agent: 'a' })).toEqual({
      cron: '@hourly',
      enabled: true,
      does: 'message',
      agent: 'a',
      prompt: '',
      fresh: { harness: 'claude', model: null, role: null, closeWhenDone: true },
      result: 'history',
      handoffTo: null,
      folded: false,
    });
  });
});

describe('clockCard', () => {
  it('says the schedule in words, the agent it messages and its next run', () => {
    expect(clockCard(data({ cron: '0 9 * * 1-5' }), status(), nameOf, NOW)).toEqual({
      words: 'Weekdays 09:00',
      detail: '→ Nightly deps check · next 09:00',
      soon: 'in 1h 30m',
      runs: [],
      running: false,
    });
  });

  it('says a fresh agent is running, and marks its last ten runs oldest first', () => {
    const runs = [run('running'), run('done'), run('failed'), run('skipped'), ...Array.from({ length: 10 }, () => run('started'))];
    const card = clockCard(data({ does: 'fresh', agent: null, fresh: { harness: 'claude', model: null, role: 'implementer', closeWhenDone: true } }), status({ runs }), nameOf, NOW);
    expect(card).toMatchObject({ detail: '✦ fresh implementer · running', soon: 'running', running: true });
    expect(card.runs).toEqual(['ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'skip', 'fail', 'ok', 'run']);
  });

  it("says what it lacks while it can't fire, and when it is off", () => {
    expect(clockCard(data({ prompt: '' }), status({ nextRunAt: null }), nameOf, NOW)).toMatchObject({ detail: 'not set: nothing to send', soon: 'not set' });
    expect(clockCard(data({ agent: null }), status({ nextRunAt: null }), nameOf, NOW)).toMatchObject({ detail: 'not set: join it to an agent', soon: 'not set' });
    expect(clockCard(data({ agent: 'gone' }), status(), nameOf, NOW)).toMatchObject({ detail: '→ an agent no longer here · next 09:00' });
    expect(clockCard(data({ enabled: false }), status({ nextRunAt: null }), nameOf, NOW)).toMatchObject({ detail: '→ Nightly deps check · off', soon: 'off' });
  });

  it('says a run further off than a day by its day', () => {
    const card = clockCard(data({ cron: '0 2 * * 0' }), status({ nextRunAt: new Date(2026, 9, 11, 2).toISOString() }), nameOf, NOW);
    expect(card).toMatchObject({ words: 'Sundays 02:00', soon: 'in 18h 30m' });
    expect(clockCard(data(), status({ nextRunAt: new Date(2026, 9, 14, 9).toISOString() }), nameOf, NOW).soon).toBe('Wed 09:00');
  });
});

describe('clockTethers', () => {
  const clock = (id: string, fields: Partial<ClockData>): BoardItem => ({
    id,
    kind: 'clock',
    zoneId: null,
    x: 0,
    y: 0,
    width: 256,
    height: 76,
    z: 1,
    rotation: 0,
    data: { ...data(fields) },
    createdAt: '',
    updatedAt: '',
  });
  const tile = (sessionId: string) => ({ id: tileNodeId('agent', sessionId), position: { x: 0, y: 0 }, data: {} });

  it('joins a clock to the agent it messages, and to the fresh agent its run started, while their tiles are on the board', () => {
    const nodes = [itemNode(clock('m', { agent: 'a' })), itemNode(clock('f', { does: 'fresh', agent: null })), itemNode(clock('lost', { agent: 'gone' })), tile('a'), tile('fresh-1')];
    const statuses = new Map([['f', status({ id: 'f', runs: [run('running', { sessionId: 'fresh-1' })] })]]);
    expect(clockTethers(nodes, statuses).map((edge) => [edge.source, edge.target])).toEqual([
      ['item:m', tileNodeId('agent', 'a')],
      ['item:f', tileNodeId('agent', 'fresh-1')],
    ]);
    expect(runningAgent(statuses.get('f'))).toBe('fresh-1');
  });
});

describe('presetCron', () => {
  it("keeps the time the expression fires at, else nine o'clock", () => {
    expect(presetCron('weekdays', '30 7 * * *')).toBe('30 7 * * 1-5');
    expect(presetCron('daily', '0 9 * * 1-5')).toBe('0 9 * * *');
    expect(presetCron('weekly', '15 18 * * *')).toBe('15 18 * * 1');
    expect(presetCron('hourly', '15 18 * * *')).toBe('0 * * * *');
    expect(presetCron('daily', '*/5 * * * *')).toBe('0 9 * * *');
    expect(presetCron('daily', 'nonsense')).toBe('0 9 * * *');
  });
});
