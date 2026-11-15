import { describe, expect, it } from 'vitest';
import { BUILT_IN_PREFABS } from '@agent-board/daemon/crew-prefabs';
import type { LibraryPrefab } from '@agent-board/daemon/protocol';
import { sheetStart, ticketPresets } from './ticket-sheet';

const library = BUILT_IN_PREFABS.map((prefab): LibraryPrefab => ({ ...prefab, builtIn: true, editedAt: null }));

describe("the New ticket sheet's helpers", () => {
  it('offers the prefabs that start inside a ticket tile, the chat left out of each', () => {
    const presets = ticketPresets(library, () => 'lead');
    expect(presets.map((each) => each.name)).toEqual(['Design, build, review', 'Ticket', 'Just the chat']);
    expect(presets[0]).toMatchObject({ label: 'Design → Build → Review', detail: 'Opus high, Opus medium, Opus medium', kinds: ['design', 'build', 'review'] });
    expect(presets[1]).toMatchObject({ label: 'Build → Review', kinds: ['build', 'review'] });
    // A lead leaves the code to a builder, so even a chat alone starts one.
    expect(presets[2]).toMatchObject({ label: 'Build', kinds: ['build'] });
    expect(ticketPresets(library, () => 'implementer')[2]).toMatchObject({ label: 'Just the chat', detail: 'It starts helpers when it needs them', kinds: [] });
  });

  it('drops the builder when the chat builds, and says so', () => {
    const presets = ticketPresets(library, () => 'implementer');
    expect(presets[0]).toMatchObject({ label: 'Design → Review', kinds: ['design', 'review'], chatBuilds: true });
    expect(presets[1]).toMatchObject({ label: 'Review', kinds: ['review'] });
  });

  it("words a prefab picked as the other kind of chat by that kind, not by the prefab's own purpose", () => {
    // The Ticket prefab's chat builds; led instead, its purpose would say so of a row with a builder.
    expect(ticketPresets(library, () => 'lead')[1]!.detail).toBe('The chat leads; a builder writes the code');
    expect(ticketPresets(library, () => 'implementer')[0]!.detail).toBe('Opus high, Opus medium');
  });

  it("says each prefab's own kind of chat", () => {
    expect(ticketPresets(library, (prefab) => prefab.ticketChat!).map((each) => each.ticketChat)).toEqual(['lead', 'implementer', 'implementer']);
  });
});

describe('the New ticket sheet, as it opens', () => {
  const own = ticketPresets(library, (prefab) => prefab.ticketChat!);

  it('starts on the implementer, with the first prefab whose chat is one', () => {
    expect(sheetStart(own)).toEqual({ name: 'Ticket', kind: 'implementer' });
  });

  it('starts on the prefab asked for, as the kind of chat it says', () => {
    expect(sheetStart(own, 'design, build, review')).toEqual({ name: 'Design, build, review', kind: 'lead' });
    expect(sheetStart(own, 'nothing like it')).toEqual({ name: 'Ticket', kind: 'implementer' });
  });

  it('starts on the implementer with the first prefab when every one leads', () => {
    expect(sheetStart(own.filter((each) => each.ticketChat === 'lead'))).toEqual({ name: 'Design, build, review', kind: 'implementer' });
    expect(sheetStart([])).toEqual({ name: undefined, kind: 'implementer' });
  });
});
