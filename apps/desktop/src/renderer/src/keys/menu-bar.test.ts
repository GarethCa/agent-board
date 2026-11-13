import { describe, expect, it, vi } from 'vitest';
import type { Agent } from '@agent-board/daemon/protocol';
import type { MenuBarRow } from '../../../shared/menu-bar';
import { agentMenu, menuIds, type ModelEntry } from '../board/menu-model';
import { galleryAgent } from '../board/TileGallery';
import { createMenuBarBridge, type MenuBarWindow } from './menu-bar-bridge';
import { acceleratorOf, keyAvailable, menuBarKey, menuBarKeys, menuBarRows, pressOf, runRow, type MenuBarWhere } from './menu-bar';
import { binding, chordsOf, KEYS, pressed, type KeyBinding, type KeyId } from './registry';

describe('a chord as an accelerator', () => {
  it('names the board and window chords, ⌘ always as CommandOrControl', () => {
    expect(acceleratorOf(binding('edit.duplicate').keys[0]!, true)).toBe('CommandOrControl+D');
    expect(acceleratorOf(binding('window.splitBeside').keys[0]!, true)).toBe('CommandOrControl+D');
    expect(acceleratorOf(binding('window.splitBelow').keys[0]!, true)).toBe('CommandOrControl+Shift+D');
    expect(acceleratorOf(binding('make.askClaude').keys[0]!, true)).toBe('CommandOrControl+Shift+A');
    expect(acceleratorOf(binding('window.next').keys[0]!, true)).toBe('CommandOrControl+]');
    expect(acceleratorOf(binding('move.boardMenu').keys[0]!, true)).toBe('CommandOrControl+\\');
    expect(acceleratorOf(binding('move.cheatSheetAnywhere').keys[0]!, true)).toBe('CommandOrControl+/');
    expect(acceleratorOf(binding('window.terminalView').keys[0]!, true)).toBe('CommandOrControl+Alt+T');
  });

  it('writes a window chord off macOS with Shift, as it is pressed there', () => {
    expect(acceleratorOf(binding('window.splitBeside').keys[0]!, false)).toBe('CommandOrControl+Shift+D');
    expect(acceleratorOf(binding('window.terminalView').keys[0]!, false)).toBe('CommandOrControl+Shift+Alt+T');
    expect(menuBarKey(binding('window.splitBelow'), false, true, true).accelerator).toBe('CommandOrControl+Shift+Alt+D');
  });

  it('gives a bare key, a range or a held key none', () => {
    for (const id of ['make.agent', 'move.connections', 'edit.front', 'tile.rename', 'window.tab', 'window.paneFocus', 'edit.snapTurn'] as const) {
      expect(acceleratorOf(binding(id).keys[0]!, true), id).toBeUndefined();
    }
  });
});

describe('the keys the menu bar shows', () => {
  it('writes each key as the registry does, and greys a key that is off', () => {
    const keys = menuBarKeys(true, false, false);
    expect(keys['make.agent']).toEqual({ text: 'A', enabled: true });
    expect(keys['edit.duplicate']).toEqual({ accelerator: 'CommandOrControl+D', text: '⌘D', enabled: true });
    // `new`, with the extended keys off; Simplified's own, under Classic.
    expect(keys['edit.arrangeBoard']!.enabled).toBe(false);
    expect(keys['window.terminalView']!.enabled).toBe(false);
    expect(menuBarKeys(true, true, true)['window.terminalView']!.enabled).toBe(true);
  });

  it('greys a key where it would do nothing, or something else: ⌘D on the board is Duplicate, in a session window Split', () => {
    const where = (more: Partial<MenuBarWhere>): MenuBarWhere => ({ board: false, selection: false, arrows: false, session: false, ...more });
    const can = (id: KeyId, at: MenuBarWhere) => keyAvailable(binding(id), at);
    // The board with nothing selected: it makes things, but has nothing to duplicate, order or delete.
    expect(can('make.note', where({ board: true }))).toBe(true);
    for (const id of ['edit.duplicate', 'edit.forward', 'edit.backward', 'edit.delete', 'edit.resetRotation', 'make.askClaude', 'edit.swapDirection'] as const) expect(can(id, where({ board: true })), id).toBe(false);
    expect(can('edit.duplicate', where({ board: true, selection: true }))).toBe(true);
    expect(can('edit.swapDirection', where({ board: true, selection: true }))).toBe(false);
    expect(can('edit.swapDirection', where({ board: true, selection: true, arrows: true }))).toBe(true);
    // A session window's keys only with the focus in one.
    for (const id of ['window.splitBeside', 'window.previous', 'window.next', 'window.closeTab', 'window.newTab', 'window.saveDoc'] as const) {
      expect(can(id, where({ board: true, selection: true })), id).toBe(false);
      expect(can(id, where({ session: true })), id).toBe(true);
    }
    // No board here (Settings, Overview, a session window of its own): none of its keys.
    expect(can('make.note', where({ session: true }))).toBe(false);
    // The keys for anywhere stay.
    expect(can('move.spotlight', where({}))).toBe(true);
    expect(menuBarKeys(true, true, true, where({ board: true }))['edit.duplicate']!.enabled).toBe(false);
    expect(menuBarKeys(true, true, true)['edit.duplicate']!.enabled).toBe(true);
    // Focus in a session window on the board: ⌘D is Split Beside's, so Duplicate is off.
    expect(can('edit.duplicate', where({ board: true, selection: true, session: true }))).toBe(false);
    expect(can('window.splitBeside', where({ board: true, selection: true, session: true }))).toBe(true);
  });

  it('keeps an item whose key is off clickable when the window can run it, without the key’s accelerator', () => {
    const board: MenuBarWhere = { board: true, selection: false, arrows: false, session: false };
    expect(menuBarKeys(true, false, false, board)['edit.arrangeBoard']!.enabled).toBe(false);
    expect(menuBarKeys(true, false, false, board, new Set(['edit.arrangeBoard']))['edit.arrangeBoard']!.enabled).toBe(true);
    const save = menuBarKeys(true, false, false, { ...board, session: true }, new Set(['window.saveDoc']))['window.saveDoc']!;
    expect(save).toEqual({ text: '⌘S', enabled: true });
  });

  it('lists every binding', () => {
    expect(Object.keys(menuBarKeys(true, true, true))).toEqual(KEYS.map((entry) => entry.id));
  });
});

