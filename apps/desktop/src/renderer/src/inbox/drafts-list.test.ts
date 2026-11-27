import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { PrefabDraft } from '@agent-board/daemon/protocol';

const waiting: { drafts: PrefabDraft[] } = { drafts: [] };
vi.mock('../crews/prefab-drafts', () => ({ usePrefabDrafts: () => ({ drafts: waiting.drafts, unreadable: [], failed: false }) }));

const { Inbox } = await import('./Inbox');
const { GroupedInbox } = await import('./GroupedInbox');

const draft = (id: string, name: string, createdAt: string): PrefabDraft => ({
  id,
  prefab: { agentBoardCrewPrefab: 1, name, purpose: '', members: [], edges: [], inputs: [] } as unknown as PrefabDraft['prefab'],
  assumptions: [],
  drafter: { tileId: 'session-1', name: 'Captain' },
  closesDrafter: false,
  createdAt,
});

const classic = () => renderToStaticMarkup(createElement(Inbox, { agents: [], onOpen: () => undefined }));
const grouped = () => renderToStaticMarkup(createElement(GroupedInbox, { agents: [], zones: [], onOpen: () => undefined }));

describe('drafts in Needs you', () => {
  it('lists each draft, newest first, with who drafted which crew and Open, in either design', () => {
    waiting.drafts = [draft('draft:a', 'Morning tickets', '2026-11-27T08:00:00.000Z'), draft('draft:b', 'Nightly sweep', '2026-11-27T09:00:00.000Z')];
    for (const html of [classic(), grouped()]) {
      expect(html).toContain('data-section="drafts"');
      expect(html.indexOf('Captain drafted a crew: Nightly sweep')).toBeLessThan(html.indexOf('Captain drafted a crew: Morning tickets'));
      expect(html).toContain('aria-label="Open Morning tickets"');
      expect(html).toContain('Drafted by Captain');
    }
  });

  it('never says nothing needs you while a draft waits, and says so once none does', () => {
    waiting.drafts = [draft('draft:a', 'Morning tickets', '2026-11-27T08:00:00.000Z')];
    expect(classic()).not.toContain('Nothing needs you.');
    expect(grouped()).not.toContain('Nothing needs you.');
    waiting.drafts = [];
    expect(classic()).toContain('Nothing needs you.');
    expect(classic()).not.toContain('data-section="drafts"');
    expect(grouped()).toContain('Nothing needs you.');
  });
});
