import { describe, expect, it } from 'vitest';
import { prefabDraftLink, prefabDraftOfLink } from '../src/protocol.ts';

const ID = 'draft:0f8a2c1e-5b7d-4e3a-9c21-7d6e5f4a3b2c';

describe('a link that opens a prefab draft', () => {
  it('is made from the draft id and read back to it', () => {
    expect(prefabDraftLink(ID)).toBe('agent-board://draft/0f8a2c1e-5b7d-4e3a-9c21-7d6e5f4a3b2c');
    expect(prefabDraftOfLink(prefabDraftLink(ID))).toBe(ID);
    expect(prefabDraftOfLink('AGENT-BOARD://draft/0F8A2C1E-5B7D-4E3A-9C21-7D6E5F4A3B2C')).toBe(ID);
  });

  it('reads nothing else as one', () => {
    for (const url of [
      'agent-board://draft/',
      'agent-board://draft/not-a-uuid',
      'agent-board://draft/0f8a2c1e-5b7d-4e3a-9c21-7d6e5f4a3b2c/extra',
      'agent-board://draft/0f8a2c1e-5b7d-4e3a-9c21-7d6e5f4a3b2c?x=1',
      'agent-board://pair/0f8a2c1e-5b7d-4e3a-9c21-7d6e5f4a3b2c',
      'https://draft/0f8a2c1e-5b7d-4e3a-9c21-7d6e5f4a3b2c',
      'x agent-board://draft/0f8a2c1e-5b7d-4e3a-9c21-7d6e5f4a3b2c',
    ]) expect(prefabDraftOfLink(url), url).toBeUndefined();
  });
});
