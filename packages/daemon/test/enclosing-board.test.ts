// A test run started by an agent on a live board inherits that board's session variables. Each test here
// runs something that would call the board those variables name, so a scrub that lets them through hits the sentinel.
import { describe, expect, it } from 'vitest';
import { fakeHarnessEnv } from '@agent-board/fake-harness';
import { runBoardCommand } from '../src/board-cli.ts';
import { paneIds } from '../src/pane-layout.ts';
import { connectTestClient, enclosingBoard, recordEvents, startTestDaemon, tempDataDir } from './helpers.ts';

describe('a test run inside an agent on a live board', () => {
  it("gives the fakes no socket of the live board for the agent-board CLI to reach (fakeHarnessEnv's scrub)", async () => {
    const { hits } = await enclosingBoard();
    let err = '';
    const env = fakeHarnessEnv({ scenario: 'output', home: tempDataDir() });

    const code = await runBoardCommand('tree', [], { out: () => {}, err: (text) => (err += text), env });

    expect(hits).toEqual([]);
    expect({ code, err }).toMatchObject({ code: 1, err: expect.stringContaining("agent-board isn't running") });
  });

  it("gives a test daemon's shells no hook URL of the live board to post to (sessionEnv's scrub)", async () => {
    const { hits } = await enclosingBoard();
    const daemon = await startTestDaemon();
    const client = await connectTestClient(daemon);
    const recorder = recordEvents(client);
    // A loose shell: the daemon gives it no hook variables of its own, so it would keep whatever the daemon's env has.
    const shell = await client.call('shell.create', { zoneId: null, position: { x: 0, y: 0 } });
    const pane = paneIds(shell.layout)[0]!;
    await client.call('session.attach', { sessionId: pane });

    await client.call('session.write', {
      sessionId: pane,
      data: '[ -z "$AGENT_BOARD_HOOK_URL" ] || curl -s -m 5 -o /dev/null -X POST "$AGENT_BOARD_HOOK_URL"; echo "posted:$((1 + 1))"\r',
    });
    await recorder.waitForText(pane, 'posted:2');

    expect(hits).toEqual([]);
  });
});
