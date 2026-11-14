import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { fakeHarnessEnv, McpClient } from '@agent-board/fake-harness';
import { BOARD_MCP_INSTRUCTIONS, ORCHESTRATOR_INSTRUCTIONS, ORCHESTRATOR_MCP_TOOLS, type McpCall, type McpMethods } from '../src/board-mcp.ts';
import { createBoardMcpHttp } from '../src/board-mcp-http.ts';
import type { RpcHandlers } from '../src/rpc.ts';
import type { Agent, AgentUpdatedEvent, DaemonEvent } from '../src/protocol.ts';
import { connectTestClient, recordEvents, startTestDaemon, tempDataDir, tempRepo } from './helpers.ts';

const SIZE = { cols: 120, rows: 40 };

/**
 * A daemon whose agents play the fake harnesses' `orchestrate` scenario, which can print an agent's board token. The
 * user starts each of them by hand, so no agent may act on another.
 */
async function httpDaemon() {
  const daemon = await startTestDaemon({
    worktreesDir: tempDataDir(),
    agentEnv: fakeHarnessEnv({ scenario: 'orchestrate', home: tempDataDir(), idleNotifyMs: 200 }),
  });
  const client = await connectTestClient(daemon);
  const recorder = recordEvents(client);
  const zone = await client.call('zone.add', { path: tempRepo(), x: 0, y: 0, name: 'web' });
  const url = `http://127.0.0.1:${daemon.hookPort}/mcp`;

  /** Starts an agent that prints its board token and waits at its prompt: the token its harness posts MCP with. */
  const agentWithToken = async (name: string) => {
    const agent = await client.call('agent.spawn', { zoneId: zone.id, prompt: 'Print your board identity', name, ...SIZE });
    await client.call('session.attach', { sessionId: agent.sessionId });
    await recorder.waitForText(agent.sessionId, ':end\r\n');
    const token = /identity:(.*):end\r\n/.exec(recorder.screenText(agent.sessionId))![1]!;
    return { agent, token };
  };

  /** The agent's latest update, once it matches. */
  const until = async (sessionId: string, match: (agent: Agent) => boolean): Promise<Agent> => {
    const matching = (e: DaemonEvent): e is AgentUpdatedEvent => e.type === 'agent.updated' && e.agent.sessionId === sessionId && match(e.agent);
    await recorder.waitFor(matching);
    return recorder.events.filter(matching).at(-1)!.agent;
  };

  /** An MCP client over HTTP, as the harness is, holding `token`. */
  const mcpAs = (token: string) => new McpClient({ url, headers: { Authorization: `Bearer ${token}` } }, tempDataDir());

  /** One JSON-RPC message posted as is, with `headers`. */
  const post = (message: unknown, headers: Record<string, string> = {}, signal?: AbortSignal) =>
    fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
      body: JSON.stringify(message),
      signal,
    });

  return { daemon, client, recorder, zone, url, agentWithToken, until, mcpAs, post };
}

const PING = { jsonrpc: '2.0', id: 1, method: 'ping' };

