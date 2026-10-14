import { describe, expect, it } from 'vitest';
import type { PaneLayout } from '@agent-board/daemon/pane-layout';
import type { Agent, Shell } from '@agent-board/daemon/protocol';
import type { Surface } from '@agent-board/daemon/window-layout';
import { liveShellCount, OWN_TAB, sessionChoices, shellsChipLabel, tabAtDigit, tabKey, tabLiveShells, windowShells, windowSurfaces, windowTabs, type TabOwner } from './tabs';

const agent = { sessionId: 'agent-1', harness: 'claude' } as Agent;
const byAgent: TabOwner = { kind: 'agent', agent };

const pane = (sessionId: string, name?: string): PaneLayout => ({ type: 'pane', sessionId, ...(name === undefined ? {} : { name }) });
const split = (first: PaneLayout, second: PaneLayout): PaneLayout => ({ type: 'split', id: 's', direction: 'horizontal', ratio: 0.5, first, second });

const shell = (id: string, layout: PaneLayout, fields: Partial<Shell> = {}): Shell =>
  ({
    id,
    name: id,
    layout,
    endedPanes: [],
    stoppedPanes: [],
    exitCodes: {},
    busyPanes: [],
    panePorts: {},
    failedCommands: {},
    owner: { kind: 'agent', id: agent.sessionId },
    ...fields,
  }) as Shell;

describe("an agent's tabs", () => {
  it('is only the agent’s own tab, one pane, before it has any shells', () => {
    const tile = shell('tile', pane('x'), { owner: null });
    expect(windowTabs(byAgent, [tile])).toEqual([{ id: OWN_TAB, shell: undefined, layout: pane('agent-1'), label: 'claude' }]);
  });

  it("puts the agent's own tab first, then its shell tabs in the order they were made, and none of another's", () => {
    const zsh = shell('zsh', pane('p1'));
    const dev = shell('pnpm dev', pane('p2'));
    const others = shell('other', pane('p3'), { owner: { kind: 'agent', id: 'agent-2' } });
    const own = shell('own', split(pane('agent-1'), pane('p4')), { name: 'zsh 2' });

    const tabs = windowTabs(byAgent, [zsh, others, own, dev]);

    expect(tabs.map((tab) => tab.id)).toEqual([OWN_TAB, 'zsh', 'pnpm dev']);
    expect(tabs[0]).toMatchObject({ shell: own, layout: own.layout });
  });

  it('puts a tab moved in after the others, by its order, those made before tabs could move first', () => {
    const moved = shell('moved', pane('p1'), { tabOrder: 9 });
    const old = shell('old', pane('p2'), { tabOrder: null });
    const made = shell('made', pane('p3'), { tabOrder: 3 });

    expect(windowTabs(byAgent, [moved, made, old]).map((tab) => tab.id)).toEqual([OWN_TAB, 'old', 'made', 'moved']);
  });

  it('names a split own tab after every pane in it, the agent first', () => {
    const own = shell('own', split(pane('agent-1'), split(pane('p1', 'dev'), pane('p2'))), { name: 'zsh' });
    expect(windowTabs({ kind: 'agent', agent: { ...agent, harness: 'codex' } }, [own])[0]!.label).toBe('codex │ dev │ zsh');
  });
});

describe("an agent's shells", () => {
  it('lists every shell pane of its tabs, never the agent, with how each is doing', () => {
    const own = shell('own', split(pane('agent-1'), pane('p1')), { name: 'zsh', busyPanes: ['p1'] });
    const failed = shell('zsh 2', pane('p2'), { endedPanes: ['p2'], exitCodes: { p2: 1 } });
    const clean = shell('zsh 3', split(pane('p3', 'logs'), pane('p4')), { endedPanes: ['p3'], exitCodes: { p3: 0 } });
    const restarted = shell('zsh 4', pane('p5'), { endedPanes: ['p5'], stoppedPanes: ['p5'], exitCodes: { p5: null } });

    expect(windowShells(byAgent, [own, failed, clean, restarted])).toEqual([
      { tab: OWN_TAB, sessionId: 'p1', label: 'zsh', state: 'running' },
      { tab: 'zsh 2', sessionId: 'p2', label: 'zsh 2', state: 'failed', exitCode: 1 },
      { tab: 'zsh 3', sessionId: 'p3', label: 'logs', state: 'idle', exitCode: 0 },
      { tab: 'zsh 3', sessionId: 'p4', label: 'zsh 3', state: 'idle' },
      { tab: 'zsh 4', sessionId: 'p5', label: 'zsh 4', state: 'idle' },
    ]);
  });

  it("tells a running shell's ports, and calls one whose last command failed failed, with its status", () => {
    const dev = shell('dev', pane('p1'), { busyPanes: ['p1'], panePorts: { p1: [5173] } });
    const tests = shell('tests', pane('p2'), { failedCommands: { p2: 1 } });
    const rerun = shell('rerun', pane('p3'), { busyPanes: ['p3'], failedCommands: { p3: 1 } });

    expect(windowShells(byAgent, [dev, tests, rerun])).toEqual([
      { tab: 'dev', sessionId: 'p1', label: 'dev', state: 'running', ports: [5173] },
      { tab: 'tests', sessionId: 'p2', label: 'tests', state: 'failed', failedCommand: 1 },
      // Running again, it is running: the failure was the command before.
      { tab: 'rerun', sessionId: 'p3', label: 'rerun', state: 'running' },
    ]);
  });

  it('calls a shell ended by a signal failed', () => {
    const killed = shell('zsh', pane('p1'), { endedPanes: ['p1'], exitCodes: { p1: null } });
    expect(windowShells(byAgent, [killed])[0]).toMatchObject({ state: 'failed', exitCode: null });
  });

  it('counts the ones still running, never the agent: what its delete ends', () => {
    const own = shell('own', split(pane('agent-1'), pane('p1')));
    const ended = shell('zsh', split(pane('p2'), pane('p3')), { endedPanes: ['p3'] });
    expect(liveShellCount(byAgent, [own, ended])).toBe(2);
    expect(liveShellCount(byAgent, [])).toBe(0);
  });

  it('counts the ones still running in one tab: what closing it ends, and asks about first', () => {
    const [, ended, live] = windowTabs(byAgent, [shell('zsh', split(pane('p1'), pane('p2')), { endedPanes: ['p1', 'p2'] }), shell('dev', split(pane('p3'), pane('p4')), { endedPanes: ['p4'] })]);
    expect([tabLiveShells(ended!), tabLiveShells(live!)]).toEqual([0, 1]);
  });

  it('counts them on the chip, one in the singular', () => {
    expect([shellsChipLabel(1), shellsChipLabel(3)]).toEqual(['1 shell', '3 shells']);
  });
});