describe('the press a picked item makes', () => {
  // Every binding pressed by one key: a menu item that stands for it presses it, on both platforms.
  const pressable = (isMac: boolean) => (KEYS as readonly KeyBinding[]).filter((entry) => {
    const chord = chordsOf(entry, isMac)[0];
    return chord?.key !== undefined || chord?.code !== undefined;
  });

  it.each([true, false])('is the key itself (macOS: %s)', (isMac) => {
    for (const entry of pressable(isMac)) {
      expect(pressed(entry.id as KeyId, pressOf(entry, isMac) as KeyboardEvent, { isMac, extended: true, simplified: true }), entry.id).toBe(true);
    }
  });

  it('presses ⌫ for Delete, which its handler matches by key', () => {
    expect(pressOf(binding('edit.delete'), true)).toMatchObject({ key: 'Backspace', metaKey: false });
  });
});

const fold = vi.fn();
const recolor = vi.fn();
const menu: ModelEntry[] = [
  { heading: 'Open' },
  { id: 'rename', label: 'Rename', shortcut: 'F2', onSelect: () => {} },
  { id: 'mute', label: 'Mute', checked: true, onSelect: () => {} },
  { id: 'gone', label: 'Gone', disabled: true, onSelect: () => {} },
  'separator',
  { id: 'fold', label: 'Fold', entries: [{ id: 'all', label: 'All', onSelect: fold }] },
  { id: 'colour', label: 'Colour', swatches: [{ name: 'Red', value: '#f00', pressed: true }, { name: 'Blue', value: '#00f', pressed: false }], onPick: recolor },
  { id: 'fill', label: 'Fill', value: 1, min: 0, max: 2, step: 1, format: String, onChange: () => {}, onCommit: () => {}, onCancel: () => {} },
  { id: 'delete', label: 'Delete', danger: true, onSelect: () => {} },
];

describe('a model menu in the menu bar', () => {
  it('keeps its rows, headings and separators; a swatch row is a submenu; a slider is left out', () => {
    expect(menuBarRows(menu)).toEqual<MenuBarRow[]>([
      { heading: 'Open' },
      { id: 'rename', label: 'Rename', enabled: true, shortcut: 'F2' },
      { id: 'mute', label: 'Mute', enabled: true, checked: true },
      { id: 'gone', label: 'Gone', enabled: false },
      'separator',
      { id: 'fold', label: 'Fold', enabled: true, entries: [{ id: 'fold/all', label: 'All', enabled: true }] },
      { id: 'colour', label: 'Colour', enabled: true, entries: [{ id: 'colour/#f00', label: 'Red', enabled: true, checked: true }, { id: 'colour/#00f', label: 'Blue', enabled: true, checked: false }] },
      { id: 'delete', label: 'Delete', enabled: true, danger: true },
    ]);
  });

  it("gives an agent's rows the ids the menu model knows them by", () => {
    const entries = agentMenu({ nodeId: 'n1', agent: galleryAgent('running') as Agent, clickOpens: 'window', gate: undefined, rounds: [], rename: () => {}, actions: new Proxy({}, { get: () => () => {} }) as never });
    const ids = (rows: readonly MenuBarRow[]): string[] => rows.flatMap((row) => (row === 'separator' || 'heading' in row ? [] : [row.id, ...ids(row.entries ?? [])]));
    expect(ids(menuBarRows(entries))).toEqual(menuIds(entries));
  });

  it('runs a row by its path, a submenu row and a swatch too', () => {
    expect(runRow(menu, 'fold/all')).toBe(true);
    expect(fold).toHaveBeenCalledOnce();
    expect(runRow(menu, 'colour/#00f')).toBe(true);
    expect(recolor).toHaveBeenCalledWith('#00f');
    expect(runRow(menu, 'gone')).toBe(false);
    expect(runRow(menu, 'fill')).toBe(false);
    expect(runRow(menu, 'missing')).toBe(false);
  });
});

