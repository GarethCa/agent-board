import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fakeHarnessEnv, type FakeScenario } from '@agent-board/fake-harness';
import { DaemonRpcError } from '../src/client.ts';
import type { DaemonEvent, ExternalUpdatedEvent } from '../src/protocol.ts';
import { connectTestClient, recordEvents, startTestDaemon, tempDataDir, tempRepo } from './helpers.ts';

/** A daemon whose global hooks go into a temp home, and that home. */
async function externalDaemon() {
  const home = tempDataDir();
  const files = { claude: join(home, '.claude', 'settings.json'), codex: join(home, '.codex', 'hooks.json') };
  const externalHookFile = join(tempDataDir(), 'external-hook.json');
  const daemon = await startTestDaemon({
    externalHookFiles: files,
    externalHookFile,
    agentEnv: fakeHarnessEnv({ scenario: 'output', home }),
  });
  const client = await connectTestClient(daemon);
  return { daemon, client, recorder: recordEvents(client), home, files, externalHookFile };
}

/** Runs the fake claude one-shot in `cwd` as if from another terminal, with `home` as `~`. */
function runClaude(cwd: string, home: string, scenario: FakeScenario = 'output') {
  return runHarness('claude', ['-p', 'Tidy the README'], cwd, home, scenario);
}

function runHarness(command: string, args: string[], cwd: string, home: string, scenario: FakeScenario = 'output') {
  const started = Date.now();
  const child = spawn(command, args, { cwd, env: fakeHarnessEnv({ scenario, home }) });
  child.stdout.resume();
  child.stderr.resume();
  return new Promise<{ code: number | null; ms: number }>((resolve) =>
    child.on('close', (code) => resolve({ code, ms: Date.now() - started })),
  );
}

const isExternalUpdate = (event: DaemonEvent): event is ExternalUpdatedEvent => event.type === 'external.updated';

