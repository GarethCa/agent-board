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
    expect(activityText(line({ action: 'continue' }))).toBe('continued web impl on credits');
    expect(activityText(line({ action: 'continue', outcome: 'refused' }))).toBe('tried to continue web impl on credits');
    expect(activityText(line({ action: 'restart' }))).toBe('restarted web impl');
    expect(activityText(line({ action: 'close' }))).toBe('closed web impl');
    expect(activityText(line({ action: 'remove' }))).toBe('removed web impl');
    expect(activityText(line({ action: 'add-edge' }))).toBe('added an edge into web impl');
    expect(activityText(line({ action: 'remove-edge' }))).toBe('removed an edge into web impl');
    expect(activityText(line({ action: 'handoff' }))).toBe('handed off to web impl');
  });

  it('says what it laid out: the tile it moved, the zone it arranged, the group or note it made, changed or removed', () => {
    expect(activityText(line({ action: 'move' }))).toBe('moved web impl');
    expect(activityText(line({ action: 'arrange', targetName: 'web' }))).toBe('arranged web');
    expect(activityText(line({ action: 'add-zone', targetName: 'Review' }))).toBe('made the group Review');
    expect(activityText(line({ action: 'change-zone', targetName: 'Review' }))).toBe('changed the group Review');
    expect(activityText(line({ action: 'remove-zone', targetName: 'Review' }))).toBe('removed the group Review');
    expect(activityText(line({ action: 'add-note', targetName: 'note “Ship it”' }))).toBe('added note “Ship it”');
    expect(activityText(line({ action: 'edit-note', targetName: 'note “Ship it”' }))).toBe('edited note “Ship it”');
    expect(activityText(line({ action: 'remove-note', targetName: 'note “Ship it”' }))).toBe('removed note “Ship it”');
  });

  it('says what it drew: the shapes it added, changed or removed, and the connectors it made between two of them', () => {
    expect(activityText(line({ action: 'add-shape', targetName: 'shape “Order”' }))).toBe('drew shape “Order”');
    expect(activityText(line({ action: 'edit-shape', targetName: 'shape “Order”' }))).toBe('edited shape “Order”');
    expect(activityText(line({ action: 'remove-shape', targetName: 'shape “Order”' }))).toBe('removed shape “Order”');
    expect(activityText(line({ action: 'connect', targetName: 'shape “Circle” → shape “Shape”' }))).toBe('connected shape “Circle” → shape “Shape”');
    expect(activityText(line({ action: 'edit-connector', targetName: 'connector “holds”' }))).toBe('edited connector “holds”');
    expect(activityText(line({ action: 'edit-connector', targetName: 'a connector' }))).toBe('edited a connector');
    expect(activityText(line({ action: 'remove-connector', targetName: 'connector “holds”' }))).toBe('removed connector “holds”');
    for (const [action, tried] of [
      ['add-shape', 'tried to draw a shape'],
      ['edit-shape', 'tried to edit a shape'],
      ['remove-shape', 'tried to remove a shape'],
      ['connect', 'tried to connect two items'],
      ['edit-connector', 'tried to edit a connector'],
      ['remove-connector', 'tried to remove a connector'],
    ] as const) {
      expect(activityText(line({ action, outcome: 'refused', targetName: null }))).toBe(tried);
    }
  });

  it('says which of the app’s default roles it set or removed', () => {
    expect(activityText(line({ action: 'set-role', targetName: 'designer' }))).toBe('set the default role designer');
    expect(activityText(line({ action: 'remove-role', targetName: 'designer' }))).toBe('removed the default role designer');
    expect(activityText(line({ action: 'set-role', outcome: 'refused', targetName: null }))).toBe('tried to set a default role');
  });

  it('says what it tried when refused, and names no one when there was no one', () => {
    expect(activityText(line({ outcome: 'refused', reason: 'outside its zone' }))).toBe('tried to start web impl');
    expect(activityText(line({ outcome: 'refused', targetId: null, targetName: null }))).toBe('tried to start an agent');
    expect(activityText(line({ action: 'move', outcome: 'refused', targetName: null }))).toBe('tried to move a tile');
    expect(activityText(line({ action: 'add-zone', outcome: 'refused', targetName: null }))).toBe('tried to make a group');
    expect(activityText(line({ action: 'remove-note', outcome: 'refused', targetName: null }))).toBe('tried to remove a note');
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
