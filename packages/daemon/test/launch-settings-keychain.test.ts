import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import type { CredentialStore } from '@agent-board/tracker';
import { createMemoryCredentialStore } from '@agent-board/tracker/testing';
import { createLaunchSettingsKeeper, launchSettingsAccount } from '../src/launch-settings-keychain.ts';
import { createLaunchSettingsStore } from '../src/launch-settings-store.ts';
import { launchSettingNames } from '../src/launch-settings.ts';
import { migrate } from '../src/migrate.ts';
import { tempDataDir } from './helpers.ts';

const SECRET = 'sk-a-secret-value-of-its-own';
const SETTINGS = { env: { API_TOKEN: SECRET }, settings: { model: 'opus' } };

/** A board database in a file, as the daemon opens it, with one agent row per id. */
function board(ids: string[] = ['agent-1']) {
  const path = join(tempDataDir(), 'agent-board.db');
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  migrate(db);
  // Rows with no zone or repo of their own: only their launch settings are read.
  db.exec('PRAGMA foreign_keys = OFF');
  onTestFinished(() => db.close());
  const insert = db.prepare(
    `INSERT INTO agents (session_id, name, description, branch, worktree, state, repo_root, codex_bypass_hook_trust)
     VALUES (?, ?, '', 'main', '/repo', 'done', '/repo', 0)`,
  );
  for (const id of ids) insert.run(id, `agent ${id}`);
  const column = (id: string) => (db.prepare('SELECT launch_settings FROM agents WHERE session_id = ?').get(id) as { launch_settings: string | null }).launch_settings;
  const setColumn = (id: string, value: string | null) => db.prepare('UPDATE agents SET launch_settings = ? WHERE session_id = ?').run(value, id);
  /** The database's bytes on disk, its write-ahead log's too. */
  const onDisk = () => [path, `${path}-wal`].map((file) => { try { return readFileSync(file).toString('latin1'); } catch { return ''; } }).join('');
  return { db, path, column, setColumn, onDisk };
}

function keeper(db: DatabaseSync, credentials: CredentialStore = createMemoryCredentialStore(), timeoutMs?: number) {
  const logs: string[] = [];
  return { keeper: createLaunchSettingsKeeper({ db, credentials, log: (message) => void logs.push(message), timeoutMs }), logs };
}

/** A promise and the function that settles it. */
function later<T = void>() {
  let settle!: (value: T) => void;
  const promise = new Promise<T>((resolve) => (settle = resolve));
  return { promise, settle };
}

/** A keychain whose reads fail until `healed` is set. */
function failingKeychain() {
  const store = createMemoryCredentialStore();
  const state = { healed: false, reads: 0 };
  const credentials: CredentialStore = {
    ...store,
    get: async (account) => {
      state.reads++;
      if (!state.healed) throw new Error('the keychain is locked');
      return store.get(account);
    },
  };
  return { store, credentials, state };
}

