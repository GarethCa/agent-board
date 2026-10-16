import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BOARD_SESSION_VARS, fakeHarnessEnv, RUN_KNOBS, scrubBoardEnv } from '../src/index.ts';

/** What a board hands an agent it starts, as an agent's own test run would inherit it. */
const boardSessionEnv = {
  AGENT_BOARD_HOOK_URL: 'http://127.0.0.1:9/hooks',
  AGENT_BOARD_HOOK_TOKEN: 'hook-token',
  AGENT_BOARD_SOCKET: '/nowhere/daemon.sock',
  AGENT_BOARD_IDENTITY: 'board-token',
  AGENT_BOARD_ZONE_ID: 'zone',
  AGENT_BOARD_SESSION_ID: 'session',
};

describe('board guard', () => {
  it('starts the worker with none of an enclosing board\'s session variables', () => {
    expect(BOARD_SESSION_VARS.filter((name) => process.env[name] !== undefined)).toEqual([]);
  });

  it('keeps only the run knobs at the start of a run', () => {
    const env = scrubBoardEnv({ ...boardSessionEnv, AGENT_BOARD_DATA_DIR: '/real/app', AGENT_BOARD_GATE: '1', AGENT_BOARD_E2E_WORKERS: '2', PATH: '/bin' });
    expect(env).toEqual({ AGENT_BOARD_GATE: '1', AGENT_BOARD_E2E_WORKERS: '2', PATH: '/bin' });
  });

  it("leaves the board's session variables out of the fakes' environment, unless the test hands them in", () => {
    const before = { ...process.env };
    Object.assign(process.env, boardSessionEnv);
    try {
      const env = fakeHarnessEnv({ scenario: 'output', home: '/tmp/home' });
      expect(BOARD_SESSION_VARS.filter((name) => env[name] !== undefined)).toEqual([]);
      const own = fakeHarnessEnv({ scenario: 'output', home: '/tmp/home', base: { AGENT_BOARD_HOOK_URL: 'http://127.0.0.1:1/hooks' } });
      expect(own.AGENT_BOARD_HOOK_URL).toBe('http://127.0.0.1:1/hooks');
    } finally {
      for (const name of BOARD_SESSION_VARS) {
        if (before[name] === undefined) delete process.env[name];
        else process.env[name] = before[name];
      }
    }
  });

  it("drops the enclosing board's variables in Vitest's global setup, before any worker starts", () => {
    const fixture = fileURLToPath(new URL('./fixtures/board-env', import.meta.url));
    const vitest = fileURLToPath(new URL('../../../node_modules/vitest/vitest.mjs', import.meta.url));
    const env = { ...process.env, ...boardSessionEnv, AGENT_BOARD_DATA_DIR: '/real/app', AGENT_BOARD_E2E_WORKERS: '2' };

    const result = spawnSync(process.execPath, [vitest, 'run', '--root', fixture], { encoding: 'utf8', env });

    expect(result.stdout + result.stderr).toMatch(/2 passed/);
    expect(result.status).toBe(0);
  }, 30_000);

  it('keeps the same run knobs in scripts/check-local.sh', () => {
    const script = readFileSync(fileURLToPath(new URL('../../../scripts/check-local.sh', import.meta.url)), 'utf8');
    const kept = /^ {4}(AGENT_BOARD_[A-Z0-9_ |]+)\) ;;$/m.exec(script)?.[1]?.split(' | ');
    expect(kept).toEqual([...RUN_KNOBS]);
  });
});
