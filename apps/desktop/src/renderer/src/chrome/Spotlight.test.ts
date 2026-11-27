import { describe, expect, it } from 'vitest';
import type { Agent } from '@agent-board/daemon/protocol';
import type { Surface } from '@agent-board/daemon/window-layout';
import { enterAsks, opensBeside, shiftOpensTile, type SpotlightPlace } from './Spotlight';
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

describe('what ↵ on a row asks for, by the keys held', () => {
  const held = (keys: Partial<Record<'metaKey' | 'ctrlKey' | 'shiftKey', boolean>> = {}) => ({ metaKey: false, ctrlKey: false, shiftKey: false, ...keys });
  const shell = { kind: 'shell', shell: { id: 'sh' } } as SpotlightSubject;
  // An agent selected on the board: a session or a pull request has one to open beside.
  const onBoard: SpotlightPlace<null> = { context: null, mode: 'show', shiftOpens: true, opensBeside: () => true };
  const inView: SpotlightPlace<null> = { context: null, mode: 'switch' };

  it('on the board, ↵ shows the tile picked, and ⇧↵ opens its view, as ⌘↵ does', () => {
    for (const subject of [agent, shell]) {
      expect(enterAsks(subject, onBoard, held())).toEqual({ open: false, beside: false });
      expect(enterAsks(subject, onBoard, held({ shiftKey: true }))).toEqual({ open: true, beside: false });
      expect(enterAsks(subject, onBoard, held({ metaKey: true }))).toEqual({ open: true, beside: false });
      expect(opensBeside(subject, onBoard)).toBe(false);
    }
  });

  it('on the board, a tile row says ⇧↵ opens it; a pull request, a page, or a row in a view does not', () => {
    expect(shiftOpensTile(agent, onBoard)).toBe(true);
    expect(shiftOpensTile(shell, onBoard)).toBe(true);
    expect(shiftOpensTile(pr, onBoard)).toBe(false);
    expect(shiftOpensTile(web, onBoard)).toBe(false);
    expect(shiftOpensTile(agent, inView)).toBe(false);
    expect(shiftOpensTile(agent, undefined)).toBe(false);
  });

  it('on the board, ⇧↵ still opens a pull request or a page beside the agent selected', () => {
    expect(enterAsks(pr, onBoard, held({ shiftKey: true }))).toEqual({ open: false, beside: true });
    expect(enterAsks(web, onBoard, held({ shiftKey: true }))).toEqual({ open: false, beside: true });
  });

  it('in a view an agent is open in, ↵ opens the row there and ⇧↵ opens it beside', () => {
    expect(enterAsks(agent, inView, held())).toEqual({ open: false, beside: false });
    expect(enterAsks(agent, inView, held({ shiftKey: true }))).toEqual({ open: false, beside: true });
    expect(enterAsks(zone, inView, held({ shiftKey: true }))).toEqual({ open: false, beside: false });
  });
});