function bridge(more: Partial<MenuBarWindow> = {}) {
  const reports: unknown[] = [];
  const presses: string[] = [];
  let now = 0;
  const window: MenuBarWindow = {
    isMac: true,
    keys: () => ({ 'edit.duplicate': { accelerator: 'CommandOrControl+D', text: '⌘D', enabled: true } }),
    inSession: () => false,
    report: (state) => reports.push(state),
    press: (entry) => presses.push(entry.id),
    now: () => now,
    later: (run) => run(),
    ...more,
  };
  return { bridge: createMenuBarBridge(window), reports, presses, wait: (ms: number) => (now += ms) };
}

const cmdD = { key: 'd', code: 'KeyD', metaKey: true, ctrlKey: false, shiftKey: false, altKey: false };

describe("the window's half of the menu bar", () => {
  it('presses the key of an item clicked', () => {
    const { bridge: menuBar, presses } = bridge();
    menuBar.run({ kind: 'key', id: 'edit.duplicate', viaKey: false });
    expect(presses).toEqual(['edit.duplicate']);
  });

  it('never presses a key twice when the window has the press first: the accelerator after it is that press', () => {
    const { bridge: menuBar, presses } = bridge();
    expect(menuBar.pressed(cmdD)).toBe(false);
    menuBar.run({ kind: 'key', id: 'edit.duplicate', viaKey: true });
    expect(presses).toEqual([]);
    // Clicked, it runs, however recent the press.
    menuBar.run({ kind: 'key', id: 'edit.duplicate', viaKey: false });
    expect(presses).toEqual(['edit.duplicate']);
    // A second press is a second press: it reaches the window, then its accelerator is that one.
    expect(menuBar.pressed(cmdD)).toBe(false);
    menuBar.run({ kind: 'key', id: 'edit.duplicate', viaKey: true });
    expect(presses).toEqual(['edit.duplicate']);
  });

  it('never runs a key twice when the menu has the press first: the keydown that follows is dropped', () => {
    const { bridge: menuBar, presses, wait } = bridge();
    menuBar.run({ kind: 'key', id: 'edit.duplicate', viaKey: true });
    expect(presses).toEqual(['edit.duplicate']);
    // The window's own keydown for it comes after: its handlers must not have it.
    expect(menuBar.pressed(cmdD)).toBe(true);
    // Once only: another keydown is the user's next press, which the window runs.
    expect(menuBar.pressed(cmdD)).toBe(false);
    wait(2000);
    // Nor is a keydown long after the menu's press, or of another key, dropped.
    menuBar.run({ kind: 'key', id: 'edit.duplicate', viaKey: true });
    expect(menuBar.pressed({ ...cmdD, key: 'z', code: 'KeyZ' })).toBe(false);
    wait(2000);
    expect(menuBar.pressed(cmdD)).toBe(false);
    wait(2000);
    // With the menu first each time and no keydown after (macOS keeps it from the page), every press runs.
    menuBar.run({ kind: 'key', id: 'edit.duplicate', viaKey: true });
    menuBar.run({ kind: 'key', id: 'edit.duplicate', viaKey: true });
    expect(presses).toHaveLength(4);
  });

  it('runs a clicked item by the action its owner gave, not its key, which another handler may have', () => {
    const { bridge: menuBar, presses } = bridge();
    const [board, other] = [Symbol('board'), Symbol('other')];
    const duplicate = vi.fn();
    menuBar.setKey('edit.duplicate', other, () => {});
    menuBar.setKey('edit.duplicate', board, duplicate);
    menuBar.setKey('edit.duplicate', other, undefined);
    menuBar.run({ kind: 'key', id: 'edit.duplicate', viaKey: false });
    expect(duplicate).toHaveBeenCalledOnce();
    expect(presses).toEqual([]);
    // Its accelerator is still a key press, which goes where the focus is, as the key does.
    menuBar.run({ kind: 'key', id: 'edit.duplicate', viaKey: true });
    expect(duplicate).toHaveBeenCalledOnce();
    expect(presses).toEqual(['edit.duplicate']);
    menuBar.setKey('edit.duplicate', board, undefined);
    menuBar.run({ kind: 'key', id: 'edit.duplicate', viaKey: false });
    expect(presses).toEqual(['edit.duplicate', 'edit.duplicate']);
  });

  it('tells main which keys can run where it is: the board, a selection, an arrow, a session window', () => {
    let session = false;
    const asked: MenuBarWhere[] = [];
    const { bridge: menuBar } = bridge({ inSession: () => session, keys: (where) => (asked.push(where), {}) });
    const [board, tile] = [Symbol('board'), Symbol('tile')];
    menuBar.report(true);
    expect(asked.at(-1)).toEqual({ board: false, selection: false, arrows: false, session: false });
    menuBar.setWhen('board', board, true);
    menuBar.setWhen('selection', tile, true);
    session = true;
    menuBar.changed();
    expect(asked.at(-1)).toEqual({ board: true, selection: true, arrows: false, session: true });
    menuBar.setWhen('selection', tile, false);
    expect(asked.at(-1)).toMatchObject({ selection: false });
  });

  it('presses an accelerator the window had another press before', () => {
    const { bridge: menuBar, presses } = bridge();
    menuBar.pressed({ ...cmdD, key: 'z', code: 'KeyZ' });
    menuBar.run({ kind: 'key', id: 'edit.duplicate', viaKey: true });
    expect(presses).toEqual(['edit.duplicate']);
    // A chord the registry doesn't have is nothing.
    menuBar.run({ kind: 'key', id: 'nothing', viaKey: false });
    expect(presses).toEqual(['edit.duplicate']);
  });

  it('reports the selection and the commands it can run, only when they change', () => {
    const { bridge: menuBar, reports } = bridge();
    const tile = Symbol('tile');
    const zoom = Symbol('zoom');
    menuBar.setSection('agent', tile, menu);
    menuBar.setSection('agent', tile, menu);
    menuBar.setAction('minimap', zoom, { run: () => {}, checked: true });
    expect(reports).toHaveLength(2);
    expect(reports.at(-1)).toMatchObject({ actions: { minimap: { checked: true } }, agent: menuBarRows(menu), project: null });
    menuBar.setSection('agent', tile, undefined);
    menuBar.setAction('minimap', zoom, undefined);
    expect(reports.at(-1)).toMatchObject({ actions: {}, agent: null });
    // Again as the window comes to the front, changed or not.
    menuBar.report(true);
    expect(reports).toHaveLength(5);
  });

  it('shows the newest selection, and the one before once it is unselected', () => {
    const { bridge: menuBar, reports } = bridge();
    const [first, second] = [Symbol('first'), Symbol('second')];
    menuBar.setSection('project', first, [{ id: 'a', label: 'A', onSelect: () => {} }]);
    menuBar.setSection('project', second, [{ id: 'b', label: 'B', onSelect: () => {} }]);
    menuBar.setSection('project', first, [{ id: 'a', label: 'A2', onSelect: () => {} }]);
    expect(reports.at(-1)).toMatchObject({ project: [{ id: 'b' }] });
    menuBar.setSection('project', second, undefined);
    expect(reports.at(-1)).toMatchObject({ project: [{ id: 'a', label: 'A2' }] });
  });

  it('runs a row of the selection, and a command', () => {
    const { bridge: menuBar } = bridge();
    const run = vi.fn();
    const all = vi.fn();
    menuBar.setSection('agent', Symbol('tile'), [{ id: 'fold', label: 'Fold', entries: [{ id: 'all', label: 'All', onSelect: all }] }]);
    menuBar.setAction('zoomIn', Symbol('zoom'), { run });
    menuBar.run({ kind: 'row', section: 'agent', id: 'fold/all' });
    menuBar.run({ kind: 'row', section: 'project', id: 'fold/all' });
    menuBar.run({ kind: 'action', id: 'zoomIn' });
    menuBar.run({ kind: 'action', id: 'zoomOut' });
    expect(all).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledOnce();
  });

  it('leaves a command to its new owner when the old one goes', () => {
    const { bridge: menuBar } = bridge();
    const [old, owner] = [Symbol('old'), Symbol('new')];
    const run = vi.fn();
    menuBar.setAction('zoomIn', old, { run: () => {} });
    menuBar.setAction('zoomIn', owner, { run });
    menuBar.setAction('zoomIn', old, undefined);
    menuBar.run({ kind: 'action', id: 'zoomIn' });
    expect(run).toHaveBeenCalledOnce();
  });
});

