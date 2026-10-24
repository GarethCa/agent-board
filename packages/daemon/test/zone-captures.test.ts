import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fakeHarnessEnv } from '@agent-board/fake-harness';
import { runBoardCommand } from '../src/board-cli.ts';
import type { DaemonClient } from '../src/client.ts';
import { BOARD_ERROR, MAX_CAPTURE_PNG_BYTES, type CaptureRequestedEvent, type DaemonEvent } from '../src/protocol.ts';
import { connectTestClient, recordEvents, startTestDaemon, tempDataDir, tempRepo } from './helpers.ts';

// A picture of a zone for its orchestrator: the daemon asks the app, which captures it in a hidden window and hands the
// picture back. With no app to ask, or none that answers in time, the call fails rather than waits.

const SIZE = { cols: 120, rows: 40 };
/** A one-pixel PNG, as base64. */
const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

async function captureDaemon({ captureTimeoutMs }: { captureTimeoutMs?: number } = {}) {
  const daemon = await startTestDaemon({
    worktreesDir: tempDataDir(),
    agentEnv: fakeHarnessEnv({ scenario: 'orchestrate', home: tempDataDir(), idleNotifyMs: 200 }),
    ...(captureTimeoutMs === undefined ? {} : { captureTimeoutMs }),
  });
  const client = await connectTestClient(daemon);
  const recorder = recordEvents(client);
  const zone = await client.call('zone.add', { path: tempRepo(), x: 100, y: 200, width: 1200, height: 600, name: 'web' });
  const other = await client.call('zone.add', { path: tempRepo('other'), x: 3000, y: 0, name: 'other' });
  for (const { id } of [zone, other]) await client.call('zone.configure', { id, agentsOrchestrate: false });
  const agent = await client.call('agent.spawn', { zoneId: zone.id, name: 'lead', prompt: 'Print your board identity', orchestrate: 'zone', ...SIZE });
  await client.call('session.attach', { sessionId: agent.sessionId });
  await recorder.waitForText(agent.sessionId, ':end\r\n');
  const token = /identity:(.*):end\r\n/.exec(recorder.screenText(agent.sessionId))![1]!;
  const lead = await connectTestClient(daemon);
  await lead.call('board.identify', { token });
  return { daemon, client, zone, other, token, lead };
}

/** Connects as the app, ready to capture: resolves each capture request it hears with `answer`. */
async function app(setup: Awaited<ReturnType<typeof captureDaemon>>, answer?: (event: CaptureRequestedEvent, client: DaemonClient) => void) {
  const client = await connectTestClient(setup.daemon);
  const heard: CaptureRequestedEvent[] = [];
  client.onEvent((event: DaemonEvent) => {
    if (event.type !== 'capture.requested') return;
    heard.push(event);
    answer?.(event, client);
  });
  await client.call('capture.serve');
  return { client, heard };
}

