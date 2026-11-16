import { describe, expect, it } from 'vitest';
import type { Agent } from '@agent-board/daemon/protocol';
import type { Surface } from '@agent-board/daemon/window-layout';
import { opensBeside, type SpotlightPlace } from './Spotlight';
import type { SpotlightSubject } from './spotlight-results';

const agent: SpotlightSubject = { kind: 'agent', agent: { sessionId: 'a' } as Agent };
const pr: SpotlightSubject = { kind: 'pr', pr: { repo: 'acme/app', number: 7 } } as SpotlightSubject;
const web: SpotlightSubject = { kind: 'web', url: 'https://example.com' };
const zone = { kind: 'zone', zone: { id: 'z' } } as SpotlightSubject;

describe('whether ⇧↵ opens a row beside what is open', () => {
  const inWindow: SpotlightPlace<null> = { context: null, mode: 'switch' };

  it('does for a session, a pull request or a page, in a window', () => {
    expect([agent, pr, web].map((subject) => opensBeside(subject, inWindow))).toEqual([true, true, true]);
    expect(opensBeside(zone, inWindow)).toBe(false);
  });

  it('does only where the place has something to open it beside, as the board with nothing selected has not', () => {
    const asked: Surface[] = [];
    const onBoard: SpotlightPlace<null> = {
      context: null,
      mode: 'show',
      opensBeside: (surface) => {
        asked.push(surface);
        return surface.kind === 'pr';
      },
    };
    expect([agent, pr, web].map((subject) => opensBeside(subject, onBoard))).toEqual([false, true, false]);
    expect(asked[0]).toEqual({ kind: 'session', target: { kind: 'agent', id: 'a' } });
    expect(opensBeside(zone, onBoard)).toBe(false);
  });
});
