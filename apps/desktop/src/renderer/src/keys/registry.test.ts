import { describe, expect, it } from 'vitest';
import { cheatSheet } from './cheat-sheet';
import { binding, chordPressed, isActive, keysText, keyText, KEYS, pressed, type KeyBinding } from './registry';

const press = (key: string, code: string, held: Partial<Record<'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey', boolean>> = {}) => ({
  key,
  code,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...held,
});

const MAC = { isMac: true, extended: true };
const OTHER = { isMac: false, extended: true };

const ids = (sections: ReturnType<typeof cheatSheet>) => sections.flatMap((section) => section.rows.map((row) => row.id));

describe('the key registry', () => {
  it('has each id once, each in the form section.action, with a label and a key to write', () => {
    const ids = KEYS.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of KEYS as readonly KeyBinding[]) {
      expect(entry.id.startsWith(`${entry.section}.`), entry.id).toBe(true);
      expect(entry.label, entry.id).not.toBe('');
      expect(entry.keys.length, entry.id).toBeGreaterThan(0);
      for (const isMac of [true, false]) expect(keysText(entry.id as never, isMac).every((key) => key !== ''), entry.id).toBe(true);
    }
  });

  it('marks only the cheat sheet, master, document editing, arrow-swapping and board-arranging keys new so far: the rest were in the app before it', () => {
    expect(KEYS.filter((entry) => entry.status === 'new').map((entry) => entry.id)).toEqual([
      'move.cheatSheet',
      'move.master',
      'move.cheatSheetAnywhere',
      'edit.swapDirection',
      'edit.arrangeBoard',
      'window.saveDoc',
      'window.leaveDocEdit',
    ]);
  });

  it('writes each key as the platform presses it', () => {
    expect([keyText('make.askClaude', true), keyText('make.askClaude', false)]).toEqual(['⌘⇧A', 'Ctrl+Shift+A']);
    expect([keyText('move.boardMenu', true), keyText('move.boardMenu', false)]).toEqual(['⌘\\', 'Ctrl+\\']);
    expect([keyText('move.spotlight', true), keyText('move.spotlight', false)]).toEqual(['⌘K', 'Ctrl+Shift+K']);
    expect([keyText('window.splitBelow', true), keyText('window.splitBelow', false)]).toEqual(['⌘⇧D', 'Ctrl+Shift+Alt+D']);
    expect([keyText('window.runGate', true), keyText('window.runGate', false)]).toEqual(['⌘⇧G', 'Ctrl+Shift+G']);
    expect([keyText('move.master', true), keyText('move.master', false)]).toEqual(['⌘⇧M', 'Ctrl+Shift+M']);
    expect([keyText('window.paneFocus', true), keyText('window.paneFocus', false)]).toEqual(['⌘⌥←↑→↓', 'Ctrl+Shift+Alt+←↑→↓']);
    expect(keysText('edit.redo', true)).toEqual(['⌘⇧Z', '⌘Y']);
    expect([keyText('make.note'), keyText('move.connections'), keyText('edit.resetRotation'), keyText('tile.open')]).toEqual(['N', '⇧E', '⇧R', '↵']);
  });
});

