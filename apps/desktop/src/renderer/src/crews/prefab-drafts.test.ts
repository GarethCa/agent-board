// The drafts agents made, as Settings lists them and the board opens them: kept current as agents draft and the user
// deletes, and opened unsaved, saving as new, with what the drafter assumed.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrefabDraft, PrefabDraftAddedEvent, PrefabDraftRemovedEvent } from '@agent-board/daemon/protocol';
import { PrefabDraftNote } from './PrefabDraftNote';

const draft = (id: string, name = 'Morning tickets'): PrefabDraft => ({
  id,
  prefab: { version: 2, name, icon: 'ticket', purpose: '', members: [{ id: 'triager', harness: 'claude', model: 'sonnet', starts: 'prompt' }] } as unknown as PrefabDraft['prefab'],
  assumptions: [{ text: 'The loop gate stops at 5 rounds: you didn’t give a number.', about: 'triager' }],
  drafter: { tileId: 'session-1', name: 'Captain' },
  closesDrafter: false,
  createdAt: '2026-11-18 09:00:00',
});

describe('the prefab drafts store', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.unstubAllGlobals());

  it('reads the drafts once, then follows agents drafting and the user deleting', async () => {
    let tell: (event: PrefabDraftAddedEvent | PrefabDraftRemovedEvent) => void = () => undefined;
    const drafts = vi.fn().mockResolvedValue({ drafts: [draft('draft:a')], unreadable: [{ id: 'draft:old', reason: 'a later release' }] });
    const onDraft = vi.fn((listener: typeof tell) => {
      tell = listener;
      return () => undefined;
    });
    vi.stubGlobal('window', { agentBoard: { orchestrators: { drafts, onDraft } } });
    const { currentDrafts, followDrafts } = await import('./prefab-drafts');
    const changed = vi.fn();
    followDrafts(changed);
    followDrafts(() => undefined);
    await vi.waitFor(() => expect(currentDrafts().drafts.map((each) => each.id)).toEqual(['draft:a']));
    expect(drafts).toHaveBeenCalledTimes(1);
    expect(currentDrafts().unreadable).toEqual(['draft:old']);
    tell({ type: 'prefabDraft.removed', id: 'draft:old' });
    expect(currentDrafts().unreadable).toEqual([]);

    tell({ type: 'prefabDraft.added', draft: draft('draft:b', 'Nightly sweep') });
    expect(currentDrafts().drafts.map((each) => each.id)).toEqual(['draft:a', 'draft:b']);
    tell({ type: 'prefabDraft.removed', id: 'draft:a' });
    expect(currentDrafts().drafts.map((each) => each.id)).toEqual(['draft:b']);
    expect(changed).toHaveBeenCalledTimes(4);
    expect(onDraft).toHaveBeenCalledTimes(1);
  });

  it('opens a draft unsaved, saving as new, with its drafter and what it assumed', async () => {
    const openDraft = vi.fn().mockResolvedValue(draft('draft:a'));
    vi.stubGlobal('window', { agentBoard: { orchestrators: { openDraft } } });
    const { openDraft: open, draftedMessage } = await import('./prefab-drafts');
    const start = await open('draft:a');
    expect(openDraft).toHaveBeenCalledWith('draft:a');
    expect(start).toMatchObject({ replaces: null, prefab: { name: 'Morning tickets' }, draft: { id: 'draft:a', drafter: 'Captain', assumptions: [{ about: 'triager' }] } });
    expect(draftedMessage(draft('draft:a'))).toBe('Captain drafted “Morning tickets”');
  });
});

describe('a draft’s note on its board', () => {
  it('says it is not saved yet, offers Save to library, and lists what the drafter assumed', () => {
    const html = renderToStaticMarkup(
      createElement(PrefabDraftNote, {
        assumptions: [
          { text: 'The triager takes each job as it comes.', about: 'triager' },
          { text: 'It runs on weekdays only.', about: null },
        ],
        drafter: 'Captain',
        onSave: () => undefined,
        onPick: () => undefined,
      }),
    );
    expect(html).toContain('A draft · not saved yet');
    expect(html).toContain('Save to library');
    expect(html).toContain('What Captain assumed');
    // One about a thing on the board is a button that selects it; one about nothing in particular is only said.
    expect(html.match(/<button type="button" class="prefab-draft-assumption"/g)).toHaveLength(1);
    expect(html).toContain('It runs on weekdays only.');
  });

  it('says what it will start, with Start, Edit and Discard, Save to library beside them', () => {
    const summary = { agents: [{ id: 'm1', name: 'Builder', role: 'Builder', model: 'Claude · opus · high' }], inputs: ['Your prompt'], lines: ['Your prompt starts Builder.'] };
    const html = renderToStaticMarkup(createElement(PrefabDraftNote, { assumptions: [], drafter: 'Captain', summary, onSave: () => undefined, onStart: () => undefined, onDiscard: () => undefined, onPick: () => undefined }));
    expect(html).toContain('What it will start');
    expect(html).toContain('Builder · Claude · opus · high');
    expect(html).toContain('Your prompt starts Builder.');
    for (const id of ['prefab-draft-start', 'prefab-draft-edit', 'prefab-draft-discard', 'prefab-draft-save']) expect(html).toContain(`data-testid="${id}"`);
    // Discard asks first, so nothing is deleted on one click.
    expect(html).not.toContain('Discard it for good?');
  });

  it('shows no list when the drafter assumed nothing', () => {
    const html = renderToStaticMarkup(createElement(PrefabDraftNote, { assumptions: [], drafter: 'Captain', onSave: () => undefined, onPick: () => undefined }));
    expect(html).not.toContain('assumed');
  });
});
