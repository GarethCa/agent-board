import type { MenuItemConstructorOptions } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import type { MenuBarKey, MenuBarRow, MenuBarState } from '../shared/menu-bar';
import { appMenu, menuTemplate, windowMenu } from './app-menu';
import type { MenuBar } from './menu-bar-items';

/** Keys as a macOS window reports them: ⌘D, ⌘[ and ⌘] are each two actions' chord. */
const KEYS: Record<string, MenuBarKey> = {
  'make.agent': { text: 'A', enabled: true },
  'make.note': { text: 'N', enabled: true },
  'edit.duplicate': { accelerator: 'CommandOrControl+D', text: '⌘D', enabled: true },
  'window.splitBeside': { accelerator: 'CommandOrControl+D', text: '⌘D', enabled: true },
  'edit.forward': { accelerator: 'CommandOrControl+]', text: '⌘]', enabled: true },
  'window.next': { accelerator: 'CommandOrControl+]', text: '⌘]', enabled: true },
  'edit.backward': { accelerator: 'CommandOrControl+[', text: '⌘[', enabled: true },
  'window.previous': { accelerator: 'CommandOrControl+[', text: '⌘[', enabled: true },
  'window.closeTab': { accelerator: 'CommandOrControl+W', text: '⌘W', enabled: true },
  'move.spotlight': { accelerator: 'CommandOrControl+K', text: '⌘K', enabled: true },
  'move.master': { accelerator: 'CommandOrControl+Shift+M', text: '⇧⌘M', enabled: true },
  'move.boardMenu': { accelerator: 'CommandOrControl+\\', text: '⌘\\', enabled: true },
  'window.newTab': { accelerator: 'CommandOrControl+T', text: '⌘T', enabled: true },
  'window.saveDoc': { accelerator: 'CommandOrControl+S', text: '⌘S', enabled: true },
  'window.details': { accelerator: 'CommandOrControl+I', text: '⌘I', enabled: true },
  'window.terminalView': { accelerator: 'CommandOrControl+Alt+T', text: '⌥⌘T', enabled: false },
  'make.askClaude': { accelerator: 'CommandOrControl+Shift+A', text: '⇧⌘A', enabled: true },
  'move.cheatSheetAnywhere': { accelerator: 'CommandOrControl+/', text: '⌘/', enabled: true },
  // Overview is main's own item, on main's own chord.
  'window.overview': { accelerator: 'CommandOrControl+Shift+O', text: '⇧⌘O', enabled: true },
};
const AGENT: MenuBarRow[] = [
  { id: 'rename', label: 'Rename', enabled: true, shortcut: 'F2' },
  'separator',
  { id: 'effort', label: 'Effort', enabled: true, entries: [{ id: 'high', label: 'High', enabled: true, checked: true }] },
  { id: 'delete', label: 'Delete agent', enabled: false, danger: true },
];
const bar = (state: Partial<MenuBarState> = {}, run = vi.fn()): MenuBar & { run: typeof run } => ({
  state: { keys: KEYS, actions: { zoomIn: {}, minimap: { checked: true } }, agent: AGENT, project: null, ...state },
  run,
});
type Item = MenuItemConstructorOptions;
type Click = (item: unknown, window: unknown, event: { triggeredByAccelerator?: boolean }) => void;
/** The item labelled `label` anywhere in the bar's menu `menu`. */
const find = (template: Item[], menu: string, label: string): Item => {
  const all = (list: Item[]): Item[] => list.flatMap((item) => [item, ...(Array.isArray(item.submenu) ? all(item.submenu) : [])]);
  const top = template.find((item) => item.label === menu || (menu === 'Window' && item.role === 'windowMenu') || (menu === 'Help' && item.role === 'help'))!;
  return all(top.submenu as Item[]).find((item) => item.label === label)!;
};
const mac = (b = bar(), a = actions()) => menuTemplate({ mac: true, packaged: true, name: 'agent-board' }, a, technical(), [], b);


const actions = () => ({ about: vi.fn(), settings: vi.fn(), checkForUpdates: vi.fn(), gettingStarted: vi.fn(), overview: vi.fn() });
const technical = () => ({ simplified: true, on: false, set: vi.fn() });
const accelerators = (list: MenuItemConstructorOptions[]): string[] =>
  list.flatMap((item) => [...(item.accelerator === undefined ? [] : [String(item.accelerator)]), ...(Array.isArray(item.submenu) ? accelerators(item.submenu) : [])]);