describe('pressing a key', () => {
  it('matches a board key by what it types, Shift or not, and never with a modifier', () => {
    expect(pressed('make.note', press('n', 'KeyN'), MAC)).toBe(true);
    expect(pressed('make.note', press('N', 'KeyN', { shiftKey: true }), MAC)).toBe(true);
    expect(pressed('make.note', press('n', 'KeyN', { metaKey: true }), MAC)).toBe(false);
    expect(pressed('make.note', press('n', 'KeyN', { altKey: true }), MAC)).toBe(false);
    expect(pressed('make.note', press('n', 'KeyN', { ctrlKey: true }), OTHER)).toBe(false);
    // ⇧E asks for Shift; plain E is nothing.
    expect(pressed('move.connections', press('E', 'KeyE', { shiftKey: true }), MAC)).toBe(true);
    expect(pressed('move.connections', press('e', 'KeyE'), MAC)).toBe(false);
    // ⇧C cycles the crew look; plain C is nothing.
    expect(pressed('move.crews', press('C', 'KeyC', { shiftKey: true }), MAC)).toBe(true);
    expect(pressed('move.crews', press('c', 'KeyC'), MAC)).toBe(false);
  });

  it('takes the command key as ⌘ on macOS and Ctrl elsewhere, Shift told apart', () => {
    expect(pressed('make.askClaude', press('A', 'KeyA', { metaKey: true, shiftKey: true }), MAC)).toBe(true);
    expect(pressed('make.askClaude', press('a', 'KeyA', { metaKey: true }), MAC)).toBe(false);
    expect(pressed('edit.selectAll', press('a', 'KeyA', { metaKey: true }), MAC)).toBe(true);
  });

  it('takes a window chord as ⌘ on macOS and Ctrl+Shift elsewhere, by where the key is', () => {
    expect(pressed('move.spotlight', press('k', 'KeyK', { metaKey: true }), MAC)).toBe(true);
    expect(pressed('move.spotlight', press('k', 'KeyK', { ctrlKey: true }), OTHER)).toBe(false);
    expect(pressed('move.spotlight', press('K', 'KeyK', { ctrlKey: true, shiftKey: true }), OTHER)).toBe(true);
    // Off macOS Ctrl+Shift+/ types ?, so the window chord goes by the key's place.
    expect(pressed('move.cheatSheetAnywhere', press('?', 'Slash', { ctrlKey: true, shiftKey: true }), OTHER)).toBe(true);
    expect(pressed('move.cheatSheetAnywhere', press('/', 'Slash', { metaKey: true }), MAC)).toBe(true);
    expect(pressed('window.runGate', press('G', 'KeyG', { metaKey: true, shiftKey: true }), MAC)).toBe(true);
    expect(pressed('window.runGate', press('g', 'KeyG', { metaKey: true }), MAC)).toBe(false);
    expect(pressed('window.splitBelow', press('D', 'KeyD', { ctrlKey: true, shiftKey: true }), OTHER)).toBe(false);
    expect(pressed('window.splitBelow', press('D', 'KeyD', { ctrlKey: true, shiftKey: true, altKey: true }), OTHER)).toBe(true);
    expect(pressed('window.splitBeside', press('D', 'KeyD', { ctrlKey: true, shiftKey: true }), OTHER)).toBe(true);
  });

  it('takes ⌘I for the details, Ctrl+Shift+I elsewhere, where plain Ctrl+I is Tab in a terminal', () => {
    expect(pressed('window.details', press('i', 'KeyI', { metaKey: true }), MAC)).toBe(true);
    expect(pressed('window.details', press('i', 'KeyI', { ctrlKey: true }), MAC)).toBe(false);
    expect(pressed('window.details', press('I', 'KeyI', { metaKey: true, shiftKey: true }), MAC)).toBe(false);
    expect(pressed('window.details', press('I', 'KeyI', { ctrlKey: true, shiftKey: true }), OTHER)).toBe(true);
    expect(pressed('window.details', press('i', 'KeyI', { ctrlKey: true }), OTHER)).toBe(false);
    expect(pressed('window.details', press('J', 'KeyJ', { ctrlKey: true, shiftKey: true }), OTHER)).toBe(false);
    expect([keyText('window.details', true), keyText('window.details', false)]).toEqual(['⌘I', 'Ctrl+Shift+I']);
    expect([keysText('window.textSize', true), keysText('window.textSize', false)]).toEqual([
      ['⌘+', '⌘-', '⌘0'],
      ['Ctrl+Shift++', 'Ctrl+Shift+-', 'Ctrl+Shift+0'],
    ]);
  });

  it('never matches a key that is only written, such as a range', () => {
    for (const isMac of [true, false]) {
      for (const chord of binding('window.tab').keys) expect(chordPressed(chord, press('1', 'Digit1', { metaKey: true, ctrlKey: !isMac, shiftKey: !isMac }), isMac)).toBe(false);
    }
  });
});

describe('the Extended keyboard shortcuts setting', () => {
  it('turned off, leaves every new key inactive and every other one as it was, under Classic', () => {
    for (const entry of KEYS as readonly KeyBinding[]) {
      expect(isActive(entry, true, false), entry.id).toBe(!entry.simplifiedOnly);
      expect(isActive(entry, false, false), entry.id).toBe(!entry.simplifiedOnly && entry.status !== 'new');
    }
  });

  it('turned off, leaves every new key inactive and every other one as it was, under the Simplified design', () => {
    for (const entry of KEYS as readonly KeyBinding[]) {
      expect(isActive(entry, true, true), entry.id).toBe(true);
      expect(isActive(entry, false, true), entry.id).toBe(entry.status !== 'new');
    }
  });

  it('turned off, stops a new key being pressed', () => {
    expect(pressed('move.cheatSheet', press('?', 'Slash', { shiftKey: true }), { isMac: true, extended: true })).toBe(true);
    expect(pressed('move.cheatSheet', press('?', 'Slash', { shiftKey: true }), { isMac: true, extended: false })).toBe(false);
    expect(pressed('move.cheatSheetAnywhere', press('/', 'Slash', { metaKey: true }), { isMac: true, extended: false })).toBe(false);
    expect(pressed('make.note', press('n', 'KeyN'), { isMac: true, extended: false })).toBe(true);
    // Saving a document with ⌘S, and esc leaving Edit, are new: off, the Save and Cancel buttons still do it.
    expect(pressed('window.saveDoc', press('s', 'KeyS', { metaKey: true }), MAC)).toBe(true);
    expect(pressed('window.saveDoc', press('s', 'KeyS', { ctrlKey: true }), OTHER)).toBe(true);
    expect(pressed('window.saveDoc', press('s', 'KeyS', { metaKey: true }), { isMac: true, extended: false })).toBe(false);
    expect(pressed('window.leaveDocEdit', press('Escape', 'Escape'), MAC)).toBe(true);
    expect(pressed('window.leaveDocEdit', press('Escape', 'Escape'), { isMac: true, extended: false })).toBe(false);
  });
});

