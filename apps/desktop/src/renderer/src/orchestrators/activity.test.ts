import { describe, expect, it } from 'vitest';
import type { OrchestratorActivity } from '@agent-board/daemon/protocol';
import { DEFAULT_ACTIVITY_LIMIT } from '@agent-board/daemon/protocol';
import { activityText, mayHaveOlder, withLogged, withOlder } from './activity';

const line = (fields: Partial<OrchestratorActivity>): OrchestratorActivity => ({
  id: 1,
  at: '2026-10-13T01:12:00.000Z',
  orchestratorId: 'lead',
  orchestratorName: 'Ship M2.5',
  action: 'spawn',
  targetId: 'w1',
  targetName: 'web impl',
  detail: 'claude in web: Implement the zone switch',
  outcome: 'done',
  reason: null,
  ...fields,
});

describe('activityText', () => {
  it('says what it did to whom, as the mock does', () => {
    expect(activityText(line({}))).toBe('started web impl');
    expect(activityText(line({ action: 'send' }))).toBe('sent web impl');
    expect(activityText(line({ action: 'interrupt' }))).toBe('interrupted web impl');
    expect(activityText(line({ action: 'close' }))).toBe('closed web impl');
    expect(activityText(line({ action: 'remove' }))).toBe('removed web impl');
    expect(activityText(line({ action: 'add-edge' }))).toBe('added an edge into web impl');
    expect(activityText(line({ action: 'remove-edge' }))).toBe('removed an edge into web impl');
    expect(activityText(line({ action: 'handoff' }))).toBe('handed off to web impl');
  });

  it('says what it tried when refused, and names no one when there was no one', () => {
    expect(activityText(line({ outcome: 'refused', reason: 'outside its zone' }))).toBe('tried to start web impl');
    expect(activityText(line({ outcome: 'refused', targetId: null, targetName: null }))).toBe('tried to start an agent');
  });
});

describe('withLogged', () => {
  it("puts the orchestrator's new line first, once, and leaves out other orchestrators'", () => {
    const listed = [line({ id: 2 }), line({ id: 1 })];
    expect(withLogged(listed, 'lead', line({ id: 3 })).map((entry) => entry.id)).toEqual([3, 2, 1]);
    expect(withLogged(listed, 'lead', line({ id: 2 }))).toBe(listed);
    expect(withLogged(listed, 'lead', line({ id: 4, orchestratorId: 'other' }))).toBe(listed);
  });
});

describe('withOlder', () => {
  it('adds a page of older lines after those read, each once, and says a full page may have more', () => {
    const read = [line({ id: 5 }), line({ id: 4 })];
    expect(withOlder(read, [line({ id: 4 }), line({ id: 3 })]).map((entry) => entry.id)).toEqual([5, 4, 3]);
    expect(mayHaveOlder(DEFAULT_ACTIVITY_LIMIT)).toBe(true);
    expect(mayHaveOlder(DEFAULT_ACTIVITY_LIMIT - 1)).toBe(false);
  });
});
