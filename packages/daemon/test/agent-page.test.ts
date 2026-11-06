import { realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fakeHarnessEnv, McpClient } from '@agent-board/fake-harness';
import { runBoardCommand } from '../src/board-cli.ts';
import { BOARD_SOCKET_ENV, BOARD_TOKEN_ENV } from '../src/board-env.ts';
import { RPC_ERROR, type AgentUpdatedEvent, type DaemonEvent } from '../src/protocol.ts';
import { paneIds } from '../src/pane-layout.ts';
import { connectTestClient, recordEvents, startTestDaemon, TEST_CLI_LAUNCHER, tempDataDir, tempRepo } from './helpers.ts';

/** A daemon with one zone and an agent in it that printed its board token, connected as that agent. */
async function agentOnBoard(dataDir = tempDataDir()) {
  const daemon = await startTestDaemon({ dataDir, worktreesDir: tempDataDir(), agentEnv: fakeHarnessEnv({ scenario: 'orchestrate', home: tempDataDir() }) });
  const client = await connectTestClient(daemon);
  const recorder = recordEvents(client);
  const zone = await client.call('zone.add', { path: tempRepo(), x: 0, y: 0, name: 'web' });
  const agent = await client.call('agent.spawn', { zoneId: zone.id, prompt: 'Print your board identity', cols: 120, rows: 40 });
  await client.call('session.attach', { sessionId: agent.sessionId });
  await recorder.waitForText(agent.sessionId, ':end\r\n');
  const token = /identity:(.*):end\r\n/.exec(recorder.screenText(agent.sessionId))![1]!;
  const connection = await connectTestClient(daemon);
  await connection.call('board.identify', { token });
  const pageNow = async () => (await client.call('agent.list')).find((each) => each.sessionId === agent.sessionId)!.page;
  return { daemon, client, recorder, zone, agent, token, connection, pageNow };
}

const PAGE = {
  name: 'Export',
  icon: 'route',
  blocks: [
    { kind: 'heading', title: "Where I'm up to", text: 'Writing the export.', progress: 60 },
    { kind: 'figures', figures: [{ value: '214', label: 'tests passing', icon: 'flask-conical', tone: 'green' }] },
  ],
};