describe('external sessions through the global hooks', () => {
  it('installs the hooks on request, beside the user\'s own, and takes them out again', async () => {
    const { client, files } = await externalDaemon();
    const own = { model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } };
    mkdirSync(join(files.claude, '..'), { recursive: true });
    writeFileSync(files.claude, JSON.stringify(own));

    expect(await client.call('externalHooks.status')).toMatchObject({ enabled: false });
    const on = await client.call('externalHooks.setEnabled', { enabled: true });
    expect(on).toEqual({
      enabled: true,
      harnesses: { claude: { installed: true, path: files.claude }, codex: { installed: true, path: files.codex } },
    });
    expect(readFileSync(files.claude, 'utf8')).toContain('say done');

    expect(await client.call('externalHooks.setEnabled', { enabled: false })).toMatchObject({ enabled: false });
    expect(JSON.parse(readFileSync(files.claude, 'utf8'))).toEqual(own);
  });

  it("refuses, changing nothing, when a hook file isn't JSON", async () => {
    const { client, files } = await externalDaemon();
    mkdirSync(join(files.codex, '..'), { recursive: true });
    writeFileSync(files.codex, '{ nope');
    const error = await client.call('externalHooks.setEnabled', { enabled: true }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DaemonRpcError);
    expect((error as Error).message).toContain(files.codex);
    expect(existsSync(files.claude) && readFileSync(files.claude, 'utf8').includes('agent-board-hook')).toBe(false);
  });

  it('puts a claude session started elsewhere on the board, in its zone, with live state', async () => {
    const { client, recorder, home } = await externalDaemon();
    const repo = tempRepo('app');
    const zone = await client.call('zone.add', { path: repo, x: 0, y: 0 });
    await client.call('externalHooks.setEnabled', { enabled: true });

    expect((await runClaude(join(repo, 'apps', 'web'), home)).code).toBe(0);

    await recorder.waitFor((e): e is ExternalUpdatedEvent => isExternalUpdate(e) && e.session.state === 'done');
    const states = recorder.events.filter(isExternalUpdate).map((e) => e.session.state);
    expect(states[0]).toBe('running');
    expect(states).toContain('thinking');
    const [session] = await client.call('external.list');
    expect(session).toMatchObject({ harness: 'claude', zoneId: zone.id, worktree: repo, description: 'Tidy the README', state: 'done' });
  });

  describe('the Unsorted group, through the real handlers', () => {
    /** A daemon with one ended session in no zone, so with the Unsorted group made for it. */
    async function withUnsorted() {
      const setup = await externalDaemon();
      await setup.client.call('externalHooks.setEnabled', { enabled: true });
      expect((await runClaude(tempDataDir(), setup.home)).code).toBe(0);
      await setup.recorder.waitFor((e): e is ExternalUpdatedEvent => isExternalUpdate(e) && e.session.state === 'done');
      const group = (await setup.client.call('zone.list')).find((zone) => zone.name === 'Unsorted')!;
      return { ...setup, group };
    }

    it('is made for a session in no zone, and dissolving it leaves the tile loose where it is drawn, with no new group', async () => {
      const { client, group } = await withUnsorted();
      const [session] = await client.call('external.list');
      expect(session).toMatchObject({ zoneId: group.id, position: null });
      const placed = await client.call('external.move', { id: session!.id, zoneId: group.id, x: 30, y: 60 });
      const note = await client.call('item.create', { kind: 'sticky', zoneId: group.id, x: 5, y: 6, width: 200, height: 120, data: { text: 'hi', color: '#ffe680' } });

      await client.call('zone.dissolve', { id: group.id });

      expect(await client.call('zone.list')).toEqual([]);
      expect(await client.call('external.list')).toEqual([
        { ...placed, zoneId: null, position: { x: group.x + 30, y: group.y + 60, z: placed.position!.z } },
      ]);
      expect((await client.call('item.list'))[0]).toMatchObject({ id: note.id, zoneId: null, x: group.x + 5, y: group.y + 6 });
    });

    it('puts a tile that was never given a place loose at its slot, and refuses a zone bound to a repo', async () => {
      const { client, group } = await withUnsorted();
      await client.call('zone.dissolve', { id: group.id });
      expect((await client.call('external.list'))[0]).toMatchObject({ zoneId: null, position: { x: group.x + 20, y: group.y + 44 } });

      const repo = await client.call('zone.add', { path: tempRepo('app'), x: 0, y: 0 });
      await expect(client.call('zone.dissolve', { id: repo.id })).rejects.toThrow(/bound to a repo/);
      await expect(client.call('zone.dissolve', { id: 'nope' })).rejects.toThrow(/no zone/);
    });

    it('gets a fresh group for the next unplaced session after the old one is removed', async () => {
      const { client, group, recorder, home } = await withUnsorted();
      await client.call('zone.dissolve', { id: group.id });
      expect(await client.call('zone.list')).toEqual([]);

      expect((await runHarness('claude', ['-p', 'Again'], tempDataDir(), home)).code).toBe(0);
      await recorder.waitFor((e): e is ExternalUpdatedEvent => isExternalUpdate(e) && e.session.description === 'Again');
      const [fresh] = await client.call('zone.list');
      expect(fresh).toMatchObject({ name: 'Unsorted', kind: 'unbound' });
      expect(fresh!.id).not.toBe(group.id);
    });

    it('is made when unbinding a zone leaves its sessions in no zone, and external.list never makes one', async () => {
      const { client, recorder, home } = await externalDaemon();
      const repo = tempRepo('app');
      const zone = await client.call('zone.add', { path: repo, x: 0, y: 0 });
      await client.call('externalHooks.setEnabled', { enabled: true });
      expect((await runClaude(repo, home)).code).toBe(0);
      await recorder.waitFor((e): e is ExternalUpdatedEvent => isExternalUpdate(e) && e.session.state === 'done');
      expect((await client.call('external.list'))[0]!.zoneId).toBe(zone.id);

      await client.call('zone.unbind', { id: zone.id });

      const groups = (await client.call('zone.list')).filter((each) => each.name === 'Unsorted');
      expect(groups).toHaveLength(1);
      expect((await client.call('external.list'))[0]!.zoneId).toBe(groups[0]!.id);
      // Listing again, and again, changes no zone.
      await client.call('external.list');
      expect((await client.call('zone.list')).filter((each) => each.name === 'Unsorted')).toHaveLength(1);
    });

    it('is made when removing a zone leaves its sessions in no zone', async () => {
      const { client, recorder, home } = await externalDaemon();
      const repo = tempRepo('app');
      const zone = await client.call('zone.add', { path: repo, x: 0, y: 0 });
      await client.call('externalHooks.setEnabled', { enabled: true });
      expect((await runClaude(repo, home)).code).toBe(0);
      await recorder.waitFor((e): e is ExternalUpdatedEvent => isExternalUpdate(e) && e.session.state === 'done');

      await client.call('zone.remove', { id: zone.id });

      const [group] = await client.call('zone.list');
      expect(group).toMatchObject({ name: 'Unsorted' });
      expect((await client.call('external.list'))[0]!.zoneId).toBe(group!.id);
    });
  });

  it('puts a session in the folder zone its folder is in, over the repo zone', async () => {
    const { client, recorder, home } = await externalDaemon();
    const repo = tempRepo('app');
    await client.call('zone.add', { path: repo, x: 0, y: 0 });
    const web = await client.call('zone.add', { path: join(repo, 'apps', 'web'), x: 800, y: 0 });
    await client.call('externalHooks.setEnabled', { enabled: true });

    expect((await runClaude(join(repo, 'apps', 'web'), home)).code).toBe(0);

    await recorder.waitFor((e): e is ExternalUpdatedEvent => isExternalUpdate(e) && e.session.state === 'done');
    expect((await client.call('external.list'))[0]).toMatchObject({ zoneId: web.id });
  });

  it('puts a codex session started elsewhere on the board through its global hooks', async () => {
    const { client, recorder, home } = await externalDaemon();
    const repo = tempRepo('app');
    const zone = await client.call('zone.add', { path: repo, x: 0, y: 0 });
    await client.call('externalHooks.setEnabled', { enabled: true });

    // The fake codex runs user hooks only once trusted; the flag stands in for the user trusting them in its review.
    const result = await runHarness('codex', ['exec', '--dangerously-bypass-hook-trust', 'Tidy the README'], repo, home);
    expect(result.code).toBe(0);

    await recorder.waitFor((e): e is ExternalUpdatedEvent => isExternalUpdate(e) && e.session.state === 'done');
    expect((await client.call('external.list'))[0]).toMatchObject({ harness: 'codex', zoneId: zone.id, state: 'done' });
  });

  it("leaves agent-board's own agents to their own hooks", async () => {
    const { client, recorder } = await externalDaemon();
    const repo = tempRepo('app');
    const zone = await client.call('zone.add', { path: repo, x: 0, y: 0 });
    await client.call('externalHooks.setEnabled', { enabled: true });

    const agent = await client.call('agent.spawn', { zoneId: zone.id, prompt: 'Fix it', cols: 80, rows: 24 });
    await recorder.waitFor(
      (e): e is DaemonEvent => e.type === 'agent.updated' && e.agent.sessionId === agent.sessionId && e.agent.state === 'idle' && recorder.events.some((h) => h.type === 'hook' && h.event === 'Stop'),
    );
    expect(await client.call('external.list')).toEqual([]);
  });

  it('is a no-op for the session once the daemon has stopped', async () => {
    const { daemon, client, home, externalHookFile } = await externalDaemon();
    await client.call('externalHooks.setEnabled', { enabled: true });
    expect(existsSync(externalHookFile)).toBe(true);
    await daemon.stop();
    expect(existsSync(externalHookFile)).toBe(false);

    const result = await runClaude(tempRepo('app'), home);
    expect(result.code).toBe(0);
    expect(result.ms).toBeLessThan(5_000);
  });
});
