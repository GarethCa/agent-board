import { describe, expect, it } from 'vitest';
import { RPC_ERROR } from '../src/protocol.ts';
import { handleRpcLine, RpcMethodError, withoutCredentials, type RpcHandlers } from '../src/rpc.ts';

interface Methods {
  'zone.broken': { params: undefined; result: null };
  'zone.refused': { params: undefined; result: null };
  'zone.said': { params: undefined; result: null };
  'zone.pushed': { params: undefined; result: null };
  'zone.sqlite': { params: undefined; result: null };
  'zone.thrown': { params: undefined; result: null };
}

const handlers: RpcHandlers<Methods> = {
  'zone.broken': () => {
    const nothing = undefined as unknown as { nodes: unknown[] };
    return nothing.nodes.length as never;
  },
  'zone.refused': () => {
    throw new RpcMethodError(RPC_ERROR.invalidParams, "Alpha can't be paused: it is mid-turn");
  },
  'zone.said': () => {
    throw new Error('monorepo already has a branch pick-a-cache');
  },
  'zone.pushed': () => {
    throw new Error("git push failed: fatal: unable to access 'https://ada:not-a-token@example.test/app.git/': 403\nhint: check your token");
  },
  'zone.sqlite': () => {
    throw Object.assign(new Error('no such table: zones'), { code: 'ERR_SQLITE_ERROR' });
  },
  'zone.thrown': () => {
    throw 'out of cheese';
  },
};

const call = (method: keyof Methods, logged: string[], logPath?: string) =>
  handleRpcLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method }), handlers, undefined, { log: (line) => void logged.push(line), logPath });

describe('an error a method throws', () => {
  it('reaches the client as a plain message when it is a bug, its detail and stack kept in the log under the same id', async () => {
    const logged: string[] = [];
    const response = await call('zone.broken', logged);

    expect(response).toMatchObject({ id: 1, error: { code: RPC_ERROR.internal } });
    const message = (response as { error: { message: string } }).error.message;
    expect(message).toMatch(/^Something went wrong in zone\.broken \(error [0-9a-f]{6}\)\. Details are in the daemon log\.$/);
    expect(message).not.toContain('Cannot read properties');
    const id = /error ([0-9a-f]{6})/.exec(message)![1]!;
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain(`zone.broken failed (error ${id})`);
    expect(logged[0]).toContain("TypeError: Cannot read properties of undefined (reading 'nodes')");
    expect(logged[0]).toMatch(/\n\s+at /);
  });

  it('says where the daemon log is, when it knows', async () => {
    const response = await call('zone.broken', [], '/data/daemon.log');
    expect((response as { error: { message: string } }).error.message).toMatch(/Details are in the daemon log \(\/data\/daemon\.log\)\.$/);
  });

  it("from the runtime's own failures, a database's among them, is plain too", async () => {
    const logged: string[] = [];
    const response = await call('zone.sqlite', logged);
    expect((response as { error: { message: string } }).error.message).toMatch(/^Something went wrong in zone\.sqlite/);
    expect(logged[0]).toContain('no such table: zones');
  });

  it('keeps a refusal written for the user exactly as it was written, and logs nothing', async () => {
    const logged: string[] = [];
    expect(await call('zone.refused', logged)).toEqual({
      jsonrpc: '2.0',
      id: 1,
      error: { code: RPC_ERROR.invalidParams, message: "Alpha can't be paused: it is mid-turn" },
    });
    expect(logged).toEqual([]);
  });

  it('keeps the words of an error the daemon wrote, and logs only its first line, with no stack', async () => {
    const logged: string[] = [];
    expect(await call('zone.said', logged)).toMatchObject({ error: { code: RPC_ERROR.internal, message: 'monorepo already has a branch pick-a-cache' } });
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatch(/^rpc zone\.said failed \(error [0-9a-f]{6}\): monorepo already has a branch pick-a-cache$/);
  });

  it('logs no credentials from a URL in an error', async () => {
    const logged: string[] = [];
    await call('zone.pushed', logged);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatch(/: git push failed: fatal: unable to access 'https:\/\/\*\*\*@example\.test\/app\.git\/': 403$/);
    expect(logged[0]).not.toContain('not-a-token');
    expect(withoutCredentials('a http://u@x b ssh://git:p%40ss@host/c d https://host/a@b')).toBe('a http://***@x b ssh://***@host/c d https://host/a@b');
  });

  it('with nowhere to log it, still reaches the client whole, even when it is no Error', async () => {
    const bare = (method: keyof Methods) => handleRpcLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method }), handlers, undefined);
    expect(((await bare('zone.broken')) as { error: { message: string } }).error.message).toContain('Cannot read properties of undefined');
    expect(await bare('zone.thrown')).toMatchObject({ error: { code: RPC_ERROR.internal, message: 'out of cheese' } });
  });
});
