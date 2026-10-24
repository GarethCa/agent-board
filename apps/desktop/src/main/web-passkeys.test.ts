import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import type { WebContents } from 'electron';
import { passkeyAsked, passkeyNotice, passkeyProbe, passkeysUnavailable, probePasskeys } from './web-passkeys';

const PASSKEY_ASKED = passkeyAsked('a-tabs-secret');
const PASSKEY_PROBE = passkeyProbe('a-tabs-secret');

/** A web contents with only what the probe touches: it records the scripts it is asked to run. */
function fakeContents() {
  return Object.assign(new EventEmitter(), {
    scripts: [] as string[],
    executeJavaScript(script: string) {
      this.scripts.push(script);
      return Promise.resolve();
    },
  });
}

/** Runs the probe against a page whose credentials reject with `error`; returns what the page logged and the wrapped `navigator`. */
function runProbe(error: { name: string }) {
  const logged: unknown[] = [];
  const calls: unknown[] = [];
  const credentials: Record<string, unknown> = {
    get: (options: unknown) => (calls.push(options), Promise.reject(error)),
    create: (options: unknown) => (calls.push(options), Promise.reject(error)),
  };
  vm.runInNewContext(PASSKEY_PROBE, { navigator: { credentials }, console: { debug: (message: unknown) => logged.push(message) }, Object });
  return { credentials: credentials as Record<'get' | 'create', (options: unknown) => Promise<unknown>>, logged, calls };
}

describe('passkeysUnavailable', () => {
  it('holds on macOS only, where Electron has no passkeys for an arbitrary site', () => {
    expect(passkeysUnavailable('darwin')).toBe(true);
    expect(passkeysUnavailable('win32')).toBe(false);
    expect(passkeysUnavailable('linux')).toBe(false);
  });
});

describe('probePasskeys', () => {
  /** The message the probe the contents was last given logs, as its script holds it, after a page is ready. */
  const messageOf = (contents: ReturnType<typeof fakeContents>) => {
    contents.emit('dom-ready');
    return /\u2063agent-board:passkey-asked:[\w-]+/.exec(contents.scripts.at(-1) ?? '')![0];
  };

  it('runs the probe when a page is ready, and tells of each request it logs', () => {
    const contents = fakeContents();
    let asked = 0;
    probePasskeys(contents as unknown as WebContents, 'darwin', () => (asked += 1));
    const message = messageOf(contents);
    expect(contents.scripts[0]).toBe(passkeyProbe(message.split(':').at(-1)!));
    contents.emit('console-message', { message: 'hello' });
    expect(asked).toBe(0);
    contents.emit('console-message', { message });
    contents.emit('console-message', { message });
    expect(asked).toBe(2);
  });

  it("hears only its own page: a frame inside it, or another tab's page, can't make the message", () => {
    const contents = fakeContents();
    let asked = 0;
    probePasskeys(contents as unknown as WebContents, 'darwin', () => (asked += 1));
    const message = messageOf(contents);
    contents.emit('console-message', { message: passkeyAsked('guessed') });
    contents.emit('console-message', { message: `${message}x` });
    expect(asked).toBe(0);
    const other = fakeContents();
    probePasskeys(other as unknown as WebContents, 'darwin', () => {});
    expect(messageOf(other)).not.toBe(message);
  });

  it("gives each page a secret of its own: a message of the last page's is not heard", () => {
    const contents = fakeContents();
    let asked = 0;
    probePasskeys(contents as unknown as WebContents, 'darwin', () => (asked += 1));
    const first = messageOf(contents);
    const second = messageOf(contents);
    expect(second).not.toBe(first);
    contents.emit('console-message', { message: first });
    expect(asked).toBe(0);
    contents.emit('console-message', { message: second });
    expect(asked).toBe(1);
  });

  it('does nothing where passkeys can work', () => {
    const contents = fakeContents();
    probePasskeys(contents as unknown as WebContents, 'win32', () => {});
    expect(contents.listenerCount('dom-ready')).toBe(0);
    expect(contents.listenerCount('console-message')).toBe(0);
  });
});

describe('the probe a page runs', () => {
  it('logs when a public key is asked for, and hands the request on untouched', async () => {
    const { credentials, logged, calls } = runProbe({ name: 'NotAllowedError' });
    const options = { publicKey: { challenge: new Uint8Array(32) } };
    await expect(credentials.get(options)).rejects.toMatchObject({ name: 'NotAllowedError' });
    await expect(credentials.create(options)).rejects.toMatchObject({ name: 'NotAllowedError' });
    expect(calls).toEqual([options, options]);
    expect(logged).toEqual([PASSKEY_ASKED, PASSKEY_ASKED]);
  });

  it('logs a request that never answers, as the page waits on it', () => {
    const logged: unknown[] = [];
    const credentials = { get: (...asked: unknown[]) => new Promise(() => void asked) };
    vm.runInNewContext(PASSKEY_PROBE, { navigator: { credentials }, console: { debug: (message: unknown) => logged.push(message) }, Object });
    credentials.get({ publicKey: {} });
    expect(logged).toEqual([PASSKEY_ASKED]);
  });

  it('says nothing of a request for autofill, which a page makes as it loads and is meant to stay pending', async () => {
    const { credentials, logged } = runProbe({ name: 'NotAllowedError' });
    await expect(credentials.get({ mediation: 'conditional', publicKey: {} })).rejects.toBeDefined();
    expect(logged).toEqual([]);
    await expect(credentials.get({ mediation: 'optional', publicKey: {} })).rejects.toBeDefined();
    expect(logged).toEqual([PASSKEY_ASKED]);
  });

  it("logs through the console's debug as it was when the probe ran, whatever the page does to it after", async () => {
    const logged: unknown[] = [];
    const console: { debug(message: unknown): unknown } = { debug: (message) => logged.push(message) };
    const credentials = { get: (...asked: unknown[]) => Promise.reject(new Error(String(asked.length))) };
    vm.runInNewContext(PASSKEY_PROBE, { navigator: { credentials }, console, Object });
    console.debug = () => {};
    await expect(credentials.get({ publicKey: {} })).rejects.toBeDefined();
    expect(logged).toEqual([PASSKEY_ASKED]);
  });

  it('says nothing of a password request', async () => {
    const { credentials, logged } = runProbe({ name: 'NotAllowedError' });
    await expect(credentials.get({ password: true })).rejects.toBeDefined();
    expect(logged).toEqual([]);
  });

  it('wraps once however often it runs', async () => {
    const { credentials, logged } = runProbe({ name: 'NotAllowedError' });
    const before = credentials.get;
    vm.runInNewContext(PASSKEY_PROBE, { navigator: { credentials }, console: { debug: () => {} }, Object });
    expect(credentials.get).toBe(before);
    await expect(credentials.get({ publicKey: {} })).rejects.toBeDefined();
    expect(logged).toHaveLength(1);
  });
});

describe('passkeyNotice', () => {
  it('shows once the page asks, tells of the change only, and hides when dismissed or the page goes elsewhere', () => {
    let changes = 0;
    const notice = passkeyNotice(() => (changes += 1));
    expect(notice.shown).toBe(false);
    notice.asked();
    notice.asked();
    notice.asked();
    expect(notice.shown).toBe(true);
    expect(changes).toBe(1);
    notice.clear();
    notice.clear();
    expect(notice.shown).toBe(false);
    expect(changes).toBe(2);
    notice.asked();
    expect(notice.shown).toBe(true);
    expect(changes).toBe(3);
  });
});