const items = (a = actions()) => appMenu('agent-board', a).submenu as MenuItemConstructorOptions[];

describe('the app menu', () => {
  it('has About, Check for Updates…, Settings…, Hide, Hide Others, Show All and Quit', () => {
    const list = items();
    expect(list.map((item) => item.label ?? item.role).filter((x) => x !== undefined)).toEqual([
      'About agent-board',
      'Check for Updates…',
      'Settings…',
      'services',
      'hide',
      'hideOthers',
      'unhide',
      'quit',
    ]);
  });

  it('puts Settings… on ⌘,', () => {
    expect(items().find((item) => item.label === 'Settings…')?.accelerator).toBe('CommandOrControl+,');
  });

  it('gives no two items in the whole menu bar the same accelerator, though the window gives several keys one chord', () => {
    for (const mac of [true, false]) {
      for (const packaged of [true, false]) {
        const all = accelerators(menuTemplate({ mac, packaged, name: 'agent-board' }, actions(), technical(), [], bar()));
        expect(all.length).toBeGreaterThan(10);
        expect(new Set(all).size).toBe(all.length);
      }
    }
  });

  it('has no accelerator but main’s own and those the window gave its registry keys, and none a bare key', () => {
    const ALLOWED = ['CommandOrControl+,', 'CommandOrControl+Shift+O', 'Command+Shift+W', ...Object.values(KEYS).flatMap((key) => key.accelerator ?? [])];
    for (const mac of [true, false]) {
      for (const packaged of [true, false]) {
        for (const accelerator of accelerators(menuTemplate({ mac, packaged, name: 'agent-board' }, actions(), technical(), [], bar()))) {
          expect(accelerator).toContain('+');
          expect(ALLOWED).toContain(accelerator);
        }
      }
    }
  });

  it('has the app menu only on macOS', () => {
    const labels = (mac: boolean) => menuTemplate({ mac, packaged: true, name: 'agent-board' }, actions(), technical()).map((menu) => menu.label);
    expect(labels(true)[0]).toBe('agent-board');
    expect(labels(false)[0]).toBe('File');
  });

  it('calls each item’s action', () => {
    const a = actions();
    for (const label of ['About agent-board', 'Settings…', 'Check for Updates…']) {
      (items(a).find((item) => item.label === label)!.click as () => void)();
    }
    expect([a.about, a.settings, a.checkForUpdates].map((fn) => fn.mock.calls.length)).toEqual([1, 1, 1]);
  });
});

describe('the Window menu', () => {
  const labels = (list: MenuItemConstructorOptions[]) => list.map((item) => item.label ?? item.role ?? item.type);

  it('is Overview over the standard one, the board’s and a session window’s, while nothing is minimised', () => {
    expect(labels(windowMenu(true, vi.fn(), []).submenu as MenuItemConstructorOptions[])).toEqual([
      'Overview', 'separator', 'minimize', 'zoom', 'separator',
      'Board Menu', 'Jump to Session or Zone…', 'Needs You', 'Open the Captain', 'separator',
      'Previous Session in Group', 'Next Session in Group', 'Split Beside', 'Split Below', 'separator', 'front',
    ]);
  });

  it('opens the Overview on ⌘⇧O', () => {
    const a = actions();
    const windowItem = menuTemplate({ mac: true, packaged: true, name: 'agent-board' }, a, technical()).find((item) => item.role === 'windowMenu')!;
    const overview = (windowItem.submenu as MenuItemConstructorOptions[]).find((item) => item.label === 'Overview')!;
    expect(overview.accelerator).toBe('CommandOrControl+Shift+O');
    (overview.click as () => void)();
    expect(a.overview).toHaveBeenCalledOnce();
  });

  it('lists the minimised windows under a Minimised heading, and restores the one picked', () => {
    const restore = vi.fn();
    const list = windowMenu(true, vi.fn(), [{ title: 'API', restore }, { title: 'Docs', restore: vi.fn() }]).submenu as MenuItemConstructorOptions[];
    expect(labels(list).slice(-4)).toEqual(['separator', 'Minimised', 'API', 'Docs']);
    expect(list.find((item) => item.label === 'Minimised')?.enabled).toBe(false);
    (list.find((item) => item.label === 'API')!.click as () => void)();
    expect(restore).toHaveBeenCalledOnce();
  });

  it('is in the menu bar with the minimised windows', () => {
    const template = menuTemplate({ mac: true, packaged: false, name: 'agent-board' }, actions(), technical(), [{ title: 'API', restore: vi.fn() }]);
    const windowItem = template.find((item) => item.role === 'windowMenu')!;
    expect((windowItem.submenu as MenuItemConstructorOptions[]).some((item) => item.label === 'API')).toBe(true);
  });
});

