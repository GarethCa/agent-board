import { readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { migrate } from '../src/migrate.ts';
import type { DaemonEvent } from '../src/protocol.ts';
import {
  SUBSCRIBER_HIGH_WATER_BYTES,
  chunk,
  createSessionHost,
  reconcileLostSessions,
  type SessionHostOptions,
  type SessionSubscriber,
} from '../src/sessions.ts';
import type { TerminalBackend, TerminalListener } from '../src/terminal-backend.ts';
import { tempDataDir } from './helpers.ts';

/** A backend whose terminals are driven by the test: `emit` output, `exit` the process. */
function fakeBackend() {
  const listeners = new Map<string, TerminalListener>();
  const calls: string[] = [];
  const backend: TerminalBackend = {
    spawn: ({ id }) => ({ id, pid: 4242 }),
    write: () => {},
    resize: (id, cols, rows) => void calls.push(`resize ${id} ${cols}x${rows}`),
    kill: (id, signal = 'SIGHUP') => void calls.push(`kill ${id} ${signal}`),
    pause: (id) => void calls.push(`pause ${id}`),
    resume: (id) => void calls.push(`resume ${id}`),
    attach(id, listener) {
      listeners.set(id, listener);
      return () => listeners.delete(id);
    },
    list: () => [],
  };
  return {
    backend,
    calls,
    emit: (id: string, data: string) => listeners.get(id)!.onData(data),
    exit: (id: string, exitCode = 0) => listeners.get(id)!.onExit({ exitCode }),
  };
}

function host(options: Partial<SessionHostOptions> & { db?: DatabaseSync } = {}) {
  const db = options.db ?? new DatabaseSync(':memory:');
  migrate(db);
  const fake = fakeBackend();
  const exited: DaemonEvent[] = [];
  const sessions = createSessionHost({
    db,
    backend: fake.backend,
    shell: '/bin/sh',
    shellArgs: [],
    broadcast: (event) => exited.push(event),
    log: () => {},
    ...options,
  });
  const session = sessions.createShell({ cols: 80, rows: 24, cwd: '/' });
  return { db, sessions, session, fake, exited };
}

/** A subscriber whose backlog the test sets, and whose drain it triggers. */
function fakeSubscriber(resizes?: SessionSubscriber['resizes']) {
  const events: DaemonEvent[] = [];
  let backlog = 0;
  let drained: (() => void) | undefined;
  const subscriber: SessionSubscriber = {
    send: (event) => void events.push(event),
    backlog: () => backlog,
    whenDrained: (callback) => void (drained = callback),
    ...(resizes === undefined ? {} : { resizes }),
  };
  return {
    subscriber,
    events,
    setBacklog: (bytes: number) => void (backlog = bytes),
    drain: () => {
      backlog = 0;
      drained?.();
    },
  };
}

/** Lets the headless model parse what it was written. */
const parsed = () => new Promise((resolve) => setTimeout(resolve, 20));

const outputs = (events: DaemonEvent[]) => events.flatMap((event) => (event.type === 'session.output' ? [event.data] : []));
const snapshots = (events: DaemonEvent[]) => events.filter((event) => event.type === 'session.snapshot');

describe('session host', () => {
  it('stops sending output to a subscriber that falls behind, and resyncs it with a snapshot once it drains', async () => {
    const { sessions, session, fake } = host();
    const client = fakeSubscriber();
    sessions.attach(session.id, client.subscriber);
    await parsed();
    fake.emit(session.id, 'one ');
    expect(outputs(client.events)).toEqual(['one ']);

    client.setBacklog(SUBSCRIBER_HIGH_WATER_BYTES + 1);
    fake.emit(session.id, 'two ');
    fake.emit(session.id, 'three ');
    expect(outputs(client.events)).toEqual(['one ']);

    client.drain();
    await parsed();
    fake.emit(session.id, 'four');

    const resync = snapshots(client.events)[1];
    expect(resync).toMatchObject({ type: 'session.snapshot', data: expect.stringContaining('one two three') });
    expect(client.events.at(-1)).toMatchObject({ type: 'session.output', data: 'four' });
  });

  it('allows a subscriber the backlog its own snapshot left before it counts as behind', async () => {
    const { sessions, session, fake } = host();
    const client = fakeSubscriber();
    client.setBacklog(SUBSCRIBER_HIGH_WATER_BYTES * 2); // e.g. a big snapshot still on its way
    sessions.attach(session.id, client.subscriber);
    await parsed();

    fake.emit(session.id, 'next');

    expect(outputs(client.events)).toEqual(['next']);
  });

  it('pauses the terminal while the model has too much output to parse, and resumes it after', async () => {
    const { session, fake } = host();

    fake.emit(session.id, 'x'.repeat(2 * 1024 * 1024));

    expect(fake.calls).toEqual([`pause ${session.id}`]);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(fake.calls).toEqual([`pause ${session.id}`, `resume ${session.id}`]);
  });

  it('starts an ended session again under the same id, with a new hook token, and refuses one still live', async () => {
    const { db, sessions, session, fake } = host();
    const spec = { id: session.id, harness: null, command: '/bin/sh', args: [], cwd: '/', env: {}, cols: 80, rows: 24 };
    expect(() => sessions.start({ ...spec, hookTokenSha256: 'second' })).toThrow(/still live/);

    fake.exit(session.id, 1);
    await sessions.kill(session.id, 'a test');
    const again = sessions.start({ ...spec, hookTokenSha256: 'second' });
    expect(again).toMatchObject({ id: session.id, endedAt: null, exitCode: null });
    expect(sessions.list().map((s) => s.id)).toEqual([session.id]);
    expect(db.prepare('SELECT hook_token_sha256, ended_at, exit_code FROM sessions').all()).toEqual([
      { hook_token_sha256: 'second', ended_at: null, exit_code: null },
    ]);
  });

  it('resolves a kill of a session whose exit is still being delivered with the ended session', async () => {
    const { sessions, session, fake, exited } = host();

    fake.exit(session.id, 5);
    const ended = await sessions.kill(session.id, 'a test');

    expect(ended).toMatchObject({ id: session.id, exitCode: 5, endedAt: expect.any(String) });
    expect(exited).toEqual([{ type: 'session.exited', sessionId: session.id, session: ended }]);
    expect(fake.calls).toEqual([]);
  });
});

describe('sessions stopped by a restart', () => {
  const stoppedByRestart = (db: DatabaseSync) =>
    (db.prepare('SELECT stopped_by_restart AS stopped FROM sessions ORDER BY rowid').all() as { stopped: number }[]).map((row) => row.stopped);

  it('marks sessions a lost daemon left live as stopped by restart, and no others', async () => {
    const { db, sessions, session, fake } = host();
    const second = sessions.createShell({ cols: 80, rows: 24, cwd: '/' });
    fake.exit(second.id, 0);
    await sessions.kill(second.id, 'a test');

    // The daemon died here: the first session's row is still live.
    expect(reconcileLostSessions(db)).toBe(1);
    expect(stoppedByRestart(db)).toEqual([1, 0]);
    expect(db.prepare('SELECT ended_at FROM sessions WHERE id = ?').get(session.id)).toEqual({ ended_at: expect.any(String) });
  });

  it('marks sessions the daemon ends as it shuts down as stopped by restart, but not one the user killed', async () => {
    const { db, sessions, session, fake, exited } = host();
    const second = sessions.createShell({ cols: 80, rows: 24, cwd: '/' });
    const killed = sessions.kill(second.id, 'a test');
    fake.exit(second.id, 0);
    expect(await killed).toMatchObject({ stoppedByRestart: false });

    const shutdown = sessions.killAll({ stoppedByRestart: true });
    fake.exit(session.id, 0);
    await shutdown;

    expect(stoppedByRestart(db)).toEqual([1, 0]);
    expect(exited.at(-1)).toMatchObject({ type: 'session.exited', sessionId: session.id, session: { stoppedByRestart: true } });
  });

  it("doesn't mark a session the user was already stopping when the daemon shut down", async () => {
    const { db, sessions, session, fake } = host();
    const second = sessions.createShell({ cols: 80, rows: 24, cwd: '/' });
    // The user's stop is still in its grace period, waiting for the process to go.
    const stopping = sessions.kill(second.id, 'a test');

    const shutdown = sessions.killAll({ stoppedByRestart: true });
    fake.exit(second.id, 0);
    fake.exit(session.id, 0);
    await Promise.all([stopping, shutdown]);

    expect(stoppedByRestart(db)).toEqual([1, 0]);
  });

  it('clears the mark when the session is started again', async () => {
    const { db, session } = host();
    reconcileLostSessions(db);
    // The next daemon, on the same database.
    const sessions = createSessionHost({ db, backend: fakeBackend().backend, shell: '/bin/sh', shellArgs: [], broadcast: () => {}, log: () => {} });
    const spec = { id: session.id, harness: null, command: '/bin/sh', args: [], cwd: '/', env: {}, cols: 80, rows: 24 };
    expect(sessions.start({ ...spec, hookTokenSha256: 'again' })).toMatchObject({ stoppedByRestart: false });
    expect(stoppedByRestart(db)).toEqual([0]);
  });
});

describe('saved scrollback', () => {
  it('keeps what a session showed on disk, and shows it to a client that attaches once it has ended, after a restart too', async () => {
    const scrollbackDir = tempDataDir();
    const db = new DatabaseSync(':memory:');
    const first = host({ db, scrollbackDir, saveQuietMs: 10 });
    first.fake.emit(first.session.id, 'make test\r\nall 12 passed\r\n');
    await new Promise((resolve) => setTimeout(resolve, 100));
    // The daemon is killed hard here: no exit is delivered.
    reconcileLostSessions(db);

    const second = createSessionHost({ db, backend: fakeBackend().backend, shell: '/bin/sh', shellArgs: [], broadcast: () => {}, log: () => {}, scrollbackDir });
    const client = fakeSubscriber();
    second.attach(first.session.id, client.subscriber);

    expect(snapshots(client.events)).toEqual([
      expect.objectContaining({ sessionId: first.session.id, data: expect.stringContaining('all 12 passed'), cols: 80, rows: 24 }),
    ]);
    expect(client.events.at(-1)).toMatchObject({
      type: 'session.exited',
      sessionId: first.session.id,
      session: { id: first.session.id, endedAt: expect.any(String), stoppedByRestart: true },
    });
  });

  it('saves the screen once output goes quiet, and while it keeps flowing only at the most every so often', async () => {
    const scrollbackDir = tempDataDir();
    const { session, fake } = host({ scrollbackDir, saveQuietMs: 60, saveMaxWaitMs: 400 });
    const saved = () => readdirSync(scrollbackDir).filter((name) => name.endsWith('.json'));
    const flow = setInterval(() => fake.emit(session.id, 'tick\r\n'), 10);
    try {
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(saved()).toEqual([]);
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(saved()).toEqual([`${session.id}.json`]);
    } finally {
      clearInterval(flow);
    }
  });

  it('saves the screen as the session exits, and forgets it on request', async () => {
    const scrollbackDir = tempDataDir();
    const { sessions, session, fake } = host({ scrollbackDir, saveQuietMs: 60_000, saveMaxWaitMs: 60_000 });
    fake.emit(session.id, 'last words');
    fake.exit(session.id, 0);
    await sessions.kill(session.id, 'a test');

    const client = fakeSubscriber();
    sessions.attach(session.id, client.subscriber);
    expect(snapshots(client.events)).toEqual([expect.objectContaining({ data: expect.stringContaining('last words') })]);

    sessions.forget(session.id);
    expect(readdirSync(scrollbackDir)).toEqual([]);
  });

  it('refuses to attach to a session it has never heard of', () => {
    const { sessions } = host({ scrollbackDir: tempDataDir() });
    expect(() => sessions.attach('nope', fakeSubscriber().subscriber)).toThrow(/no session nope/);
  });

  it('starts a session over the scrollback it is restored from', async () => {
    const { sessions, session, fake } = host();
    fake.exit(session.id, 0);
    await sessions.kill(session.id, 'a test');
    const spec = { id: session.id, harness: null, command: '/bin/sh', args: [], cwd: '/', env: {}, cols: 80, rows: 24 };
    sessions.start({ ...spec, hookTokenSha256: 'again', restore: 'old output\r\n' });
    fake.emit(session.id, 'new prompt $ ');

    const client = fakeSubscriber();
    sessions.attach(session.id, client.subscriber);
    await parsed();
    expect(snapshots(client.events)[0]).toMatchObject({ data: expect.stringMatching(/old output[\s\S]*new prompt/) });
  });
});

describe("a shell's last folder", () => {
  it("records where a shell session's process is after output, so a resumed pane can start there", async () => {
    const asked: number[] = [];
    const { db, session, fake } = host({
      saveQuietMs: 10,
      processCwd: async (pid) => {
        asked.push(pid);
        return '/tmp/somewhere';
      },
    });
    fake.emit(session.id, '$ cd /tmp/somewhere\r\n$ ');
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(asked).toEqual([4242]);
    expect(db.prepare('SELECT last_cwd FROM sessions WHERE id = ?').get(session.id)).toEqual({ last_cwd: '/tmp/somewhere' });
  });
});

describe('terminal sizing with several viewers', () => {
  const DESK = { cols: 200, rows: 50 };
  const POPOUT = { cols: 120, rows: 40 };
  const PHONE = { cols: 40, rows: 20 };
  const resizes = (calls: string[]) => calls.filter((call) => call.startsWith('resize'));

  function twoViewers(second?: SessionSubscriber['resizes']) {
    const { sessions, session, fake } = host();
    const desk = fakeSubscriber().subscriber;
    const other = fakeSubscriber(second).subscriber;
    sessions.attach(session.id, desk);
    sessions.attach(session.id, other);
    const size = () => sessions.list().find((info) => info.id === session.id)!;
    return { sessions, session, fake, desk, other, size };
  }

  it('sizes the terminal to the local window that resized it last', () => {
    const { sessions, session, desk, other, size } = twoViewers();

    sessions.resize(session.id, DESK, desk);
    sessions.resize(session.id, POPOUT, other);

    expect(size()).toMatchObject(POPOUT);
  });

  it('gives the size back to the window that types, at the size it last asked for', () => {
    const { sessions, session, desk, other, size } = twoViewers();
    sessions.resize(session.id, DESK, desk);
    sessions.resize(session.id, POPOUT, other);

    sessions.write(session.id, 'x', desk);

    expect(size()).toMatchObject(DESK);
  });

  it('hands the size to the next most recent window when the last one detaches, or its connection closes', () => {
    const { sessions, session, desk, other, size } = twoViewers();
    sessions.resize(session.id, DESK, desk);
    sessions.resize(session.id, POPOUT, other);

    sessions.detach(session.id, other);
    expect(size()).toMatchObject(DESK);

    sessions.resize(session.id, POPOUT, other);
    sessions.detachAll(other);
    expect(size()).toMatchObject(DESK);
  });

  it('keeps the size it has when the last viewer leaves', () => {
    const { sessions, session, desk, other, size } = twoViewers();
    sessions.resize(session.id, DESK, desk);

    sessions.detachAll(desk);
    sessions.detachAll(other);

    expect(size()).toMatchObject(DESK);
  });

  it("refuses the resize of a client that may only watch, and never resizes for it", () => {
    const { sessions, session, fake, desk, other, size } = twoViewers('never');
    sessions.resize(session.id, DESK, desk);
    const before = resizes(fake.calls);

    expect(() => sessions.resize(session.id, PHONE, other)).toThrow(/only watch/);
    sessions.detachAll(other);

    expect(size()).toMatchObject(DESK);
    expect(resizes(fake.calls)).toEqual(before);
  });

  it("counts the resize of a client that sizes after typing only once it has typed into the session", () => {
    const { sessions, session, desk, other, size } = twoViewers('afterTyping');
    sessions.resize(session.id, DESK, desk);

    sessions.resize(session.id, PHONE, other);
    expect(size()).toMatchObject(DESK);

    sessions.write(session.id, 'x', other);
    expect(size()).toMatchObject(PHONE);

    sessions.write(session.id, 'y', desk);
    expect(size()).toMatchObject(DESK);
  });

  it("doesn't resize the terminal to the size it already has", () => {
    const { sessions, session, fake, desk, other } = twoViewers();
    sessions.resize(session.id, DESK, desk);
    sessions.resize(session.id, DESK, other);
    sessions.write(session.id, 'x', desk);

    expect(resizes(fake.calls)).toEqual([`resize ${session.id} 200x50`]);
  });

  it('leaves the size be when a connection that never voted closes', () => {
    const { sessions, session, fake, desk, other } = twoViewers();
    sessions.resize(session.id, DESK, desk);
    const before = resizes(fake.calls);

    sessions.detachAll(other);
    sessions.detachAll(fakeSubscriber().subscriber);

    expect(resizes(fake.calls)).toEqual(before);
  });
});

describe('chunk', () => {
  it('splits text into pieces of at most the given length', () => {
    expect(chunk('abcdefg', 3)).toEqual(['abc', 'def', 'g']);
    expect(chunk('', 3)).toEqual([]);
  });

  it('never splits a surrogate pair', () => {
    expect(chunk('ab😀c', 3)).toEqual(['ab', '😀c']);
  });
});
