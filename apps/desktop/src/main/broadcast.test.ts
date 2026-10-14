import { describe, expect, it, vi } from 'vitest';
import type { DaemonEvent } from '@agent-board/daemon/protocol';
import { forwardEvents, sendToAllWindows } from './broadcast';

/** Every window's web contents, as Electron would list them. */
const contents = vi.hoisted(() => [] as { destroyed: boolean; sent: unknown[][] }[]);

vi.mock('electron', () => ({
  webContents: {
    getAllWebContents: () =>
      contents.map((window) => ({
        isDestroyed: () => window.destroyed,
        send: (...args: unknown[]) => window.sent.push(args),
      })),
  },
}));

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
    const other: DaemonEvent = { type: 'item.removed', id: 'i1' };
    daemon.emit(removed);
    daemon.emit(other);

    expect(sent).toEqual([['zones:changed', removed]]);
  });
});

describe('sendToAllWindows', () => {
  it('sends to every window but those already destroyed, which would throw', () => {
    const open = { destroyed: false, sent: [] as unknown[][] };
    const closing = { destroyed: true, sent: [] as unknown[][] };
    contents.push(open, closing);

    sendToAllWindows('windows:returned', 'agent:a1', 'closed');

    expect(open.sent).toEqual([['windows:returned', 'agent:a1', 'closed']]);
    expect(closing.sent).toEqual([]);
  });
});
