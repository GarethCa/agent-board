import { describe, expect, it } from 'vitest';
import { BOARD_SESSION_VARS } from '@agent-board/fake-harness';
import { BOARD_SESSION_ENV, BOARD_SOCKET_ENV, BOARD_TOKEN_ENV, BOARD_ZONE_ENV } from '../src/board-env.ts';
import { HOOK_TOKEN_ENV, HOOK_URL_ENV } from '../src/hook-forwarder.ts';
import { refuseLiveDaemon } from '../src/board-ops.ts';

describe("the test guard's list of a board's session variables", () => {
  it('names every variable the daemon hands a session it starts', () => {
    expect([...BOARD_SESSION_VARS].sort()).toEqual(
      [HOOK_URL_ENV, HOOK_TOKEN_ENV, BOARD_SOCKET_ENV, BOARD_TOKEN_ENV, BOARD_ZONE_ENV, BOARD_SESSION_ENV].sort(),
    );
  });
});

describe("the CLI's refusal of the app's own daemon under a test", () => {
  const live = '/home/me/agent-board/daemon.sock';

  it('refuses the live socket while a test runs', () => {
    expect(() => refuseLiveDaemon(live, { VITEST: 'true' }, live)).toThrow(/refusing the app's own daemon/);
  });

  it("leaves a test's own daemon, and every socket outside a test, alone", () => {
    expect(() => refuseLiveDaemon('/tmp/test/daemon.sock', { VITEST: 'true' }, live)).not.toThrow();
    expect(() => refuseLiveDaemon(live, {}, live)).not.toThrow();
  });
});
