// A drafted crew, as the user finds and reviews it: its row in Needs you, its place first in the crew library, and what
// it will start, said plainly.
import { describe, expect, it } from 'vitest';
import type { CrewPrefab, PrefabDraft } from '@agent-board/daemon/protocol';
import { draftedBy, draftNeedsYou, draftSummary, draftsToReview } from './draft-review';

const pair = (): CrewPrefab =>
  ({
    version: 2,
    name: 'Pair',
    icon: 'ticket',
    purpose: 'Builds a change and reviews it',
    roundLimit: 2,
    members: [
      { id: 'impl', role: 'implementer', name: null, harness: 'claude', model: 'opus', effort: 'high', template: null, starts: 'prompt' },
      { id: 'review', role: 'reviewer', name: 'Code review', harness: 'codex', model: null, effort: null, template: null, starts: 'handoff' },
    ],
  }) as unknown as CrewPrefab;

const draft = (id: string, name: string, createdAt: string, drafter = 'Captain'): PrefabDraft => ({
  id,
  prefab: { ...pair(), name },
  assumptions: [],
  drafter: { tileId: 'session-1', name: drafter },
  closesDrafter: false,
  createdAt,
});

describe('a drafted crew in Needs you', () => {
  it('says who drafted which crew', () => {
    expect(draftNeedsYou(draft('draft:a', 'Morning tickets', '2026-11-18T09:00:00.000Z')).text).toBe('Captain drafted a crew: Morning tickets');
  });
});

describe('the drafts the crew library lists first', () => {
  it('lists the newest first, each with who drafted it and when', () => {
    const now = Date.parse('2026-11-18T10:00:00.000Z');
    const drafts = [draft('draft:a', 'Old', '2026-11-18T07:00:00.000Z'), draft('draft:b', 'New', '2026-11-18T09:56:00.000Z', 'Scout')];
    expect(draftsToReview(drafts).map((each) => each.prefab.name)).toEqual(['New', 'Old']);
    expect(draftedBy(drafts[1]!, now)).toBe('Drafted by Scout · 4 min ago');
    expect(draftedBy(drafts[0]!, now)).toBe('Drafted by Captain · 3 h ago');
  });

  it('keeps the order it was given for drafts made at the same moment, and leaves the list it was given alone', () => {
    const drafts = [draft('draft:a', 'A', '2026-11-18T09:00:00.000Z'), draft('draft:b', 'B', '2026-11-18T09:00:00.000Z')];
    expect(draftsToReview(drafts).map((each) => each.id)).toEqual(['draft:a', 'draft:b']);
    expect(drafts.map((each) => each.id)).toEqual(['draft:a', 'draft:b']);
  });
});

describe('what a draft will start', () => {
  it('names its agents with their roles and models, its inputs, and its lines in words', () => {
    const summary = draftSummary(pair());
    expect(summary.agents).toEqual([
      { id: 'impl', name: 'Impl', role: 'Builder', model: 'Claude · opus · high' },
      { id: 'review', name: 'Code review', role: 'Reviewer', model: 'Codex · its defaults' },
    ]);
    expect(summary.inputs).toEqual(expect.arrayContaining(['Your prompt']));
    expect(summary.lines).toEqual(expect.arrayContaining(['Your prompt starts Impl.']));
    expect(summary.lines.length).toBeGreaterThan(1);
  });

  it('says a role of its own as it was typed, and a member with none as an agent', () => {
    const prefab = pair();
    prefab.members[0] = { ...prefab.members[0]!, role: 'designer' };
    prefab.members[1] = { ...prefab.members[1]!, role: null } as never;
    expect(draftSummary(prefab).agents.map((each) => each.role)).toEqual(['designer', 'Agent']);
  });
});