describe('launch settings kept in the keychain', () => {
  it('keeps the values in the keychain and only the names in the row, and gives them back for each launch', async () => {
    const { db, column, onDisk } = board();
    const credentials = createMemoryCredentialStore();
    const { keeper: kept } = keeper(db, credentials);
    await kept.open();
    await kept.put('agent-1', SETTINGS);

    expect(kept.get('agent-1')).toEqual(SETTINGS);
    expect(launchSettingNames(column('agent-1'))).toEqual({ env: ['API_TOKEN'], settings: ['model'] });
    expect(column('agent-1')).not.toContain(SECRET);
    expect(onDisk()).not.toContain(SECRET);
    expect(credentials.secrets.has(launchSettingsAccount('agent-1'))).toBe(true);
  });

  it('reads them back from the keychain as the daemon starts again', async () => {
    const { db } = board();
    const credentials = createMemoryCredentialStore();
    await keeper(db, credentials).keeper.put('agent-1', SETTINGS);

    const { keeper: next } = keeper(db, credentials);
    await next.open();
    expect(next.get('agent-1')).toEqual(SETTINGS);
  });

  it("moves an older build's values out of the database, overwriting them in the file and its write-ahead log", async () => {
    const { db, column, setColumn, onDisk } = board(['agent-1', 'agent-2']);
    setColumn('agent-1', JSON.stringify(SETTINGS));
    expect(onDisk()).toContain(SECRET);
    const credentials = createMemoryCredentialStore();
    const { keeper: kept, logs } = keeper(db, credentials);
    await kept.open();

    expect(kept.get('agent-1')).toEqual(SETTINGS);
    expect(kept.get('agent-2')).toBeUndefined();
    expect(launchSettingNames(column('agent-1'))).toEqual({ env: ['API_TOKEN'], settings: ['model'] });
    expect(onDisk()).not.toContain(SECRET);
    expect(logs).toContain('moved the launch settings of 1 agent from the database to the keychain');
    expect(credentials.secrets.size).toBe(1);
  });

  it('launches with them still when they could not be moved, and moves them at a later start', async () => {
    const { db, column, setColumn } = board();
    setColumn('agent-1', JSON.stringify(SETTINGS));
    const store = createMemoryCredentialStore();
    const refusing: CredentialStore = { ...store, set: async () => { throw new Error('no keychain'); } };
    const { keeper: kept, logs } = keeper(db, refusing);
    await kept.open();
    expect(kept.get('agent-1')).toEqual(SETTINGS);
    expect(logs.join('\n')).toMatch(/stay in the database until the next start: no keychain/);
    expect(column('agent-1')).toContain(SECRET);

    await keeper(db, store).keeper.open();
    expect(column('agent-1')).not.toContain(SECRET);
  });

  it('starts one whose item is gone from the keychain without them, its tile naming none', async () => {
    const { db, column } = board();
    const credentials = createMemoryCredentialStore();
    await keeper(db, credentials).keeper.put('agent-1', SETTINGS);
    credentials.secrets.clear();

    const { keeper: next, logs } = keeper(db, credentials);
    await next.open();
    expect(next.get('agent-1')).toBeUndefined();
    expect(column('agent-1')).toBeNull();
    expect(logs).toContain("agent-1's launch settings are not in the keychain, so it starts without them");
  });

  it("refuses a launch while the keychain can't be read, and reads it again for the next try", async () => {
    const { db, column } = board();
    const { store, credentials, state } = failingKeychain();
    await keeper(db, store).keeper.put('agent-1', SETTINGS);

    const { keeper: next } = keeper(db, credentials);
    await next.open();
    expect(() => next.get('agent-1')).toThrow("its launch settings could not be read from the keychain: the keychain is locked. Try again");
    // The names stay: the item may still be there.
    expect(column('agent-1')).not.toBeNull();

    state.healed = true;
    expect(() => next.get('agent-1')).toThrow(/Try again/);
    await vi.waitFor(() => expect(next.get('agent-1')).toEqual(SETTINGS));
    expect(state.reads).toBeGreaterThanOrEqual(3);
  });

  it('deletes the item when the agent is removed, or its settings are cleared', async () => {
    const { db, column } = board(['agent-1', 'agent-2']);
    const credentials = createMemoryCredentialStore();
    const { keeper: kept } = keeper(db, credentials);
    await kept.put('agent-1', SETTINGS);
    await kept.put('agent-2', SETTINGS);

    db.prepare("DELETE FROM agents WHERE session_id = 'agent-1'").run();
    await kept.forget('agent-1');
    expect(credentials.secrets.has(launchSettingsAccount('agent-1'))).toBe(false);
    expect(kept.get('agent-1')).toBeUndefined();

    await kept.put('agent-2', { env: {}, settings: {} });
    expect(credentials.secrets.has(launchSettingsAccount('agent-2'))).toBe(false);
    expect(column('agent-2')).toBeNull();
    expect(kept.get('agent-2')).toBeUndefined();
  });

  it('keeps nothing when the keychain refuses a write, and says why', async () => {
    const { db, column } = board();
    const store = createMemoryCredentialStore();
    const refusing: CredentialStore = { ...store, set: async () => { throw new Error('no keychain on this system'); } };
    const { keeper: kept } = keeper(db, refusing);
    await expect(kept.put('agent-1', SETTINGS)).rejects.toThrow('its launch settings could not be kept in the keychain: no keychain on this system');
    expect(column('agent-1')).toBeNull();
    expect(kept.get('agent-1')).toBeUndefined();
  });

  it('logs a failed delete, never throwing', async () => {
    const { db } = board();
    const store = createMemoryCredentialStore();
    const failing: CredentialStore = { ...store, delete: async () => { throw new Error('locked'); } };
    const { keeper: kept, logs } = keeper(db, failing);
    await kept.put('agent-1', SETTINGS);
    await expect(kept.forget('agent-1')).resolves.toBeUndefined();
    expect(logs).toContain("could not delete agent-1's launch settings from the keychain: locked");
  });

  it("never holds the start up on a keychain that doesn't answer, and launches each agent once it has", async () => {
    // More than it reads at once, so some are still waiting their turn when the start stops waiting.
    const ids = Array.from({ length: 8 }, (_, index) => `agent-${index}`);
    const { db } = board(ids);
    const store = createMemoryCredentialStore();
    const first = keeper(db, store).keeper;
    for (const id of ids) await first.put(id, SETTINGS);
    const answer = later();
    const slow: CredentialStore = { ...store, get: async (account) => (await answer.promise, store.get(account)) };

    const { keeper: next, logs } = keeper(db, slow, 50);
    const started = Date.now();
    await next.open();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(logs).toContain("the keychain hasn't given every agent's launch settings yet: an agent it hasn't launches once it has");
    expect(() => next.get('agent-0')).toThrow(/Try again/);

    answer.settle();
    for (const id of ids) await vi.waitFor(() => expect(next.get(id)).toEqual(SETTINGS));
  });

  it('fails a keychain call that takes too long, so the next launch asks again', async () => {
    const { db } = board();
    const store = createMemoryCredentialStore();
    await keeper(db, store).keeper.put('agent-1', SETTINGS);
    const stuck: CredentialStore = { ...store, get: () => new Promise(() => {}) };
    const { keeper: next } = keeper(db, stuck, 20);
    await next.open();
    await vi.waitFor(() => expect(() => next.get('agent-1')).toThrow('the keychain did not answer within 0.02 s. Try again'));
  });

  it('reads a few agents from the keychain at a time as it starts', async () => {
    const ids = Array.from({ length: 10 }, (_, index) => `agent-${index}`);
    const { db } = board(ids);
    const store = createMemoryCredentialStore();
    const first = keeper(db, store).keeper;
    for (const id of ids) await first.put(id, SETTINGS);
    let running = 0;
    let most = 0;
    const counting: CredentialStore = {
      ...store,
      get: async (account) => {
        most = Math.max(most, ++running);
        await new Promise((resolve) => setTimeout(resolve, 5));
        running--;
        return store.get(account);
      },
    };
    const { keeper: next } = keeper(db, counting);
    await next.open();
    expect(most).toBe(4);
    for (const id of ids) expect(next.get(id)).toEqual(SETTINGS);
  });

  it('keeps what the last call gave when two writes overlap, whichever the keychain finishes first', async () => {
    const { db, column } = board();
    const store = createMemoryCredentialStore();
    const firstWrite = later();
    let writes = 0;
    const slowFirst: CredentialStore = {
      ...store,
      set: async (account, secret) => {
        if (writes++ === 0) await firstWrite.promise;
        await store.set(account, secret);
      },
    };
    const { keeper: kept } = keeper(db, slowFirst);
    const old = kept.put('agent-1', { env: { OLD: '1' } });
    const next = kept.put('agent-1', { env: { NEW: '1' } });
    firstWrite.settle();
    await Promise.all([old, next]);

    expect(kept.get('agent-1')).toEqual({ env: { NEW: '1' } });
    expect(launchSettingNames(column('agent-1'))).toEqual({ env: ['NEW'], settings: [] });
    const { keeper: restarted } = keeper(db, store);
    await restarted.open();
    expect(restarted.get('agent-1')).toEqual({ env: { NEW: '1' } });
  });

  it("never lets a write the keychain was slow to answer land after the next one", async () => {
    const { db, column } = board();
    const store = createMemoryCredentialStore();
    const firstWrite = later();
    let writes = 0;
    const slowFirst: CredentialStore = {
      ...store,
      set: async (account, secret) => {
        if (writes++ === 0) await firstWrite.promise;
        await store.set(account, secret);
      },
    };
    const { keeper: kept } = keeper(db, slowFirst, 200);
    await expect(kept.put('agent-1', { env: { OLD: '1' } })).rejects.toThrow('could not be kept in the keychain: the keychain did not answer within 0.2 s');
    // The next waits for the first to be really done, then lands over it.
    const next = kept.put('agent-1', { env: { NEW: '1' } });
    firstWrite.settle();
    await next;
    expect(kept.get('agent-1')).toEqual({ env: { NEW: '1' } });
    expect(launchSettingNames(column('agent-1'))).toEqual({ env: ['NEW'], settings: [] });
    const { keeper: restarted } = keeper(db, store);
    await restarted.open();
    expect(restarted.get('agent-1')).toEqual({ env: { NEW: '1' } });
  });

  it('never makes a write whose caller stopped waiting before its turn came', async () => {
    const { db, column } = board();
    const store = createMemoryCredentialStore();
    const firstWrite = later();
    let writes = 0;
    const slowFirst: CredentialStore = {
      ...store,
      set: async (account, secret) => {
        if (writes++ === 0) await firstWrite.promise;
        await store.set(account, secret);
      },
    };
    const { keeper: kept } = keeper(db, slowFirst, 50);
    const first = kept.put('agent-1', { env: { FIRST: '1' } });
    const second = kept.put('agent-1', { env: { SECOND: '1' } });
    await expect(first).rejects.toThrow(/did not answer/);
    await expect(second).rejects.toThrow(/did not answer/);
    // The first answers at last: what it kept, the row names; the second never reached the keychain.
    firstWrite.settle();
    await vi.waitFor(() => expect(launchSettingNames(column('agent-1'))).toEqual({ env: ['FIRST'], settings: [] }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(writes).toBe(1);
    expect(kept.get('agent-1')).toEqual({ env: { FIRST: '1' } });
  });

  it('deletes the item of a removed agent whose row no longer named it', async () => {
    const { db, setColumn } = board();
    const credentials = createMemoryCredentialStore();
    const { keeper: kept } = keeper(db, credentials);
    await kept.put('agent-1', SETTINGS);
    setColumn('agent-1', null);
    await kept.forget('agent-1');
    expect(credentials.secrets.size).toBe(0);
  });

  it("leaves an older build's values too long for the keychain in the database, and says what to do", async () => {
    const { db, column, setColumn } = board();
    const long = { env: { API_TOKEN: SECRET, LONG: 'x'.repeat(3_000) } };
    setColumn('agent-1', JSON.stringify(long));
    const credentials = createMemoryCredentialStore();
    const { keeper: kept, logs } = keeper(db, credentials);
    await kept.open();
    expect(kept.get('agent-1')).toEqual(long);
    expect(column('agent-1')).toContain(SECRET);
    expect(credentials.secrets.size).toBe(0);
    expect(logs).toContain("agent-1's launch settings are too long for the keychain, so they stay in the database: restart it with shorter ones, or none");
  });
});

describe('the launch settings store', () => {
  const account = launchSettingsAccount('agent-1');

  it('keeps each value in a file only the user can read where the system has no keychain', async () => {
    const dir = join(tempDataDir(), 'values');
    const keychain = createMemoryCredentialStore();
    const store = createLaunchSettingsStore({ keychain, availability: 'no', dir });
    expect(await store.get(account)).toBeUndefined();
    await store.set(account, 'c2VjcmV0');
    expect(await store.get(account)).toBe('c2VjcmV0');
    expect(statSync(join(dir, account)).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(keychain.secrets.size).toBe(0);
    await store.delete(account);
    expect(existsSync(join(dir, account))).toBe(false);
    await expect(store.set('../escape', 'x')).rejects.toThrow('that is not a valid account name');
  });

  it('deletes with a value any copy a write cut short left beside it, and no other account\'s', async () => {
    const dir = join(tempDataDir(), 'values');
    const store = createLaunchSettingsStore({ keychain: createMemoryCredentialStore(), availability: 'no', dir });
    await store.set(account, 'c2VjcmV0');
    const other = launchSettingsAccount('agent-2');
    await store.set(other, 'b3RoZXI=');
    writeFileSync(join(dir, `${account}.0b5c1a8e-2f4d-4c3b-9a1e-7d6f5e4c3b2a.partial`), 'c2VjcmV0', { mode: 0o600 });
    writeFileSync(join(dir, `${other}.0b5c1a8e-2f4d-4c3b-9a1e-7d6f5e4c3b2a.partial`), 'b3RoZXI=', { mode: 0o600 });
    await store.delete(account);
    expect(readdirSync(dir).sort()).toEqual([other, `${other}.0b5c1a8e-2f4d-4c3b-9a1e-7d6f5e4c3b2a.partial`]);
  });

  it("can't say a value is gone while the keychain that may hold it can't be reached", async () => {
    const dir = join(tempDataDir(), 'values');
    const store = createLaunchSettingsStore({ keychain: createMemoryCredentialStore(), availability: 'not-running', dir });
    await expect(store.get(account)).rejects.toThrow("the keychain can't be reached here");
    await store.set(account, 'aGVhZGxlc3M=');
    expect(await store.get(account)).toBe('aGVhZGxlc3M=');
  });

  it('moves a value a file kept to the keychain at its next write, once there is one', async () => {
    const dir = join(tempDataDir(), 'values');
    await createLaunchSettingsStore({ keychain: createMemoryCredentialStore(), availability: 'not-running', dir }).set(account, 'b2xk');
    const keychain = createMemoryCredentialStore();
    const store = createLaunchSettingsStore({ keychain, availability: 'yes', dir });
    expect(await store.get(account)).toBe('b2xk');
    // What the keychain holds wins over a file left from before.
    await keychain.set(account, 'a2V5Y2hhaW4=');
    expect(await store.get(account)).toBe('a2V5Y2hhaW4=');
    await store.set(account, 'bmV3');
    expect(existsSync(join(dir, account))).toBe(false);
    expect(keychain.secrets.get(account)).toBe('bmV3');
    expect(await store.get(account)).toBe('bmV3');
    await store.delete(account);
    expect(keychain.secrets.size).toBe(0);
  });
});
