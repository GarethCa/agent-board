import { describe, expect, it, vi } from 'vitest';
import { setExtendedShortcuts } from '../keys/extended-shortcuts';
import { appKeysReach, boardKey, boardShortcut, escapeCollapsesFront, quickInsertAt, SESSION_SURFACES } from './board-shortcuts';

const press = (key: string, keys: Partial<Record<'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'repeat', boolean>> = {}) => ({
  key,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  repeat: false,
  ...keys,
});

describe("the board's single-key shortcuts", () => {
  it('add a note with N, either case', () => {
    expect(boardShortcut(press('n'))).toEqual({ kind: 'note' });
    expect(boardShortcut(press('N', { shiftKey: true }))).toEqual({ kind: 'note' });
  });

  it('arm the text, shape, zone, agent and shell tools with T, S, Z, A and `', () => {
    expect(boardShortcut(press('t'))).toEqual({ kind: 'tool', tool: 'text' });
    expect(boardShortcut(press('S', { shiftKey: true }))).toEqual({ kind: 'tool', tool: 'shape' });
    expect(boardShortcut(press('z'))).toEqual({ kind: 'tool', tool: 'zone' });
    expect(boardShortcut(press('a'))).toEqual({ kind: 'tool', tool: 'agent' });
    expect(boardShortcut(press('`'))).toEqual({ kind: 'tool', tool: 'shell' });
  });

  it('cycle the connections with ⇧E, and leave a bare E alone', () => {
    expect(boardShortcut(press('E', { shiftKey: true }))).toEqual({ kind: 'connections' });
    expect(boardShortcut(press('e'))).toBeUndefined();
    expect(boardShortcut(press('E', { shiftKey: true, metaKey: true }))).toBeUndefined();
  });

  it('leave ⇧C and a bare C alone: a crew has no look to cycle', () => {
    expect(boardShortcut(press('C', { shiftKey: true }))).toBeUndefined();
    expect(boardShortcut(press('c'))).toBeUndefined();
  });

  it('open the shape palette with /, typed shifted or not, but not with a modifier or as it repeats', () => {
    expect(boardShortcut(press('/'))).toEqual({ kind: 'insert' });
    // On a keyboard where / is ⇧7.
    expect(boardShortcut(press('/', { shiftKey: true }))).toEqual({ kind: 'insert' });
    expect(boardShortcut(press('/', { metaKey: true }))).toBeUndefined();
    expect(boardShortcut(press('/', { repeat: true }))).toBeUndefined();
  });

  it('open the cheat sheet with ?, only while the extended keys are on', () => {
    vi.stubGlobal('window', { agentBoard: { view: { set: async () => {} } } });
    try {
      expect(boardShortcut(press('?', { shiftKey: true }))).toEqual({ kind: 'cheatSheet' });
      setExtendedShortcuts(false);
      expect(boardShortcut(press('?', { shiftKey: true }))).toBeUndefined();
      expect(boardShortcut(press('n'))).toEqual({ kind: 'note' });
    } finally {
      setExtendedShortcuts(true);
      vi.unstubAllGlobals();
    }
  });

  it('arrange the board with ⇧L, not L alone, only while the extended keys are on', () => {
    vi.stubGlobal('window', { agentBoard: { view: { set: async () => {} } } });
    try {
      expect(boardShortcut(press('L', { shiftKey: true }))).toEqual({ kind: 'arrangeBoard' });
      expect(boardShortcut(press('l'))).toBeUndefined();
      setExtendedShortcuts(false);
      expect(boardShortcut(press('L', { shiftKey: true }))).toBeUndefined();
    } finally {
      setExtendedShortcuts(true);
      vi.unstubAllGlobals();
    }
  });

  it('pick select with V, box select with B and the hand with H', () => {
    expect(boardShortcut(press('v'))).toEqual({ kind: 'mode', mode: 'select' });
    expect(boardShortcut(press('b'))).toEqual({ kind: 'mode', mode: 'box' });
    expect(boardShortcut(press('H', { shiftKey: true }))).toEqual({ kind: 'mode', mode: 'hand' });
  });

  it('tell Escape apart, for the board to put a tool down or collapse a tile', () => {
    expect(boardShortcut(press('Escape'))).toEqual({ kind: 'escape' });
  });

  it('leave a key with ⌘, Ctrl or ⌥ held, or held down, to someone else', () => {
    for (const held of ['metaKey', 'ctrlKey', 'altKey', 'repeat'] as const) {
      expect(boardShortcut(press('n', { [held]: true }))).toBeUndefined();
      expect(boardShortcut(press('Escape', { [held]: true }))).toBeUndefined();
    }
  });

  it('are none for any other key', () => {
    for (const key of ['r', 'Enter', 'F2', ']', 'Backspace', 'toString', 'constructor']) expect(boardShortcut(press(key))).toBeUndefined();
  });
});