describe("a shell tile's tabs", () => {
  const tile = shell('tile', split(pane('t1'), pane('t2')), { name: 'Shell 1', owner: null, busyPanes: ['t2'] });
  const byTile: TabOwner = { kind: 'shell', shell: tile };
  const owned = (id: string, layout: PaneLayout, fields: Partial<Shell> = {}) => shell(id, layout, { owner: { kind: 'shell', id: 'tile' }, ...fields });

  it("is the tile's own panes first, named after the tile, then its tabs, and none of another tile's or agent's", () => {
    const zsh = owned('zsh', pane('p1'));
    const theirs = owned('theirs', pane('p2'), { owner: { kind: 'shell', id: 'tile-2' } });
    const agents = shell('agents', pane('p3'), { owner: { kind: 'agent', id: 'tile' } });

    expect(windowTabs(byTile, [tile, zsh, theirs, agents])).toEqual([
      { id: OWN_TAB, shell: tile, layout: tile.layout, label: 'Shell 1' },
      { id: 'zsh', shell: zsh, layout: zsh.layout, label: 'zsh' },
    ]);
  });

  it('lists every pane of every tab as a shell, its own included, and counts the live ones: what deleting the tile ends', () => {
    const dev = owned('dev', split(pane('p1'), pane('p2')), { endedPanes: ['p2'], exitCodes: { p2: 2 } });

    expect(windowShells(byTile, [tile, dev])).toEqual([
      { tab: OWN_TAB, sessionId: 't1', label: 'Shell 1', state: 'idle' },
      { tab: OWN_TAB, sessionId: 't2', label: 'Shell 1', state: 'running' },
      { tab: 'dev', sessionId: 'p1', label: 'dev', state: 'idle' },
      { tab: 'dev', sessionId: 'p2', label: 'dev', state: 'failed', exitCode: 2 },
    ]);
    expect(liveShellCount(byTile, [tile, dev])).toBe(3);
  });
});

describe('⌘1–9', () => {
  const tabs = ['a', 'b', 'c'];
  it('picks the tab by its place, 9 the last as in a browser, and none past the end', () => {
    expect([tabAtDigit(tabs, 1), tabAtDigit(tabs, 3), tabAtDigit(tabs, 9), tabAtDigit(tabs, 4)]).toEqual(['a', 'c', 'c', undefined]);
  });
});

describe("a window's surfaces", () => {
  const other = { sessionId: 'agent-2', harness: 'codex', name: 'impl-auth' } as Agent;
  const tile = shell('tile', pane('t1'), { name: 'Shell 1', owner: null });
  const tabbedTile = shell('tabbed', pane('t2'), { name: 'Shell 2' });
  const targets = { agents: [agent, other], tiles: [tile, tabbedTile] };
  const session = (kind: 'agent' | 'shell', id: string): Surface => ({ kind: 'session', target: { kind, id } });

  it('is its own, then its shell tabs, then the other sessions its layout shows that are still there, each named', () => {
    const zsh = shell('zsh', pane('p1'));
    const shown = [session('agent', 'agent-2'), session('shell', 'tile'), session('agent', 'gone'), session('shell', 'tabbed')];

    const surfaces = windowSurfaces(byAgent, [zsh, tile], shown, targets);

    expect(surfaces.map((each) => [each.key, each.label, each.kind])).toEqual([
      ['own', 'claude', 'tab'],
      ['shell:zsh', 'zsh', 'tab'],
      ['session:agent:agent-2', 'impl-auth', 'agent'],
      ['session:shell:tile', 'Shell 1', 'tile'],
    ]);
    expect(surfaces.map((each) => each.surface)).toEqual([{ kind: 'own' }, { kind: 'shell', shellId: 'zsh' }, session('agent', 'agent-2'), session('shell', 'tile')]);
  });

  it('never shows the window its own session as another', () => {
    expect(windowSurfaces(byAgent, [], [session('agent', 'agent-1')], targets).map((each) => each.key)).toEqual(['own']);
  });

  it('keys a tab as the layout does', () => {
    expect([tabKey(OWN_TAB), tabKey('zsh')]).toEqual(['own', 'shell:zsh']);
  });

  it('offers the other agents and shell tiles not shown yet, never itself or a tab', () => {
    const choices = sessionChoices(byAgent, [session('shell', 'tile')], { ...targets, tiles: [tile, tabbedTile, shell('more', pane('t3'), { name: 'Shell 3', owner: null })] });
    expect(choices.map((choice) => [choice.label, choice.surface])).toEqual([
      ['impl-auth', session('agent', 'agent-2')],
      ['Shell 3', session('shell', 'more')],
    ]);
  });
});
