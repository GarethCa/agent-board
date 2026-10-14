import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
import { paneIds } from '../src/pane-layout.ts';
import { runBoardCommand } from '../src/board-cli.ts';
import type { DaemonClient } from '../src/client.ts';
import { BOARD_ERROR, RPC_ERROR } from '../src/protocol.ts';
import { connectTestClient, recordEvents, startTestDaemon, tempRepo } from './helpers.ts';

/** Starts a daemon with a zone holding a shell tile, attached, and reads the shell's board env from its terminal. */
async function shellInZone() {
  const daemon = await startTestDaemon();
  const client = await connectTestClient(daemon);
  const recorder = recordEvents(client);
  const zone = await client.call('zone.add', { path: tempRepo(), x: 0, y: 0 });
  const shell = await client.call('shell.create', { zoneId: zone.id });
  const pane = paneIds(shell.layout)[0]!;
  const env = await boardEnv(client, recorder, pane);
  return { daemon, client, recorder, zone, shell, pane, ...env };
}

/** The board env the shell in `pane` was given, read from its terminal. */
async function boardEnv(client: DaemonClient, recorder: ReturnType<typeof recordEvents>, pane: string) {
  await client.call('session.attach', { sessionId: pane });
  await client.call('session.write', {
    sessionId: pane,
    data: 'echo "env:$AGENT_BOARD_SOCKET|$AGENT_BOARD_ZONE_ID|$AGENT_BOARD_SESSION_ID|${PATH%%:*}|$AGENT_BOARD_IDENTITY:end"\r',
  });
  await recorder.waitForText(pane, ':end\r\n');
  const [socket, zoneId, sessionId, firstOnPath, token] = /env:(.*):end\r\n/.exec(recorder.screenText(pane))![1]!.split('|');
  return { socket, zoneId, sessionId, firstOnPath, token: token! };
}

describe('the board env', () => {
  it('hands a shell tile its socket, zone, session, a board token and the agent-board CLI first on PATH', async () => {
    const { daemon, zone, pane, socket, zoneId, sessionId, firstOnPath, token } = await shellInZone();
    const health = await (await connectTestClient(daemon)).call('daemon.health');

    expect(socket).toBe(daemon.socketPath);
    expect(zoneId).toBe(zone.id);
    expect(sessionId).toBe(pane);
    expect(health.cliPath).not.toBeNull();
    expect(firstOnPath).toBe(dirname(health.cliPath!));
    expect(existsSync(health.cliPath!)).toBe(true);
    expect(token).toMatch(/^[\w-]{40,}$/);
  });

  it('identifies the shell by its token, with the zone its tile is in now', async () => {
    const { daemon, client, shell, pane, token } = await shellInZone();
    // The user moves the tile on their own connection; the shell's is its own.
    const shellSide = await connectTestClient(daemon);
    expect(await shellSide.call('board.identify', { token })).toEqual({
      sessionId: pane,
      kind: 'shell',
      tileId: shell.id,
      name: shell.name,
      zoneId: shell.zoneId,
      orchestrate: null,
    });

    await client.call('shell.move', { shellId: shell.id, zoneId: null, x: 2000, y: 0 });
    expect((await shellSide.call('board.identify', { token })).zoneId).toBeNull();
  });

  it("identifies a shell in one of a shell tile's tabs as the tile, in the tile's zone", async () => {
    const { client, recorder, zone, shell } = await shellInZone();
    const tab = await client.call('shell.createTab', { owner: { kind: 'shell', id: shell.id } });
    const pane = paneIds(tab.layout)[0]!;
    const { zoneId, token } = await boardEnv(client, recorder, pane);

    expect(zoneId).toBe(zone.id);
    expect(await client.call('board.identify', { token })).toEqual({
      sessionId: pane,
      kind: 'shell',
      tileId: shell.id,
      name: shell.name,
      zoneId: zone.id,
      orchestrate: null,
    });
  });

  it('refuses a token no live session holds, and one whose session has ended', async () => {
    const { client, pane, token } = await shellInZone();
    await expect(client.call('board.identify', { token: 'not-a-token' })).rejects.toMatchObject({ code: BOARD_ERROR.unknownToken });

    await client.call('session.kill', { sessionId: pane });
    await expect(client.call('board.identify', { token })).rejects.toMatchObject({ code: BOARD_ERROR.unknownToken });
  });

  it('gives a shell no status to set', async () => {
    const { client, token } = await shellInZone();
    await expect(client.call('board.setStatus', { token, summary: 'hello' })).rejects.toMatchObject({
      code: RPC_ERROR.invalidParams,
      message: expect.stringMatching(/only an agent/),
    });
  });
});

describe('what a board token may call', () => {
  it('once a connection presents one, refuses everything but the board’s reads and its own status', async () => {
    const { daemon, zone, pane, token } = await shellInZone();
    const agentSide = await connectTestClient(daemon);
    await agentSide.call('board.identify', { token });

    expect(await agentSide.call('zone.list')).toHaveLength(1);
    expect(await agentSide.call('daemon.health')).toMatchObject({ liveSessions: 1 });
    const refused = [
      agentSide.call('session.write', { sessionId: pane, data: 'y\r' }),
      agentSide.call('agent.decidePermission', { sessionId: pane, requestId: 'r1', behavior: 'allow' }),
      agentSide.call('agent.spawn', { zoneId: zone.id, cols: 80, rows: 24 }),
      agentSide.call('agent.stop', { sessionId: pane }),
      agentSide.call('agent.markSeen', { sessionId: pane }),
      agentSide.call('zone.configure', { id: zone.id, boardMcp: false }),
      agentSide.call('settings.set', { heldPayloads: 'path' }),
      agentSide.call('daemon.stop', {}),
    ];
    for (const call of refused) {
      await expect(call).rejects.toMatchObject({ code: BOARD_ERROR.notAllowed, message: expect.stringMatching(/not open to a session's board token/) });
    }

    // Another connection that presents no token is the user's, with the whole API.
    const user = await connectTestClient(daemon);
    await expect(user.call('session.write', { sessionId: pane, data: '' })).resolves.toBeNull();
  });

  it('refuses rpc outside the allowlist from a session, and keeps it whole without a token', async () => {
    const { daemon, pane, token } = await shellInZone();
    const run = async (env: NodeJS.ProcessEnv, ...args: string[]) => {
      let out = '';
      let err = '';
      const code = await runBoardCommand('rpc', args, { out: (text) => (out += text), err: (text) => (err += text), env });
      return { code, out, err };
    };
    const write = JSON.stringify({ sessionId: pane, data: '' });

    expect(await run({ AGENT_BOARD_SOCKET: daemon.socketPath, AGENT_BOARD_IDENTITY: token }, 'session.write', write)).toMatchObject({
      code: 1,
      err: expect.stringContaining('session.write is not open to a session'),
    });
    expect((await run({ AGENT_BOARD_SOCKET: daemon.socketPath, AGENT_BOARD_IDENTITY: token }, 'agent.list')).code).toBe(0);
    expect(await run({ AGENT_BOARD_SOCKET: daemon.socketPath }, 'session.write', write)).toMatchObject({ code: 0, out: 'null\n' });
  });
});

