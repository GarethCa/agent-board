import { describe, expect, it, vi } from 'vitest';
import type { Agent } from '@agent-board/daemon/protocol';
import { agentMenu, type ModelEntry } from '../board/menu-model';
import { galleryAgent } from '../board/TileGallery';
import type { TileActions } from '../board/tile';
import type { MenuEntry } from '../ui';
import { windowMenu } from './SimplifiedHeader';

const labels = (entries: MenuEntry[]) => entries.map((entry) => (entry === 'separator' ? '—' : 'label' in entry ? entry.label : 'heading' in entry ? `#${entry.heading}` : '?'));
const row = (id: string, label: string): ModelEntry => ({ id, label, onSelect: vi.fn() });
const live = { endedAt: null } as Agent;
const toggle = { current: vi.fn() };

describe("an agent window's ⋯ menu", () => {
  const board: ModelEntry[] = [row('restart', 'Restart agent'), row('pause', 'Pause'), 'separator', row('schedule', 'Schedule…'), 'separator', row('start-review', 'Review its work'), 'separator', row('delete', 'Delete agent')];

  it('on the board, has its run, then the window’s rows, its settings and reviews, then End agent… above Delete', () => {
    const entries = windowMenu({ agent: live, placement: 'board', terminalToggle: toggle, onPopOut: vi.fn(), onClose: vi.fn(), onEnd: vi.fn(), board });
    expect(labels(entries)).toEqual([
      'Restart agent',
      'Pause',
      '—',
      'Open in its own window',
      'Show terminal, or back',
      '—',
      'Schedule…',
      '—',
      'Review its work',
      '—',
      'End agent…',
      'Delete agent',
    ]);
  });

  it('has no End agent… for an agent that has ended, and leaves no separator doubled or at an end', () => {
    const entries = windowMenu({ agent: { endedAt: '2026-10-30T12:00:00Z' } as Agent, placement: 'board', terminalToggle: toggle, onClose: vi.fn(), onEnd: vi.fn(), board: ['separator', row('delete', 'Delete agent')] });
    expect(labels(entries)).toEqual(['Show terminal, or back', '—', 'Delete agent']);
  });

  it('popped out, which has no board to act for it, has the window’s rows and End agent… alone', () => {
    const onEnd = vi.fn();
    const entries = windowMenu({ agent: live, placement: 'own-window', terminalToggle: toggle, onPopIn: vi.fn(), onClose: vi.fn(), onEnd, board: [] });
    expect(labels(entries)).toEqual(['Back to board', 'Show terminal, or back', 'Close window', '—', 'End agent…']);
    const show = entries[1] as { onSelect(): void };
    show.onSelect();
    expect(toggle.current).toHaveBeenCalled();
  });

  describe("over the agent's own menu, as its tile has it", () => {
    const AT = '2026-10-30T12:00:00.000Z';
    const actions = new Proxy({}, { get: () => () => {} }) as TileActions;
    const menuOf = (agent: Agent) =>
      labels(
        windowMenu({
          agent,
          placement: 'board',
          terminalToggle: toggle,
          onPopOut: vi.fn(),
          onClose: vi.fn(),
          onEnd: vi.fn(),
          board: agentMenu({ nodeId: '', agent, clickOpens: 'window', gate: undefined, rounds: [], rename: () => {}, actions }),
        }),
      );

    it('keeps Restart for an agent that ended, at the top, with no End agent… and none of the tile’s ways to open it', () => {
      const rows = menuOf({ ...galleryAgent('done'), endedAt: AT });
      expect(rows[0]).toBe('Restart agent');
      expect(rows).not.toContain('End agent…');
      for (const gone of ['Expand in place', 'Open window', 'Pop out', 'Fold to a chip', 'Rename']) expect(rows).not.toContain(gone);
      expect(rows.at(-1)).toBe('Delete agent');
    });

    it('keeps Resume for an agent a restart stopped', () => {
      expect(menuOf({ ...galleryAgent('stopped-by-restart'), endedAt: AT })).toContain('Resume agent');
    });

    it('has End agent… above Delete, and Pause, for an agent at its prompt', () => {
      const rows = menuOf(galleryAgent('idle'));
      expect(rows).toContain('Pause');
      expect(rows.slice(-2)).toEqual(['End agent…', 'Delete agent']);
    });
  });
});