describe('a key of the Simplified design', () => {
  it('is active only under it, whatever the Extended keyboard shortcuts setting', () => {
    const terminal = binding('window.terminalView');
    expect(isActive(terminal, true, false)).toBe(false);
    expect(isActive(terminal, false, true)).toBe(true);
    expect(pressed('window.terminalView', press('t', 'KeyT', { metaKey: true, altKey: true }), { isMac: true, extended: false, simplified: true })).toBe(true);
    expect(pressed('window.terminalView', press('t', 'KeyT', { metaKey: true, altKey: true }), { isMac: true, extended: true, simplified: false })).toBe(false);
    expect(pressed('window.terminalView', press('t', 'KeyT', { ctrlKey: true, shiftKey: true, altKey: true }), { isMac: false, simplified: true })).toBe(true);
    expect(pressed('window.terminalView', press('t', 'KeyT', { metaKey: true }), { isMac: true, simplified: true })).toBe(false);
    expect([keyText('window.terminalView', true), keyText('window.terminalView', false)]).toEqual(['⌘⌥T', 'Ctrl+Shift+Alt+T']);
    expect([keyText('window.stopStep', true), keyText('window.stopStep', false)]).toEqual(['⌘.', 'Ctrl+Shift+.']);
    expect(pressed('window.stopStep', press('.', 'Period', { metaKey: true }), { isMac: true, simplified: true })).toBe(true);
    expect(pressed('window.stopStep', press('.', 'Period', { metaKey: true }), { isMac: true, simplified: false })).toBe(false);
  });

  it('is on the cheat sheet only under it', () => {
    expect(ids(cheatSheet('window', { extended: true, simplified: true }))).toContain('window.terminalView');
    expect(ids(cheatSheet('window', { extended: true, simplified: false }))).not.toContain('window.terminalView');
  });
});

describe('the cheat sheet', () => {

  it('lists every active key once under Classic, its own keys alone, and leaves the new ones out with the setting off', () => {
    const classic = ids(cheatSheet('board', { extended: true, simplified: false }));
    expect(classic.toSorted()).toEqual((KEYS as readonly KeyBinding[]).filter((entry) => !entry.simplifiedOnly).map((entry) => entry.id).toSorted());
    const newOnes = (KEYS as readonly KeyBinding[]).filter((entry) => !entry.simplifiedOnly && entry.status === 'new').length;
    expect(ids(cheatSheet('board', { extended: false, simplified: false }))).toHaveLength(classic.length - newOnes);
  });

  it('lists every active key once under the Simplified design, and leaves the new ones out with the setting off', () => {
    const on = ids(cheatSheet('board', { extended: true, simplified: true }));
    expect(on.toSorted()).toEqual(KEYS.map((entry) => entry.id).toSorted());
    const off = ids(cheatSheet('board', { extended: false, simplified: true }));
    expect(off).not.toContain('move.cheatSheet');
    expect(off).not.toContain('move.cheatSheetAnywhere');
    expect(off).not.toContain('move.master');
    expect(off).not.toContain('window.saveDoc');
    expect(off).not.toContain('edit.swapDirection');
    expect(off).not.toContain('edit.arrangeBoard');
    expect(off).toHaveLength(on.length - 7);
  });

  it('puts the sections for where it opened first, marked here', () => {
    const at = (context: 'board' | 'tile' | 'window') => cheatSheet(context, { extended: true }).map((section) => `${section.id}${section.here ? '*' : ''}`);
    expect(at('board')).toEqual(['move*', 'make*', 'edit*', 'tile', 'window', 'dialog']);
    expect(at('tile')).toEqual(['tile*', 'move', 'make', 'edit', 'window', 'dialog']);
    expect(at('window')).toEqual(['window*', 'move', 'make', 'edit', 'tile', 'dialog']);
  });

  it('filters by label or key, dropping sections left empty', () => {
    const split = cheatSheet('window', { extended: true, filter: 'split', isMac: true });
    expect(split.map((section) => section.id)).toEqual(['window']);
    expect(split[0]!.rows.map((row) => [row.label, row.keys])).toEqual([
      ['Split beside', ['⌘D']],
      ['Split below', ['⌘⇧D']],
    ]);
    expect(ids(cheatSheet('board', { extended: true, filter: '⌘⇧', isMac: true }))).toEqual(['move.master', 'make.askClaude', 'edit.redo', 'window.splitBelow', 'window.runGate', 'window.openLinkBrowser']);
    expect(cheatSheet('board', { extended: true, filter: 'nothing like this' })).toEqual([]);
  });
});