describe('/ and the palette', () => {
  const typedIn = (tagName: string, isContentEditable = false) => ({ ...press('/'), target: { tagName, isContentEditable } as unknown as EventTarget });

  it('is a / typed into text: a note, a shape or the picker, or a terminal (its xterm textarea)', () => {
    expect(boardKey(typedIn('TEXTAREA'))).toBeUndefined();
    expect(boardKey(typedIn('INPUT'))).toBeUndefined();
    expect(boardKey(typedIn('DIV', true))).toBeUndefined();
    expect(boardKey(typedIn('BODY'))).toEqual({ kind: 'insert' });
  });

  it('opens at the pointer, or in the middle of the board when the pointer is off it', () => {
    const board = { x: 100, y: 50, width: 800, height: 600 };
    expect(quickInsertAt({ x: 300, y: 200 }, board)).toEqual({ x: 300, y: 200 });
    expect(quickInsertAt(undefined, board)).toEqual({ x: 500, y: 350 });
  });
});

/** An element with the focus: its tag, and the selectors it is inside. */
const focused = (tagName: string, inside: string[] = []) => ({ tagName, closest: (selector: string) => (inside.includes(selector) ? {} : null) }) as unknown as Element;

describe('Esc collapsing the expanded tile in front', () => {
  it('does with the focus on nothing, the page or the board, a tile on it too; not off the board', () => {
    expect(escapeCollapsesFront(null, undefined)).toBe(true);
    expect(escapeCollapsesFront(focused('BODY'), undefined)).toBe(true);
    expect(escapeCollapsesFront(focused('DIV', ['.react-flow']), undefined)).toBe(true);
    expect(escapeCollapsesFront(focused('BUTTON'), undefined)).toBe(false);
  });

  it('does not with the focus on the tile ⌘K flew to, away from the expanded one; on another, it does', () => {
    const picked = focused('DIV', ['.react-flow']);
    expect(escapeCollapsesFront(picked, picked)).toBe(false);
    expect(escapeCollapsesFront(focused('DIV', ['.react-flow']), picked)).toBe(true);
  });
});

describe('where ⌘K, ⌘/ and ⌘⇧P reach', () => {
  /** The focus inside elements matched by these selectors, as `closest` sees it. */
  const found = {} as Element;
  const focusIn = (...within: string[]) => ({ closest: (selectors: string) => (selectors.split(',').some((one) => within.includes(one.trim())) ? found : null) });

  it('reaches the board, and anything that is not a dialog or a menu', () => {
    expect(appKeysReach(null)).toBe(true);
    expect(appKeysReach(focusIn())).toBe(true);
    expect(appKeysReach(focusIn('.expanded-tile'))).toBe(true);
  });

  it('reaches every view an agent is open in, though each is a dialog: the pop-up, and a session window', () => {
    expect(appKeysReach(focusIn('[role="dialog"]', '[data-testid="agent-popup"]'))).toBe(true);
    expect(appKeysReach(focusIn('[role="dialog"]', '[data-testid="session-window"]'))).toBe(true);
  });

  it('leaves any other dialog or menu its keys', () => {
    expect(appKeysReach(focusIn('[role="dialog"]'))).toBe(false);
    expect(appKeysReach(focusIn('[role="alertdialog"]'))).toBe(false);
    expect(appKeysReach(focusIn('[role="menu"]'))).toBe(false);
  });

  it("leaves the pop-up out of where ⌫, a dropped tab and the board's blur go, which are a session window's or an expanded tile's", () => {
    expect(focusIn('[data-testid="agent-popup"]').closest(SESSION_SURFACES)).toBeNull();
  });
});
