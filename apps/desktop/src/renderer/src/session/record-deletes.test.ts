import { describe, expect, it } from 'vitest';
import type { AgentRecord } from '@agent-board/daemon/protocol';
import type { ToastOptions } from '../ui';
import { recordDeleter } from './record-deletes';

const record = (key: string): AgentRecord => ({ kind: 'pr', key, url: `https://github.com/${key.replace('#', '/pull/')}`, title: null, recordedAt: '', deletedAt: null });

function setup() {
  const calls: string[] = [];
  const toasts: ToastOptions[] = [];
  const deleter = recordDeleter({
    set: async (each, deleted) => void calls.push(`${deleted ? 'delete' : 'restore'} ${each.key}`),
    toast: (options) => void toasts.push(options),
    fade: (key) => void calls.push(`fade ${key}`),
    unfade: (key) => void calls.push(`unfade ${key}`),
  });
  return { calls, toasts, deleter };
}

describe('deleting a record from the sidebar', () => {
  it('deletes it at once, its row fading, with Undo in a toast that brings it back', () => {
    const { calls, toasts, deleter } = setup();
    deleter.remove(record('acme/web#236'), '#236');
    expect(calls).toEqual(['fade acme/web#236', 'delete acme/web#236']);
    expect(toasts).toEqual([expect.objectContaining({ message: 'Deleted the #236 record', action: expect.objectContaining({ label: 'Undo' }) })]);

    toasts[0]!.action!.onClick();
    expect(calls.slice(2)).toEqual(['unfade acme/web#236', 'restore acme/web#236']);
  });

  it("brings back every record a section's Show is for", () => {
    const { calls, toasts, deleter } = setup();
    deleter.restore([record('acme/web#1'), record('acme/web#2')]);
    expect(calls).toEqual(['restore acme/web#1', 'restore acme/web#2']);
    expect(toasts).toEqual([]);
  });
});