describe('orchestrator.screenshot', () => {
  it('fails at once when no app is open to take the picture', async () => {
    const setup = await captureDaemon();
    await expect(setup.lead.call('orchestrator.screenshot', { token: setup.token })).rejects.toThrow("the app isn't open");
  });

  it("asks the app for the zone's rectangle, with a margin for its tab, and answers with the picture it hands back, and the zone's map", async () => {
    const setup = await captureDaemon();
    const { heard } = await app(setup, (event, client) => void client.call('capture.deliver', { id: event.id, png: PIXEL, width: 1280, height: 680 }));

    const shot = await setup.lead.call('orchestrator.screenshot', { token: setup.token });

    expect(heard).toEqual([{ type: 'capture.requested', id: expect.any(String), zoneId: setup.zone.id, style: 'board', rect: { x: 60, y: 160, width: 1280, height: 680 }, scale: 1, deadline: expect.any(Number) }]);
    expect(shot).toMatchObject({ zoneId: setup.zone.id, style: 'board', png: PIXEL, width: 1280, height: 680, scale: 1 });
    expect(shot.map).toMatchObject({ zoneId: setup.zone.id, name: 'web', width: 1200, height: 600, overlaps: [] });
  });

  it('draws a zone wider than the longest side a picture may have smaller, and says by how much', async () => {
    const setup = await captureDaemon();
    await setup.client.call('zone.update', { id: setup.zone.id, x: 100, y: 200, width: 3056, height: 720 });
    const { heard } = await app(setup, (event, client) => void client.call('capture.deliver', { id: event.id, png: PIXEL, width: 1568, height: 400 }));

    const shot = await setup.lead.call('orchestrator.screenshot', { token: setup.token });

    expect(heard[0]!.scale).toBe(0.5);
    expect(shot).toMatchObject({ width: 1568, height: 400, scale: 0.5 });
  });

  it('hands the app a plain drawing of the zone to take, for the lo-fi style', async () => {
    const setup = await captureDaemon();
    const { heard } = await app(setup, (event, client) => void client.call('capture.deliver', { id: event.id, png: PIXEL, width: 1280, height: 680 }));

    await setup.lead.call('orchestrator.screenshot', { token: setup.token, style: 'lofi' });

    const svg = heard[0]!.svg!;
    expect(svg).toMatch(/^<svg [^>]*width="1280" height="680" viewBox="-40 -40 1280 680"/);
    // Where the map has the lead: from the zone's top-left.
    const { things } = await setup.lead.call('orchestrator.map', { token: setup.token });
    const lead = things.find((thing) => thing.name === 'lead')!;
    expect(svg).toContain(`<rect x="${lead.x}" y="${lead.y}" width="${lead.width}" height="${lead.height}"`);
    expect(svg).toContain('>web</text>');
    expect(svg).toContain('>lead</text>');
    expect(svg).toContain('terminal hidden');
  });

  it('says the scale the app drew at, when it drew a picture too big to send smaller', async () => {
    const setup = await captureDaemon();
    await app(setup, (event, client) => void client.call('capture.deliver', { id: event.id, png: PIXEL, width: 640, height: 340 }));
    expect(await setup.lead.call('orchestrator.screenshot', { token: setup.token })).toMatchObject({ width: 640, height: 340, scale: 0.5 });
  });

  it('takes a PNG up to the size a model takes, and refuses a bigger one', async () => {
    const setup = await captureDaemon();
    const refused: string[] = [];
    await app(setup, (event, client) => {
      const most = Buffer.alloc(MAX_CAPTURE_PNG_BYTES).toString('base64');
      const over = Buffer.alloc(MAX_CAPTURE_PNG_BYTES + 3).toString('base64');
      void client
        .call('capture.deliver', { id: event.id, png: over, width: 1280, height: 680 })
        .catch((error: Error) => refused.push(error.message))
        .then(() => client.call('capture.deliver', { id: event.id, png: most, width: 1280, height: 680 }));
    });
    const shot = await setup.lead.call('orchestrator.screenshot', { token: setup.token });
    expect(refused).toEqual([`the picture must be at most ${MAX_CAPTURE_PNG_BYTES} bytes of PNG`]);
    expect(Buffer.from(shot.png, 'base64').length).toBe(MAX_CAPTURE_PNG_BYTES);
  });

  it("fails with the app's reason when it can't take the picture", async () => {
    const setup = await captureDaemon();
    await app(setup, (event, client) => void client.call('capture.fail', { id: event.id, message: 'the window crashed' }));
    await expect(setup.lead.call('orchestrator.screenshot', { token: setup.token })).rejects.toThrow("the app couldn't take the picture: the window crashed");
  });

  it('fails once the timeout passes with no picture handed back', async () => {
    const setup = await captureDaemon({ captureTimeoutMs: 100 });
    const { heard } = await app(setup);
    await expect(setup.lead.call('orchestrator.screenshot', { token: setup.token })).rejects.toThrow("the app didn't hand the picture back within 0.1 s");
    expect(heard).toHaveLength(1);
  });

  it('fails at once when the app closes while it takes the picture, and with no app to ask after', async () => {
    const setup = await captureDaemon();
    const { client } = await app(setup, (_event, client) => client.close());
    await expect(setup.lead.call('orchestrator.screenshot', { token: setup.token })).rejects.toThrow('the app closed before it took the picture');
    await client.closed;
    await expect(setup.lead.call('orchestrator.screenshot', { token: setup.token })).rejects.toThrow("the app isn't open");
  });

  it("refuses a zone outside the orchestrator's scope, without asking the app", async () => {
    const setup = await captureDaemon();
    const { heard } = await app(setup);
    const refused = setup.lead.call('orchestrator.screenshot', { token: setup.token, zoneId: setup.other.id });
    await expect(refused).rejects.toMatchObject({ code: BOARD_ERROR.outOfScope });
    expect(heard).toEqual([]);
  });
});

describe('the zone_screenshot MCP tool', () => {
  /** Calls `zone_screenshot` over the daemon's MCP, as the lead's harness does; the tool's result. */
  async function callTool(setup: Awaited<ReturnType<typeof captureDaemon>>, args: Record<string, unknown> = {}) {
    const response = await fetch(`http://127.0.0.1:${setup.daemon.hookPort}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${setup.token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'zone_screenshot', arguments: args } }),
    });
    return JSON.parse(/^data: (.*)$/m.exec(await response.text())![1]!).result;
  }

  it('answers with the picture as an image, then a caption with its size, scale and the lint', async () => {
    const setup = await captureDaemon();
    await app(setup, (event, client) => void client.call('capture.deliver', { id: event.id, png: PIXEL, width: 1280, height: 680 }));

    const result = await callTool(setup);

    expect(result.isError).toBeUndefined();
    expect(result.content[0]).toEqual({ type: 'image', data: PIXEL, mimeType: 'image/png' });
    expect(result.content[1]).toEqual({ type: 'text', text: expect.stringMatching(/^zone:\w+ web, 1200×600 px, drawn at 1× \(1280×680\), terminals hidden\.\nlint {2}(ok|check) · /) });
  });

  it('answers with the reason, as an error, when no app is open', async () => {
    const setup = await captureDaemon();
    const result = await callTool(setup, { style: 'lofi' });
    expect(result).toEqual({ isError: true, content: [{ type: 'text', text: expect.stringContaining("the app isn't open") }] });
  });
});

describe('agent-board zone screenshot', () => {
  it('writes the picture to --out, and prints where with the caption', async () => {
    const setup = await captureDaemon();
    await app(setup, (event, client) => void client.call('capture.deliver', { id: event.id, png: PIXEL, width: 1280, height: 680 }));
    const out = join(tempDataDir(), 'zone.png');
    let printed = '';

    const code = await runBoardCommand('zone', ['screenshot', '--out', out], {
      out: (text) => (printed += text),
      err: (text) => (printed += text),
      env: { AGENT_BOARD_SOCKET: setup.daemon.socketPath, AGENT_BOARD_IDENTITY: setup.token },
    });

    expect(code).toBe(0);
    expect(readFileSync(out).toString('base64')).toBe(PIXEL);
    expect(printed).toMatch(new RegExp(`^Wrote ${out}\nzone:\\w+ web, 1200×600 px, drawn at 1× \\(1280×680\\), terminals hidden\\.\nlint {2}(ok|check) · `));
  });
});
