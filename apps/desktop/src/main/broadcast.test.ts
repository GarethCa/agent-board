import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DaemonEvent } from '@agent-board/daemon/protocol';
import { markAppWindow } from './app-windows';
import { forwardEvents, sendToAllWindows } from './broadcast';

/** Every web contents, as Electron would list them: the app's windows, web tabs and plan views alike. */
const contents = vi.hoisted(() => [] as { destroyed: boolean; sent: unknown[][]; isDestroyed(): boolean; send(...args: unknown[]): void }[]);

vi.mock('electron', () => ({ webContents: { getAllWebContents: () => contents } }));

/** A web contents that keeps what it is sent; marked as an app window unless `app` is false. */
function webContentsOf({ destroyed = false, app = true } = {}) {
  const made = {
    destroyed,
    sent: [] as unknown[][],
    isDestroyed: () => made.destroyed,
    send: (...args: unknown[]) => made.sent.push(args),
  };
  if (app) markAppWindow(made as unknown as Electron.WebContents, () => true);
  contents.push(made);
  return made;
}

/** A daemon link that only takes event listeners, and a way to fire an event at them. */
function fakeDaemon() {
  const listeners = new Set<(event: DaemonEvent) => void>();
  return {
    onEvent(listener: (event: DaemonEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(event: DaemonEvent) {
      for (const listener of listeners) listener(event);
    },
  };
}

describe('forwardEvents', () => {
  it('sends each event of the given types on the channel, and no others', () => {
    const daemon = fakeDaemon();
    const sent: [string, unknown][] = [];
    forwardEvents(daemon, ['zone.updated', 'zone.removed'], 'zones:changed', (channel, event) => sent.push([channel, event]));

    const removed: DaemonEvent = { type: 'zone.removed', id: 'z1' };
    const other: DaemonEvent = { type: 'item.removed', id: 'i1', ticket: null };
    daemon.emit(removed);
    daemon.emit(other);

    expect(sent).toEqual([['zones:changed', removed]]);
  });
});

describe('sendToAllWindows', () => {
  beforeEach(() => {
    contents.length = 0;
  });

  it('sends to every window but those already destroyed, which would throw', () => {
    const open = webContentsOf();
    const closing = webContentsOf();
    closing.destroyed = true;

    sendToAllWindows('windows:returned', 'agent:a1', 'closed');

    expect(open.sent).toEqual([['windows:returned', 'agent:a1', 'closed']]);
    expect(closing.sent).toEqual([]);
  });

  it("reaches only the app's own windows: never a web tab's page or a plan's", () => {
    const board = webContentsOf();
    const popOut = webContentsOf();
    const webTab = webContentsOf({ app: false });
    const plan = webContentsOf({ app: false });

    sendToAllWindows('zones:changed', { type: 'zone.removed', id: 'z1' });

    expect(board.sent).toHaveLength(1);
    expect(popOut.sent).toHaveLength(1);
    expect(webTab.sent).toEqual([]);
    expect(plan.sent).toEqual([]);
  });
});