describe("an agent's page", () => {
  it('is written whole by the agent, reaches the sidebar with its agent, and clears', async () => {
    const { client, agent, token, connection, recorder, pageNow } = await agentOnBoard();
    expect(await pageNow()).toBeNull();

    const written = await connection.call('board.setPage', { token, page: PAGE });
    expect(written).toMatchObject({ name: 'Export', icon: 'route', writtenAt: expect.any(String) });
    expect(written!.blocks).toHaveLength(2);
    // The window hears of it as an update of the agent.
    await recorder.waitFor((e: DaemonEvent): e is AgentUpdatedEvent => e.type === 'agent.updated' && e.agent.sessionId === agent.sessionId && e.agent.page?.name === 'Export');
    expect(await pageNow()).toEqual(written);

    // Writing it again replaces it, block by block.
    await connection.call('board.setPage', { token, page: { ...PAGE, name: 'Docs', blocks: [{ kind: 'callout', text: 'Only docs left.' }] } });
    expect(await pageNow()).toMatchObject({ name: 'Docs', blocks: [{ kind: 'callout', text: 'Only docs left.', tone: 'neutral' }] });
    // It is no record: the records stay as they were, and the user's delete never reaches it.
    expect((await connection.call('agent.list')).find((each) => each.sessionId === agent.sessionId)!.records).toEqual([]);
    await expect(client.call('agent.setRecordDeleted', { sessionId: agent.sessionId, kind: 'page', key: 'page', deleted: true } as never)).rejects.toMatchObject({
      code: RPC_ERROR.invalidParams,
      message: expect.stringMatching(/has no page record/),
    });
    expect(await pageNow()).toMatchObject({ name: 'Docs' });

    expect(await connection.call('board.setPage', { token, page: null })).toBeNull();
    expect(await pageNow()).toBeNull();
    // As unpin refuses a pin that isn't there, clearing refuses a page that isn't.
    await expect(connection.call('board.setPage', { token, page: null })).rejects.toMatchObject({ code: RPC_ERROR.invalidParams, message: 'you have no page to clear' });
    await expect(connection.call('board.setPage', { token } as never)).rejects.toMatchObject({ code: RPC_ERROR.invalidParams, message: 'give a page, or null to clear it' });
  });

  it('is kept across a daemon restart', async () => {
    const dataDir = tempDataDir();
    const first = await agentOnBoard(dataDir);
    const written = await first.connection.call('board.setPage', { token: first.token, page: PAGE });
    await first.daemon.stop();
    const second = await startTestDaemon({ dataDir, worktreesDir: tempDataDir() });
    const client = await connectTestClient(second);
    expect((await client.call('agent.list')).find((each) => each.sessionId === first.agent.sessionId)!.page).toEqual(written);
  });

  it("refuses a shell tile's token: only an agent has a page", async () => {
    const daemon = await startTestDaemon();
    const client = await connectTestClient(daemon);
    const recorder = recordEvents(client);
    const zone = await client.call('zone.add', { path: tempRepo(), x: 0, y: 0 });
    const pane = paneIds((await client.call('shell.create', { zoneId: zone.id })).layout)[0]!;
    await client.call('session.attach', { sessionId: pane });
    await client.call('session.write', { sessionId: pane, data: 'echo "token:$AGENT_BOARD_IDENTITY:end"\r' });
    await recorder.waitForText(pane, ':end\r\n');
    const token = /token:(.*):end\r\n/.exec(recorder.screenText(pane))![1]!;
    const shellSide = await connectTestClient(daemon);
    await expect(shellSide.call('board.setPage', { token, page: PAGE })).rejects.toMatchObject({ code: RPC_ERROR.invalidParams, message: expect.stringMatching(/only an agent has a page/) });
  });

  it('refuses a bad page and keeps the one it had', async () => {
    const { token, connection, pageNow } = await agentOnBoard();
    await connection.call('board.setPage', { token, page: PAGE });
    await expect(connection.call('board.setPage', { token, page: { ...PAGE, icon: 'skull' } })).rejects.toMatchObject({
      code: RPC_ERROR.invalidParams,
      message: expect.stringMatching(/^page: icon must be one of/),
    });
    expect(await pageNow()).toMatchObject({ name: 'Export' });
  });

  it("lets the user open a file the page links to, and no other, from where the agent's session started", async () => {
    const { client, agent, token, connection } = await agentOnBoard();
    writeFileSync(join(agent.worktree, 'sample.csv'), 'a,b\n');
    const sample = realpathSync(join(agent.worktree, 'sample.csv'));
    const read = () => client.call('agent.readDoc', { sessionId: agent.sessionId, path: sample });
    await expect(read()).rejects.toMatchObject({ message: expect.stringMatching(/is not one of .*page's links/) });

    await connection.call('board.setPage', { token, page: { ...PAGE, blocks: [{ kind: 'links', links: [{ path: 'sample.csv', label: 'Sample' }] }] } });
    expect(await read()).toEqual({ path: sample, text: 'a,b\n' });

    // Once the page no longer links it, the file is out of reach again: rewritten without the link, or cleared.
    await connection.call('board.setPage', { token, page: PAGE });
    await expect(read()).rejects.toMatchObject({ message: expect.stringMatching(/is not one of .*page's links/) });
    await connection.call('board.setPage', { token, page: { ...PAGE, blocks: [{ kind: 'links', links: [{ path: 'sample.csv' }] }] } });
    expect(await read()).toEqual({ path: sample, text: 'a,b\n' });
    await connection.call('board.setPage', { token, page: null });
    await expect(read()).rejects.toMatchObject({ message: expect.stringMatching(/is not one of .*page's links/) });
  });

  it('is written with `agent-board page`, from a file of the page or of its blocks with --name and --icon, and cleared', async () => {
    const { daemon, agent, token, pageNow } = await agentOnBoard();
    const env = { [BOARD_SOCKET_ENV]: daemon.socketPath, [BOARD_TOKEN_ENV]: token };
    const run = async (...args: string[]) => {
      let out = '';
      const code = await runBoardCommand('page', args, { out: (text) => (out += text), err: (text) => (out += text), env });
      return { code, out };
    };
    const file = join(agent.worktree, 'page.json');

    writeFileSync(file, JSON.stringify(PAGE));
    expect(await run('--file', file)).toEqual({ code: 0, out: 'Wrote your page, Export (route), with 2 blocks.\n' });
    writeFileSync(file, JSON.stringify(PAGE.blocks.slice(0, 1)));
    expect(await run('--file', file, '--name', 'Tests', '--icon', 'flask-conical')).toMatchObject({ code: 0, out: 'Wrote your page, Tests (flask-conical), with 1 block.\n' });
    expect(await pageNow()).toMatchObject({ name: 'Tests', icon: 'flask-conical' });

    expect(await run('--file', file)).toMatchObject({ code: 2, out: expect.stringContaining('give the page a name') });
    expect(await run()).toMatchObject({ code: 2, out: expect.stringContaining('give the page with --file') });
    expect(await run('--clear', '--name', 'X')).toMatchObject({ code: 2, out: expect.stringContaining('--clear takes no') });
    expect(await run('--clear')).toEqual({ code: 0, out: "Cleared your page: your sidebar shows the board's Now until you write one.\n" });
    expect(await pageNow()).toBeNull();
    expect(await run('--clear')).toMatchObject({ code: 1, out: expect.stringContaining('you have no page to clear') });
  });

  it('is written with the set_page tool, its icons and tones offered as the schema’s choices', async () => {
    const { daemon, token, pageNow } = await agentOnBoard();
    const mcp = new McpClient(
      { command: TEST_CLI_LAUNCHER.command, args: [...TEST_CLI_LAUNCHER.args, 'mcp'], env: { ...process.env, AGENT_BOARD_SOCKET: daemon.socketPath, AGENT_BOARD_IDENTITY: token } },
      tempDataDir(),
    );
    await mcp.initialize();
    expect(await mcp.callTool('set_page', PAGE)).toEqual({ text: 'Wrote your page, Export (route), with 2 blocks.', isError: false });
    expect(await pageNow()).toMatchObject({ name: 'Export' });
    expect(await mcp.callTool('set_page', { ...PAGE, blocks: [{ kind: 'callout', text: 'x', tone: 'red' }] })).toMatchObject({
      text: expect.stringContaining('tone must be one of neutral, blue, green, violet, teal'),
      isError: true,
    });
    expect(await mcp.callTool('set_page', { ...PAGE, clear: true })).toMatchObject({ text: expect.stringContaining('clear takes no name, icon or blocks'), isError: true });
    expect(await pageNow()).toMatchObject({ name: 'Export' });
    expect(await mcp.callTool('set_page', { clear: true })).toMatchObject({ isError: false });
    expect(await pageNow()).toBeNull();
  });
});