describe('the menu bar', () => {
  it('runs a registry action in the focused window, saying whether its key was pressed', () => {
    const b = bar();
    (find(mac(b), 'Edit', 'Duplicate').click as Click)(undefined, undefined, { triggeredByAccelerator: true });
    (find(mac(b), 'Project', 'Arrange the Board').click as Click)(undefined, undefined, {});
    expect(b.run.mock.calls).toEqual([[{ kind: 'key', id: 'edit.duplicate', viaKey: true }], [{ kind: 'key', id: 'edit.arrangeBoard', viaKey: false }]]);
  });

  it('gives a shared chord to the first item only, and shows it on the other as a grey line', () => {
    const template = mac();
    expect(find(template, 'Edit', 'Duplicate').accelerator).toBe('CommandOrControl+D');
    const split = find(template, 'Window', 'Split Beside');
    expect(split.accelerator).toBeUndefined();
    expect(split.sublabel).toBe('⌘D in a session window');
    expect(find(template, 'Edit', 'Bring Forward').accelerator).toBe('CommandOrControl+]');
    expect(find(template, 'Window', 'Next Session in Group').sublabel).toBe('⌘] in a session window');
  });

  it('never makes a bare board key an accelerator: it shows as “Board key”', () => {
    const item = find(mac(), 'File', 'New Agent…');
    expect(item.accelerator).toBeUndefined();
    expect(item.sublabel).toBe('Board key: A');
  });

  it('greys an action that is off in the focused window', () => {
    expect(find(mac(), 'View', 'Show Terminal').enabled).toBe(false);
    expect(find(mac(), 'View', 'Show Details').enabled).toBe(true);
  });

  it('puts Close Tab on ⌘W and Close Window on ⇧⌘W, never the close role', () => {
    const template = mac();
    expect(find(template, 'File', 'Close Tab').accelerator).toBe('CommandOrControl+W');
    const close = find(template, 'File', 'Close Window');
    expect(close.accelerator).toBe('Command+Shift+W');
    expect(close.role).toBeUndefined();
    const window = { close: vi.fn() };
    (close.click as (item: unknown, window: unknown) => void)(undefined, window);
    expect(window.close).toHaveBeenCalledOnce();
  });

  it('closes a window that has no tab to close on ⌘W, as Safari does', () => {
    const template = mac(bar({ keys: { ...KEYS, 'window.closeTab': { ...KEYS['window.closeTab']!, enabled: false } } }));
    expect(find(template, 'File', 'Close Tab').accelerator).toBeUndefined();
    expect(find(template, 'File', 'Close Window').accelerator).toBe('Command+W');
  });

  it('gives a shared chord to the item that can run, so ⌘D on the board is Duplicate and in a session window Split Beside', () => {
    const off = (id: string) => ({ [id]: { ...KEYS[id]!, enabled: false } });
    const board = mac(bar({ keys: { ...KEYS, ...off('window.splitBeside'), ...off('window.next'), ...off('window.previous') } }));
    expect(find(board, 'Edit', 'Duplicate').accelerator).toBe('CommandOrControl+D');
    expect(find(board, 'Window', 'Split Beside').accelerator).toBeUndefined();
    const session = mac(bar({ keys: { ...KEYS, ...off('edit.duplicate'), ...off('edit.forward'), ...off('edit.backward') } }));
    expect(find(session, 'Edit', 'Duplicate').accelerator).toBeUndefined();
    expect(find(session, 'Edit', 'Duplicate').sublabel).toBe('⌘D');
    expect(find(session, 'Window', 'Split Beside').accelerator).toBe('CommandOrControl+D');
    expect(find(session, 'Window', 'Next Session in Group').accelerator).toBe('CommandOrControl+]');
    expect(find(session, 'Window', 'Previous Session in Group').accelerator).toBe('CommandOrControl+[');
  });

  it('quits from File off macOS, and keeps Paste and Match Style on macOS', () => {
    const roles = (template: Item[], menu: string) => (template.find((each) => each.label === menu)!.submenu as Item[]).map((item) => item.role);
    const other = menuTemplate({ mac: false, packaged: true, name: 'agent-board' }, actions(), technical(), [], bar());
    expect(roles(other, 'File').at(-1)).toBe('quit');
    expect(roles(mac(), 'File')).not.toContain('quit');
    expect(roles(mac(), 'Edit')).toContain('pasteAndMatchStyle');
    expect(roles(other, 'Edit')).not.toContain('pasteAndMatchStyle');
  });

  it('draws the selected agent’s menu as its ⋯ has it, and sends back the row picked', () => {
    const b = bar();
    const agent = mac(b).find((menu) => menu.label === 'Agent')!.submenu as Item[];
    expect(agent.map((item) => item.label ?? item.type)).toEqual(['Rename', 'separator', 'Effort', 'Delete agent']);
    expect(agent[0]!.sublabel).toBe('Board key: F2');
    expect(agent[3]!.enabled).toBe(false);
    const high = (agent[2]!.submenu as Item[])[0]!;
    expect([high.type, high.checked]).toEqual(['checkbox', true]);
    (agent[0]!.click as Click)(undefined, undefined, {});
    expect(b.run).toHaveBeenCalledWith({ kind: 'row', section: 'agent', id: 'rename' });
  });

  it('greys Agent and Project with nothing selected, and keeps Arrange the Board', () => {
    const template = mac(bar({ agent: null }));
    expect(template.find((menu) => menu.label === 'Agent')!.submenu).toEqual([{ label: 'Select an agent on the board', enabled: false }]);
    const project = (template.find((menu) => menu.label === 'Project')!.submenu as Item[]).map((item) => item.label ?? item.type);
    expect(project).toEqual(['Select a project on the board', 'separator', 'Arrange the Board']);
  });

  it('greys a window command the focused window has nothing to run, and ticks a toggle that is on', () => {
    const b = bar();
    const template = mac(b);
    expect(find(template, 'View', 'Zoom In').enabled).toBe(true);
    expect(find(template, 'View', 'Zoom Out').enabled).toBe(false);
    expect(find(template, 'View', 'Show Minimap').checked).toBe(true);
    expect(find(template, 'Window', 'Needs You').enabled).toBe(false);
    (find(template, 'View', 'Zoom In').click as Click)(undefined, undefined, {});
    expect(b.run).toHaveBeenCalledWith({ kind: 'action', id: 'zoomIn' });
  });

  it('has an action for every item', () => {
    const check = (list: Item[]) => {
      for (const item of list) {
        if (item.type === 'separator' || item.enabled === false) continue;
        expect(item.click !== undefined || item.role !== undefined || Array.isArray(item.submenu), String(item.label)).toBe(true);
        if (Array.isArray(item.submenu)) check(item.submenu);
      }
    };
    for (const isMac of [true, false]) check(menuTemplate({ mac: isMac, packaged: false, name: 'agent-board' }, actions(), technical(), [], bar()));
  });

  it('is File, Edit, View, Agent, Project, Window and Help after the app menu', () => {
    expect(mac().map((menu) => menu.label ?? menu.role)).toEqual(['agent-board', 'File', 'Edit', 'View', 'Agent', 'Project', 'windowMenu', 'help']);
  });

  it('never has the zoom roles', () => {
    const roles = (list: Item[]): string[] => list.flatMap((item) => [...(item.role === undefined ? [] : [item.role]), ...(Array.isArray(item.submenu) ? roles(item.submenu) : [])]);
    expect(roles(mac())).not.toEqual(expect.arrayContaining(['zoomIn']));
    for (const role of ['zoomIn', 'zoomOut', 'resetZoom', 'close', 'fileMenu', 'editMenu']) expect(roles(mac())).not.toContain(role);
  });
});
