import { beforeEach, describe, expect, it, vi } from 'vitest';

const KEY = 'agent-board.session-views';
/** Where a build from before there were three views kept the chats picked: read once, never written. */
const OLD_KEY = 'agent-board.chat-sessions';
let storage = new Map<string, string>();

describe('the view picked for a session', () => {
  beforeEach(() => {
    vi.resetModules();
    storage = new Map();
    vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
  });

  it('is the terminal until the chat is picked, and per session', async () => {
    const { chosenView, setChosenView } = await import('./session-view');
    expect(chosenView('a')).toBe('terminal');
    setChosenView('a', 'chat');
    expect(chosenView('a')).toBe('chat');
    expect(chosenView('b')).toBe('terminal');
    setChosenView('a', 'terminal');
    expect(chosenView('a')).toBe('terminal');
  });

  it('is the view windows open on until one is picked, and a pick of either outlasts a change of it', async () => {
    const { chosenView, setChosenView } = await import('./session-view');
    expect(chosenView('a', 'chat')).toBe('chat');
    setChosenView('a', 'terminal');
    setChosenView('b', 'timeline');
    expect(chosenView('a', 'chat')).toBe('terminal');
    expect(chosenView('b', 'chat')).toBe('timeline');
    expect(chosenView('b', 'terminal')).toBe('timeline');
    expect(chosenView('c', 'terminal')).toBe('terminal');
  });

  it('reads the chats picked before there were three views as chats, and leaves them as they were for an older build', async () => {
    storage.set(OLD_KEY, JSON.stringify(['a']));
    const { chosenView, setChosenView } = await import('./session-view');
    expect(chosenView('a', 'terminal')).toBe('chat');
    expect(chosenView('b', 'chat')).toBe('chat');
    expect(chosenView('b', 'terminal')).toBe('terminal');
    setChosenView('b', 'timeline');
    expect(JSON.parse(storage.get(KEY)!)).toEqual({ a: 'chat', b: 'timeline' });
    expect(storage.get(OLD_KEY)).toBe(JSON.stringify(['a']));
    // Once there are picks of its own, the old list is no longer read.
    storage.set(OLD_KEY, JSON.stringify(['c']));
    expect(chosenView('c')).toBe('terminal');
  });

  it('outlasts a reload', async () => {
    const first = await import('./session-view');
    first.setChosenView('a', 'chat');
    first.setChosenView('b', 'timeline');
    vi.resetModules();
    const second = await import('./session-view');
    expect(second.chosenView('a')).toBe('chat');
    expect(second.chosenView('b')).toBe('timeline');
  });

  it('has no view for no session but the one windows open on', async () => {
    const { chosenView } = await import('./session-view');
    expect(chosenView(undefined)).toBe('terminal');
    expect(chosenView(undefined, 'chat')).toBe('chat');
  });

  it('sees a pick another window made while nothing here was listening, and a write here keeps it', async () => {
    const { chosenView, forgetViewsExcept, setChosenView } = await import('./session-view');
    expect(chosenView('a')).toBe('terminal');
    // A pop-out picked the chat of "a"; no subscriber was mounted here.
    storage.set(KEY, JSON.stringify({ a: 'chat' }));
    expect(chosenView('a')).toBe('chat');
    setChosenView('b', 'chat');
    expect(JSON.parse(storage.get(KEY)!)).toEqual({ a: 'chat', b: 'chat' });
    // The pop-out puts "a" back on the terminal; this window's next write must not bring the chat back.
    storage.set(KEY, JSON.stringify({ a: 'terminal', b: 'chat' }));
    forgetViewsExcept(['a', 'b']);
    expect(chosenView('a')).toBe('terminal');
    expect(JSON.parse(storage.get(KEY)!)).toEqual({ a: 'terminal', b: 'chat' });
  });

  it('ignores what it cannot read', async () => {
    storage.set(KEY, JSON.stringify({ a: 'chat', b: 'sideways', c: 3 }));
    const { chosenView } = await import('./session-view');
    expect(chosenView('a')).toBe('chat');
    expect(chosenView('b')).toBe('terminal');
    expect(chosenView('c', 'chat')).toBe('chat');
  });

  it('tells its listeners of a change another window announces', async () => {
    const listeners = new Map<string, (event: { key: string | null }) => void>();
    vi.stubGlobal('window', { addEventListener: (type: string, listener: never) => listeners.set(type, listener), removeEventListener: (type: string) => listeners.delete(type) });
    const { onSessionViews } = await import('./session-view');
    const heard = vi.fn();
    const stop = onSessionViews(heard);
    listeners.get('storage')!({ key: 'something-else' });
    expect(heard).not.toHaveBeenCalled();
    listeners.get('storage')!({ key: KEY });
    expect(heard).toHaveBeenCalledTimes(1);
    stop();
    expect(listeners.size).toBe(0);
  });

  it('forgets the sessions of deleted agents', async () => {
    const { chosenView, forgetViewsExcept, setChosenView } = await import('./session-view');
    setChosenView('kept', 'chat');
    setChosenView('deleted', 'chat');
    forgetViewsExcept(['kept', 'other']);
    expect(chosenView('kept')).toBe('chat');
    expect(chosenView('deleted')).toBe('terminal');
    expect(JSON.parse(storage.get(KEY)!)).toEqual({ kept: 'chat' });
  });

  it('keeps the choice for the run when storage cannot be written', async () => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => { throw new Error('full'); } });
    const { chosenView, setChosenView } = await import('./session-view');
    setChosenView('a', 'chat');
    expect(chosenView('a')).toBe('chat');
  });
});
