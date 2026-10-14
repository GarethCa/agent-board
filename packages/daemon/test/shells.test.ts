import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { daemonPaths } from '../src/paths.ts';
import { paneIds } from '../src/pane-layout.ts';
import { MAX_NAME_LENGTH, type DaemonEvent, type ShellRemovedEvent, type ShellUpdatedEvent } from '../src/protocol.ts';
import { connectTestClient, recordEvents, startTestDaemon, tempDataDir, tempRepo } from './helpers.ts';

async function setup() {
  const dataDir = tempDataDir();
  const daemon = await startTestDaemon({ dataDir });
  const client = await connectTestClient(daemon);
  const repo = tempRepo();
  const repoZone = await client.call('zone.add', { path: repo, x: 0, y: 0 });
  const folderZone = await client.call('zone.add', { path: `${repo}/apps/web`, x: 800, y: 0 });
  return { dataDir, daemon, client, repo, repoZone, folderZone, recorder: recordEvents(client) };
}

const isUpdated = (event: DaemonEvent): event is ShellUpdatedEvent => event.type === 'shell.updated';
const isRemoved = (event: DaemonEvent): event is ShellRemovedEvent => event.type === 'shell.removed';

describe('shell tiles', () => {
  it('creates a shell in the zone’s folder, with one live pane', async () => {
    const { client, repo, repoZone, folderZone } = await setup();

    const shell = await client.call('shell.create', { zoneId: folderZone.id });
    const inRepo = await client.call('shell.create', { zoneId: repoZone.id });

    expect(shell).toMatchObject({ zoneId: folderZone.id, cwd: `${repo}/apps/web`, endedPanes: [] });
    expect(inRepo.cwd).toBe(repo);
    expect(shell.layout).toMatchObject({ type: 'pane' });
    const sessions = await client.call('session.list');
    expect(sessions.map((session) => session.cwd).sort()).toEqual([`${repo}/apps/web`, repo].sort());
    expect(await client.call('shell.list')).toEqual([shell, inRepo]);
    expect((await client.call('shell.create', { zoneId: repoZone.id })).name).not.toBe(inRepo.name);
  });

  it('names a new shell after the lowest free number in its zone, so a deleted name is reused but never doubled', async () => {
    const { client, repoZone, folderZone } = await setup();
    const one = await client.call('shell.create', { zoneId: repoZone.id });
    const two = await client.call('shell.create', { zoneId: repoZone.id });
    expect([one.name, two.name]).toEqual(['Shell 1', 'Shell 2']);

    await client.call('shell.delete', { shellId: one.id });
    const again = await client.call('shell.create', { zoneId: repoZone.id });
    const third = await client.call('shell.create', { zoneId: repoZone.id });

    expect([again.name, third.name]).toEqual(['Shell 1', 'Shell 3']);
    expect((await client.call('shell.create', { zoneId: folderZone.id })).name).toBe('Shell 1');
  });

  it('skips a shell whose layout it cannot read, and still sees other panes exit', async () => {
    const dataDir = tempDataDir();
    const log = vi.fn();
    const client = await connectTestClient(await startTestDaemon({ dataDir, log }));
    const recorder = recordEvents(client);
    const repoZone = await client.call('zone.add', { path: tempRepo(), x: 0, y: 0 });
    const shell = await client.call('shell.create', { zoneId: repoZone.id });
    const db = new DatabaseSync(daemonPaths(dataDir).database);
    try {
      db.prepare('INSERT INTO shells (id, zone_id, name, cwd, layout) VALUES (?, ?, ?, ?, ?)').run('bad', repoZone.id, 'Shell 9', shell.cwd, '{"type":"pane"');
    } finally {
      db.close();
    }

    expect((await client.call('shell.list')).map((listed) => listed.id)).toEqual([shell.id]);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/skipping shell bad/));
    await client.call('session.write', { sessionId: paneIds(shell.layout)[0]!, data: 'exit\r' });
    const updated = await recorder.waitFor((event): event is ShellUpdatedEvent => isUpdated(event) && event.shell.endedPanes.length === 1);
    expect(updated.shell.id).toBe(shell.id);
  });

  it('starts a shell in an unbound zone at home, and keeps it there once the zone is bound', async () => {
    const homeDir = tempDataDir();
    const client = await connectTestClient(await startTestDaemon({ homeDir }));
    const zone = await client.call('zone.addUnbound', { name: 'Ideas', x: 0, y: 0 });

    const shell = await client.call('shell.create', { zoneId: zone.id });

    expect(shell.cwd).toBe(homeDir);
    expect((await client.call('session.list')).map((session) => session.cwd)).toEqual([homeDir]);
    const repo = tempRepo();
    await client.call('zone.bind', { id: zone.id, as: 'repo', path: repo });
    const [first] = paneIds(shell.layout);
    const split = await client.call('shell.split', { shellId: shell.id, sessionId: first!, direction: 'horizontal' });
    expect(split.cwd).toBe(homeDir);
    expect((await client.call('shell.create', { zoneId: zone.id })).cwd).toBe(repo);
  });

  it('refuses a zone it does not have', async () => {
    const { client } = await setup();
    await expect(client.call('shell.create', { zoneId: 'nope' })).rejects.toThrow(/no zone/);
  });

  it('splits horizontally and vertically, each pane its own session in the shell’s folder', async () => {
    const { client, repo, repoZone } = await setup();
    const shell = await client.call('shell.create', { zoneId: repoZone.id });
    const [first] = paneIds(shell.layout);

    const two = await client.call('shell.split', { shellId: shell.id, sessionId: first!, direction: 'horizontal' });
    const [, second] = paneIds(two.layout);
    const three = await client.call('shell.split', { shellId: shell.id, sessionId: second!, direction: 'vertical' });

    expect(paneIds(three.layout)).toHaveLength(3);
    expect(three.layout).toMatchObject({
      type: 'split',
      direction: 'horizontal',
      first: { type: 'pane', sessionId: first },
      second: { type: 'split', direction: 'vertical' },
    });
    const sessions = await client.call('session.list');
    expect(sessions).toHaveLength(3);
    expect(sessions.every((session) => session.cwd === repo)).toBe(true);
    expect(new Set(sessions.map((session) => session.id))).toEqual(new Set(paneIds(three.layout)));
  });

  it('refuses to split a pane the shell does not have', async () => {
    const { client, repoZone } = await setup();
    const shell = await client.call('shell.create', { zoneId: repoZone.id });
    await expect(client.call('shell.split', { shellId: shell.id, sessionId: 'nope', direction: 'vertical' })).rejects.toThrow(/no pane/);
    await expect(client.call('shell.split', { shellId: shell.id, sessionId: paneIds(shell.layout)[0]!, direction: 'sideways' as never })).rejects.toThrow(/direction/);
    await expect(client.call('shell.split', { shellId: 'nope', sessionId: 'x', direction: 'vertical' })).rejects.toThrow(/no shell/);
    expect(await client.call('session.list')).toHaveLength(1);
  });

  it('resizes a split and keeps it', async () => {
    const { client, repoZone } = await setup();
    const shell = await client.call('shell.create', { zoneId: repoZone.id });
    const two = await client.call('shell.split', { shellId: shell.id, sessionId: paneIds(shell.layout)[0]!, direction: 'horizontal' });
    if (two.layout.type !== 'split') throw new Error('expected a split');

    const resized = await client.call('shell.resizeSplit', { shellId: shell.id, splitId: two.layout.id, ratio: 0.3 });

    expect(resized.layout).toMatchObject({ ratio: 0.3 });
    expect((await client.call('shell.list'))[0]!.layout).toMatchObject({ ratio: 0.3 });
    await expect(client.call('shell.resizeSplit', { shellId: shell.id, splitId: 'nope', ratio: 0.3 })).rejects.toThrow(/no split/);
    await expect(client.call('shell.resizeSplit', { shellId: shell.id, splitId: two.layout.id, ratio: 'x' as never })).rejects.toThrow(/ratio/);
  });

  it('closes a pane by ending its session; the last pane takes the tile with it', async () => {
    const { client, repoZone, recorder } = await setup();
    const shell = await client.call('shell.create', { zoneId: repoZone.id });
    const first = paneIds(shell.layout)[0]!;
    const two = await client.call('shell.split', { shellId: shell.id, sessionId: first, direction: 'horizontal' });
    const second = paneIds(two.layout)[1]!;

    const one = await client.call('shell.closePane', { shellId: shell.id, sessionId: first });

    expect(one).toMatchObject({ layout: { type: 'pane', sessionId: second }, endedPanes: [] });
    expect((await client.call('session.list')).map((session) => session.id)).toEqual([second]);

    expect(await client.call('shell.closePane', { shellId: shell.id, sessionId: second })).toBeNull();
    expect(await client.call('shell.list')).toEqual([]);
    expect(await client.call('session.list')).toEqual([]);
    await recorder.waitFor((event): event is ShellRemovedEvent => isRemoved(event) && event.shellId === shell.id);
  });

  it('marks a pane ended when its shell exits, and keeps it until it is closed', async () => {
    const { client, repoZone, recorder } = await setup();
    const shell = await client.call('shell.create', { zoneId: repoZone.id });
    const two = await client.call('shell.split', { shellId: shell.id, sessionId: paneIds(shell.layout)[0]!, direction: 'vertical' });
    const [first, second] = paneIds(two.layout) as [string, string];

    await client.call('session.write', { sessionId: second, data: 'exit\r' });
    const updated = await recorder.waitFor((event): event is ShellUpdatedEvent => isUpdated(event) && event.shell.endedPanes.length === 1);

    expect(updated.shell.endedPanes).toEqual([second]);
    expect(paneIds(updated.shell.layout)).toEqual([first, second]);
    expect((await client.call('shell.list'))[0]!.endedPanes).toEqual([second]);
    expect(await client.call('shell.closePane', { shellId: shell.id, sessionId: second })).toMatchObject({ endedPanes: [] });
  });

  it('announces a new shell, and each split', async () => {
    const { client, repoZone, recorder } = await setup();
    const shell = await client.call('shell.create', { zoneId: repoZone.id });
    const two = await client.call('shell.split', { shellId: shell.id, sessionId: paneIds(shell.layout)[0]!, direction: 'vertical' });

    await recorder.waitFor((event): event is ShellUpdatedEvent => isUpdated(event) && paneIds(event.shell.layout).length === 2);
    expect(recorder.events.filter(isUpdated).map((event) => event.shell.id)).toEqual([shell.id, shell.id]);
    expect(two.id).toBe(shell.id);
  });

  it('deletes a shell and every pane in it', async () => {
    const { client, repoZone } = await setup();
    const shell = await client.call('shell.create', { zoneId: repoZone.id });
    await client.call('shell.split', { shellId: shell.id, sessionId: paneIds(shell.layout)[0]!, direction: 'vertical' });

    await client.call('shell.delete', { shellId: shell.id });

    expect(await client.call('shell.list')).toEqual([]);
    expect(await client.call('session.list')).toEqual([]);
    await expect(client.call('shell.delete', { shellId: shell.id })).rejects.toThrow(/no shell/);
  });

  it('keeps its zone: a zone with shells can’t be removed until they are', async () => {
    const { client, repoZone } = await setup();
    const shell = await client.call('shell.create', { zoneId: repoZone.id });

    await expect(client.call('zone.remove', { id: repoZone.id })).rejects.toThrow(/shells/);
    await client.call('shell.delete', { shellId: shell.id });
    await client.call('zone.remove', { id: repoZone.id });
  });

  it('starts a loose shell on the board at home, where it was put, on top of every other tile', async () => {
    const homeDir = tempDataDir();
    const client = await connectTestClient(await startTestDaemon({ homeDir }));
    const zone = await client.call('zone.add', { path: tempRepo(), x: 0, y: 0 });
    const inZone = await client.call('shell.create', { zoneId: zone.id });

    const loose = await client.call('shell.create', { zoneId: null, position: { x: 400, y: -20 } });

    expect(inZone.position).toBeNull();
    expect(loose).toMatchObject({ zoneId: null, cwd: homeDir, name: 'Shell 1', position: { x: 400, y: -20 } });
    expect(loose.position!.z).toEqual(expect.any(Number));
    expect((await client.call('session.list')).map((session) => session.cwd)).toContain(homeDir);
    expect((await client.call('shell.create', { zoneId: null, position: { x: 0, y: 0 } })).name).toBe('Shell 2');
    await expect(client.call('shell.create', { zoneId: null } as never)).rejects.toThrow(/position/);
  });

  it('places a new shell in its zone where asked', async () => {
    const { client, repoZone } = await setup();
    const shell = await client.call('shell.create', { zoneId: repoZone.id, position: { x: 20, y: 44 } });
    expect(shell.position).toMatchObject({ x: 20, y: 44 });
  });

  it('moves a shell into a zone and out again, its panes running where they started', async () => {
    const homeDir = tempDataDir();
    const client = await connectTestClient(await startTestDaemon({ homeDir }));
    const recorder = recordEvents(client);
    const zone = await client.call('zone.add', { path: tempRepo(), x: 100, y: 100 });
    const loose = await client.call('shell.create', { zoneId: null, position: { x: 0, y: 0 } });

    const moved = await client.call('shell.move', { shellId: loose.id, zoneId: zone.id, x: 30, y: 50, z: 7 });

    expect(moved).toMatchObject({ zoneId: zone.id, cwd: homeDir, position: { x: 30, y: 50, z: 7 } });
    await recorder.waitFor((event): event is ShellUpdatedEvent => isUpdated(event) && event.shell.zoneId === zone.id);
    await expect(client.call('zone.remove', { id: zone.id })).rejects.toThrow(/shells/);

    const out = await client.call('shell.move', { shellId: loose.id, zoneId: null, x: 900, y: 10 });

    expect(out).toMatchObject({ zoneId: null, cwd: homeDir, position: { x: 900, y: 10, z: 7 } });
    expect((await client.call('session.list')).map((session) => session.cwd)).toEqual([homeDir]);
    await client.call('zone.remove', { id: zone.id });
  });

  it('brings a moved shell to the front of every tile when asked', async () => {
    const { client, repoZone } = await setup();
    const below = await client.call('shell.create', { zoneId: null, position: { x: 0, y: 0 } });
    const above = await client.call('shell.create', { zoneId: repoZone.id, position: { x: 20, y: 44 } });

    const raised = await client.call('shell.move', { shellId: below.id, zoneId: null, x: 5, y: 5, toFront: true });

    expect(raised.position!.z).toBeGreaterThan(above.position!.z!);
    const kept = await client.call('shell.move', { shellId: below.id, zoneId: null, x: 6, y: 6 });
    expect(kept.position!.z).toBe(raised.position!.z);
  });

  it('refuses to move a shell it does not have, or into a zone it does not have', async () => {
    const { client, repoZone } = await setup();
    const shell = await client.call('shell.create', { zoneId: repoZone.id });
    await expect(client.call('shell.move', { shellId: 'nope', zoneId: null, x: 0, y: 0 })).rejects.toThrow(/no shell/);
    await expect(client.call('shell.move', { shellId: shell.id, zoneId: 'nope', x: 0, y: 0 })).rejects.toThrow(/no zone/);
    await expect(client.call('shell.move', { shellId: shell.id, zoneId: null, x: 'a', y: 0 } as never)).rejects.toThrow(/x/);
  });

  it('keeps a moved shell where it was put across a daemon restart', async () => {
    const dataDir = tempDataDir();
    const homeDir = tempDataDir();
    const first = await startTestDaemon({ dataDir, homeDir });
    const before = await connectTestClient(first);
    const zone = await before.call('zone.add', { path: tempRepo(), x: 0, y: 0 });
    const loose = await before.call('shell.create', { zoneId: null, position: { x: -50, y: 75 } });
    const inZone = await before.call('shell.create', { zoneId: zone.id });
    const moved = await before.call('shell.move', { shellId: inZone.id, zoneId: zone.id, x: 12, y: 34, z: 3 });
    await first.stop();

    const after = await connectTestClient(await startTestDaemon({ dataDir, homeDir }));

    const shells = await after.call('shell.list');
    expect(shells.map(({ id, zoneId, position }) => ({ id, zoneId, position }))).toEqual([
      { id: loose.id, zoneId: null, position: loose.position },
      { id: inZone.id, zoneId: zone.id, position: moved.position },
    ]);
  });

  it('gives a plain shell made on its own a loose shell tile, with no place yet', async () => {
    const homeDir = tempDataDir();
    const client = await connectTestClient(await startTestDaemon({ homeDir }));
    const recorder = recordEvents(client);
    const zone = await client.call('zone.add', { path: tempRepo(), x: 0, y: 0 });
    const tiled = await client.call('shell.create', { zoneId: zone.id });
    const plain = await client.call('session.createShell', { cols: 80, rows: 24 });

    const adopted = await recorder.waitFor(
      (event): event is ShellUpdatedEvent => isUpdated(event) && paneIds(event.shell.layout).includes(plain.id),
    );
    const shells = await client.call('shell.list');
    expect(shells[1]).toEqual(adopted.shell);

    expect(shells).toHaveLength(2);
    expect(shells[1]).toMatchObject({ zoneId: null, position: null, cwd: homeDir, layout: { type: 'pane', sessionId: plain.id } });
    expect(await client.call('shell.list')).toEqual(shells);
    expect(shells[0]!.id).toBe(tiled.id);
  });

  it('follows each pane to the folder its shell cds into, and tells clients (the folder chip)', async () => {
    const client = await connectTestClient(await startTestDaemon({ saveQuietMs: 50 }));
    const recorder = recordEvents(client);
    const repo = tempRepo();
    const shell = await client.call('shell.create', { zoneId: null, position: { x: 0, y: 0 } });
    const [pane] = paneIds(shell.layout);
    expect(shell.paneFolders).toEqual({ [pane!]: shell.cwd });

    await client.call('session.write', { sessionId: pane!, data: `cd ${repo} && echo moved\r` });

    const moved = await recorder.waitFor(
      (event): event is ShellUpdatedEvent => isUpdated(event) && event.shell.paneFolders[pane!] === repo,
    );
    expect(moved.shell.cwd).toBe(shell.cwd);
  });

  it('splits a pane into a new one in another folder, leaving the tile’s own', async () => {
    const { client, repo, repoZone } = await setup();
    const shell = await client.call('shell.create', { zoneId: repoZone.id });
    const [pane] = paneIds(shell.layout);
    const elsewhere = `${repo}/apps/web`;

    const split = await client.call('shell.split', { shellId: shell.id, sessionId: pane!, direction: 'horizontal', cwd: elsewhere });

    const added = paneIds(split.layout).find((id) => id !== pane)!;
    expect(split.paneFolders[added]).toBe(elsewhere);
    expect(split.cwd).toBe(repo);
    expect((await client.call('session.list')).find((session) => session.id === added)?.cwd).toBe(elsewhere);
    await expect(
      client.call('shell.split', { shellId: shell.id, sessionId: pane!, direction: 'horizontal', cwd: 'relative' }),
    ).rejects.toThrow(/absolute/);
  });

  it('keeps the layout across a daemon restart, its panes ended with their sessions', async () => {
    const dataDir = tempDataDir();
    const repo = tempRepo();
    const first = await startTestDaemon({ dataDir });
    const before = await connectTestClient(first);
    const zone = await before.call('zone.add', { path: repo, x: 0, y: 0 });
    const shell = await before.call('shell.create', { zoneId: zone.id });
    const split = await before.call('shell.split', { shellId: shell.id, sessionId: paneIds(shell.layout)[0]!, direction: 'horizontal' });
    await first.stop();

    const second = await startTestDaemon({ dataDir });
    const after = await connectTestClient(second);

    const [restored] = await after.call('shell.list');
    expect(restored).toMatchObject({ id: shell.id, layout: split.layout });
    expect(restored!.endedPanes.sort()).toEqual(paneIds(split.layout).sort());
    expect(restored!.stoppedPanes.sort()).toEqual(paneIds(split.layout).sort());
    expect(await after.call('session.list')).toEqual([]);
  });

  it('renames a shell and labels its panes, kept across a restart and by splits and closes', async () => {
    const dataDir = tempDataDir();
    const first = await startTestDaemon({ dataDir });
    const before = await connectTestClient(first);
    const recorder = recordEvents(before);
    const zone = await before.call('zone.add', { path: tempRepo(), x: 0, y: 0 });
    const shell = await before.call('shell.create', { zoneId: zone.id });
    const [one] = paneIds(shell.layout);

    const renamed = await before.call('shell.setName', { shellId: shell.id, name: '  Build server ' });
    const split = await before.call('shell.split', { shellId: shell.id, sessionId: one!, direction: 'horizontal' });
    const two = paneIds(split.layout)[1]!;
    const labelled = await before.call('shell.setPaneName', { shellId: shell.id, sessionId: two, name: ' logs ' });

    expect(renamed.name).toBe('Build server');
    expect(labelled.layout).toMatchObject({ first: { sessionId: one }, second: { sessionId: two, name: 'logs' } });
    await recorder.waitFor((event): event is ShellUpdatedEvent => isUpdated(event) && event.shell.name === 'Build server');
    await first.stop();
    const after = await connectTestClient(await startTestDaemon({ dataDir }));
    const [restored] = await after.call('shell.list');
    expect(restored).toMatchObject({ name: 'Build server', layout: labelled.layout });

    const cleared = await after.call('shell.setPaneName', { shellId: shell.id, sessionId: two, name: null });
    expect(cleared.layout).toEqual(split.layout);
    expect(cleared.name).toBe('Build server');
  });

  it('refuses a blank or over-long shell name, a pane label that is too long, and an unknown shell or pane', async () => {
    const { client, repoZone } = await setup();
    const shell = await client.call('shell.create', { zoneId: repoZone.id });
    const pane = paneIds(shell.layout)[0]!;
    const long = 'x'.repeat(MAX_NAME_LENGTH + 1);

    await expect(client.call('shell.setName', { shellId: shell.id, name: '  ' })).rejects.toThrow(/empty/);
    await expect(client.call('shell.setName', { shellId: shell.id, name: long })).rejects.toThrow(/at most/);
    await expect(client.call('shell.setName', { shellId: 'nope', name: 'a' })).rejects.toThrow(/no shell/);
    await expect(client.call('shell.setPaneName', { shellId: shell.id, sessionId: pane, name: long })).rejects.toThrow(/at most/);
    await expect(client.call('shell.setPaneName', { shellId: shell.id, sessionId: 'nope', name: 'a' })).rejects.toThrow(/no pane/);
    await expect(client.call('shell.setPaneName', { shellId: 'nope', sessionId: pane, name: 'a' })).rejects.toThrow(/no shell/);
    expect((await client.call('shell.list'))[0]!.name).toBe(shell.name);
  });

  it('resumes a pane stopped by restart: a new shell in its last folder, under its old output, marked restored', async () => {
    const dataDir = tempDataDir();
    const repo = tempRepo();
    const first = await startTestDaemon({ dataDir, saveQuietMs: 100 });
    const before = await connectTestClient(first);
    const beforeEvents = recordEvents(before);
    const zone = await before.call('zone.add', { path: repo, x: 0, y: 0 });
    const shell = await before.call('shell.create', { zoneId: zone.id });
    const pane = paneIds(shell.layout)[0]!;
    await before.call('session.attach', { sessionId: pane });
    await before.call('session.write', { sessionId: pane, data: 'cd apps/web && echo "was in $(pwd)"\r' });
    await beforeEvents.waitForText(pane, `was in ${repo}/apps/web`);
    // Give the daemon a moment to save the screen and see where the shell is.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await first.stop();

    const second = await startTestDaemon({ dataDir });
    const after = await connectTestClient(second);
    const recorder = recordEvents(after);
    const resumed = await after.call('shell.resumePane', { shellId: shell.id, sessionId: pane });

    expect(resumed).toMatchObject({ id: shell.id, layout: shell.layout, endedPanes: [], stoppedPanes: [] });
    await after.call('session.attach', { sessionId: pane });
    await recorder.waitForText(pane, 'restored');
    // The old output, then the line that says where it stops: not written over it.
    const snapshot = recorder.events.find((event) => event.type === 'session.snapshot' && event.sessionId === pane) as { data: string };
    expect(snapshot.data.indexOf(`was in ${repo}/apps/web`)).toBeGreaterThan(-1);
    expect(snapshot.data.indexOf(`was in ${repo}/apps/web`)).toBeLessThan(snapshot.data.indexOf('restored'));
    await after.call('session.write', { sessionId: pane, data: 'echo "now in $(pwd)"\r' });
    await recorder.waitForText(pane, `now in ${repo}/apps/web`);
    await expect(after.call('shell.resumePane', { shellId: shell.id, sessionId: pane })).rejects.toMatchObject({
      message: expect.stringContaining('is still running'),
    });
  });

  it("resumes a pane stopped inside a full-screen program as a plain shell, not in that program's screen and modes", async () => {
    const dataDir = tempDataDir();
    const first = await startTestDaemon({ dataDir, saveQuietMs: 100 });
    const before = await connectTestClient(first);
    const beforeEvents = recordEvents(before);
    const zone = await before.call('zone.add', { path: tempRepo(), x: 0, y: 0 });
    const shell = await before.call('shell.create', { zoneId: zone.id });
    const pane = paneIds(shell.layout)[0]!;
    await before.call('session.attach', { sessionId: pane });
    // As vim or less leave it: the alternate screen, mouse reporting and application cursor keys on.
    await before.call('session.write', { sessionId: pane, data: "printf '\\033[?1049h\\033[?1000h\\033[?1h' && echo full-$((6 * 7))\r" });
    await beforeEvents.waitForText(pane, 'full-42');
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await first.stop();

    const after = await connectTestClient(await startTestDaemon({ dataDir }));
    const recorder = recordEvents(after);
    await after.call('shell.resumePane', { shellId: shell.id, sessionId: pane });
    await after.call('session.attach', { sessionId: pane });
    await recorder.waitForText(pane, 'restored');

    const snapshot = recorder.events.find((event) => event.type === 'session.snapshot' && event.sessionId === pane);
    expect(snapshot).toBeDefined();
    const data = (snapshot as { data: string }).data;
    for (const mode of ['\x1b[?1049h', '\x1b[?1000h', '\x1b[?1h']) expect(data).not.toContain(mode);
  });

  it('does not count a pane whose shell exited as stopped by restart, and restarts it with no "restored" line', async () => {
    const { client, repoZone, recorder } = await setup();
    const shell = await client.call('shell.create', { zoneId: repoZone.id });
    const pane = paneIds(shell.layout)[0]!;
    await client.call('session.write', { sessionId: pane, data: 'exit\r' });

    const updated = await recorder.waitFor((event): event is ShellUpdatedEvent => isUpdated(event) && event.shell.endedPanes.length === 1);

    expect(updated.shell.stoppedPanes).toEqual([]);
    const restarted = await client.call('shell.resumePane', { shellId: shell.id, sessionId: pane });
    expect(restarted.endedPanes).toEqual([]);
    await client.call('session.attach', { sessionId: pane });
    await client.call('session.write', { sessionId: pane, data: 'echo "back $((6 * 7))"\r' });
    await recorder.waitForText(pane, 'back 42');
    const snapshot = recorder.events.find((event) => event.type === 'session.snapshot' && event.sessionId === pane) as { data: string };
    expect(snapshot.data).not.toContain('restored');
  });
});