describe('the board MCP over HTTP', () => {
  it('refuses a request with no token, or one no live session holds, before it reads it', async () => {
    const { client, agentWithToken, post } = await httpDaemon();
    const { agent, token } = await agentWithToken('one');

    expect((await post(PING)).status).toBe(401);
    expect((await post(PING, { authorization: 'Bearer forged' })).status).toBe(401);
    expect((await post(PING, { authorization: `Bearer ${token}` })).status).toBe(200);

    await client.call('agent.stop', { sessionId: agent.sessionId });
    await expect.poll(async () => (await post(PING, { authorization: `Bearer ${token}` })).status).toBe(401);
  });

  it('takes only a POST, from no web page', async () => {
    const { url, agentWithToken, post } = await httpDaemon();
    const { token } = await agentWithToken('one');

    const get = await fetch(url, { headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' } });
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST');
    expect((await post(PING, { authorization: `Bearer ${token}`, origin: 'https://evil.example' })).status).toBe(403);
    expect((await post(PING, { authorization: `Bearer ${token}`, origin: 'http://127.0.0.1' })).status).toBe(200);
  });

  it('acts as the session whose token it carries, and as no other', async () => {
    const { client, agentWithToken, mcpAs } = await httpDaemon();
    const one = await agentWithToken('one');
    const two = await agentWithToken('two');
    const mcp = mcpAs(one.token);

    // A live agent's own session may act on other agents: it is told so, and listed the control tools.
    expect((await mcp.initialize()).instructions).toBe(`${BOARD_MCP_INSTRUCTIONS} ${ORCHESTRATOR_INSTRUCTIONS}`);
    expect(await mcp.listTools()).toEqual([
      'whoami', 'board', 'usage', 'connections', 'handoff', 'ask', 'present_plan', 'show_doc', 'set_status', 'needs_you', 'open_pr', 'record_pr', 'record_doc', 'pin', 'unpin', 'steps_new', 'steps_read', 'steps_update', 'memory_new', 'memory_read', 'memory_update', 'queue_new', 'queue_read', 'queue_update', 'remind', 'remind_read', 'remind_update', 'set_page', 'clock_add', 'clock_set', 'save_clock_template', 'list_clock_templates', 'remove_clock_template',
      ...ORCHESTRATOR_MCP_TOOLS.map((tool) => tool.name),
    ]);
    // It adds a clock of its own.
    expect(await mcp.callTool('clock_add', { cron: '0 9 * * 1-5', prompt: 'Check the PRs', after: 'hibernate' })).toEqual({
      text: expect.stringMatching(/^Added item:\S+ {2}Weekdays 09:00 \(0 9 \* \* 1-5\) {2}messages agent:\S+ one, hibernating it after each run/),
      isError: false,
    });
    expect((await mcp.callTool('whoami', {})).text).toMatch(new RegExp(`^you {6}agent:${one.agent.sessionId.slice(0, 4)}\\w* {2}one`));
    expect(await mcp.callTool('set_status', { summary: 'Moving session ids', progress: 40 })).toEqual({
      text: 'Your tile now says: Moving session ids',
      isError: false,
    });

    const agents = await client.call('agent.list');
    expect(agents.find((a) => a.sessionId === one.agent.sessionId)!.status).toMatchObject({ summary: 'Moving session ids', progress: null });
    expect(agents.find((a) => a.sessionId === two.agent.sessionId)!.status).toBeNull();
  });

  it('lets an agent save, list and remove clock templates, its own alone, and start its own clock from one', async () => {
    const { client, agentWithToken, mcpAs } = await httpDaemon();
    const one = await agentWithToken('one');
    const two = await agentWithToken('two');
    const mcp = mcpAs(one.token);

    expect(await mcp.callTool('save_clock_template', { name: 'PR watch', cron: '0 9 * * 1-5', prompt: 'Check the PRs', after: 'hibernate' })).toEqual({
      text: 'Saved "PR watch"  Weekdays 09:00 (0 9 * * 1-5)  hibernates its agent after each run  saved by one\n    "Check the PRs"',
      isError: false,
    });
    expect(await mcp.callTool('save_clock_template', { name: 'Fresh', cron: '@daily', prompt: 'Go', after: 'close', result: 'handoff' })).toMatchObject({
      isError: true,
      text: expect.stringContaining('--result must be history or note'),
    });
    expect(await mcp.callTool('list_clock_templates', {})).toEqual({ text: expect.stringMatching(/^"PR watch" .+ saved by one\n {4}"Check the PRs"$/), isError: false });
    expect(await mcp.callTool('clock_add', { template: 'pr watch' })).toMatchObject({ isError: false, text: expect.stringContaining('hibernating it after each run') });
    expect((await client.call('item.list')).find((item) => item.kind === 'clock')!.data).toMatchObject({ prompt: 'Check the PRs', agent: one.agent.sessionId });

    expect(await mcpAs(two.token).callTool('remove_clock_template', { template: 'PR watch' })).toMatchObject({ isError: true, text: expect.stringContaining("isn't one you saved") });
    expect(await mcp.callTool('remove_clock_template', { template: 'PR watch' })).toEqual({ text: 'Removed the template "PR watch".', isError: false });
    expect(await client.call('clockTemplate.list', {})).toEqual([]);
  });

  it('keeps an agent to what its session may do: a control tool on an agent the user started by hand is refused', async () => {
    const { client, agentWithToken, post } = await httpDaemon();
    const { token } = await agentWithToken('one');
    const two = await agentWithToken('two');

    const called = await post(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'close', arguments: { agent: `agent:${two.agent.sessionId.slice(0, 4)}` } } },
      { authorization: `Bearer ${token}` },
    );
    const reply = JSON.parse(/^data: (.*)$/m.exec(await called.text())![1]!);
    expect(reply.result).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/started by hand/) }] });
    expect((await client.call('agent.list')).find((a) => a.sessionId === two.agent.sessionId)!.endedAt).toBeNull();
  });

  it('answers a notification with 202 and no body, and a tool call as an event stream', async () => {
    const { agentWithToken, post } = await httpDaemon();
    const { token } = await agentWithToken('one');
    const auth = { authorization: `Bearer ${token}` };

    const notified = await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, auth);
    expect(notified.status).toBe(202);
    expect(await notified.text()).toBe('');

    const pinged = await post(PING, auth);
    expect(pinged.headers.get('content-type')).toBe('application/json');
    expect(await pinged.json()).toEqual({ jsonrpc: '2.0', id: 1, result: {} });

    const called = await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'board', arguments: {} } }, auth);
    expect(called.headers.get('content-type')).toBe('text/event-stream');
    const data = /^data: (.*)$/m.exec(await called.text())![1]!;
    expect(JSON.parse(data)).toMatchObject({ id: 2, result: { content: [{ type: 'text', text: expect.stringMatching(/^zone:\w+ {2}web/) }] } });

    expect((await post([PING], auth)).status).toBe(400);
    expect((await post({ jsonrpc: '2.0', id: 3, method: 'server/discover' }, auth).then((r) => r.json())).error).toMatchObject({ code: -32601 });
  });

  it('drops a question once the harness hangs up on its call', async () => {
    const { agentWithToken, until, post } = await httpDaemon();
    const { agent, token } = await agentWithToken('one');
    const hangUp = new AbortController();

    const call = post(
      { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'ask', arguments: { question: 'Which cache?' } } },
      { authorization: `Bearer ${token}` },
      hangUp.signal,
    ).then((response) => response.text());
    call.catch(() => {});
    expect((await until(agent.sessionId, (seen) => seen.ask !== null)).ask).toMatchObject({ question: 'Which cache?' });

    hangUp.abort();
    expect((await until(agent.sessionId, (seen) => seen.ask === null)).ask).toBeNull();
  });

  it('drops a question once the harness cancels its call', async () => {
    const { agentWithToken, until, post } = await httpDaemon();
    const { agent, token } = await agentWithToken('one');
    const auth = { authorization: `Bearer ${token}` };

    const call = post({ jsonrpc: '2.0', id: 'q', method: 'tools/call', params: { name: 'ask', arguments: { question: 'Which cache?' } } }, auth);
    await until(agent.sessionId, (seen) => seen.ask !== null);

    expect((await post({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'q' } }, auth)).status).toBe(202);
    expect((await until(agent.sessionId, (seen) => seen.ask === null)).ask).toBeNull();
    // A cancelled call hears no answer: its stream ends without one.
    expect(await (await call).text()).not.toMatch(/^data:/m);
  });

  it('reads a plan file from where the agent started, not where the daemon runs', async () => {
    const { agentWithToken, until, post } = await httpDaemon();
    const { agent, token } = await agentWithToken('one');
    writeFileSync(join(agent.cwd, 'plan.md'), '# Move the ids\n\n1. Daemon first\n');
    const hangUp = new AbortController();

    const call = post(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'present_plan', arguments: { title: 'Move the ids', path: 'plan.md' } } },
      { authorization: `Bearer ${token}` },
      hangUp.signal,
    );
    call.catch(() => {});
    expect((await until(agent.sessionId, (seen) => seen.plan !== null)).plan).toMatchObject({ title: 'Move the ids' });
    hangUp.abort();
  });

  it('keeps a long tool call alive with a comment line until it answers', async () => {
    const transport = createBoardMcpHttp({ keepAliveMs: 20 });
    let answer: () => void = () => {};
    const handlers = {
      'tools/call': () => new Promise((resolve) => (answer = () => resolve({ content: [{ type: 'text', text: 'Redis' }] }))),
    } as unknown as RpcHandlers<McpMethods, McpCall>;
    const server = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk: Buffer) => (body += chunk));
      request.on('end', () => transport.serve(body, response, { sessionId: 'one', handlers }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));

    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ask' } }),
    });
    // The headers come at once, before any answer.
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
    let seen = '';
    while ((seen.match(/: keep-alive\n\n/g) ?? []).length < 3) seen += (await reader.read()).value;
    answer();
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) seen += chunk.value;
    expect(seen).toMatch(/^(: keep-alive\n\n)+event: message\ndata: \{.*"text":"Redis".*\}\n\n$/);
  });

  it('keeps text whole as a document with memory_update, lists it by its title, and confirms an entry', async () => {
    const { agentWithToken, mcpAs } = await httpDaemon();
    const mcp = mcpAs((await agentWithToken('one')).token);
    expect((await mcp.callTool('memory_new', { title: 'Handbook' })).isError).toBe(false);
    await mcp.callTool('memory_update', { memory: 'Handbook', action: 'add', text: 'db-host: pg.internal' });
    const added = await mcp.callTool('memory_update', { memory: 'Handbook', action: 'add', document: 'Runbook', text: 'Step one\nStep two' });
    expect(added.text).toContain('Remembered Runbook in “Handbook”');
    expect((await mcp.callTool('memory_update', { memory: 'Handbook', action: 'add', document: 'Runbook', key: 'x', text: 'y' })).text).toContain('a document is its title and text');

    const listed = await mcp.callTool('memory_read', { memory: 'Handbook' });
    expect(listed.text).toContain('document “Runbook”');
    expect(listed.text).not.toContain('Step two');
    expect((await mcp.callTool('memory_read', { memory: 'Handbook', entry: 'Runbook' })).text).toContain('Step two');
    expect((await mcp.callTool('memory_update', { memory: 'Handbook', action: 'confirm', entry: 'db-host' })).text).toMatch(/^Confirmed db-host in “Handbook”/);
  });
});
