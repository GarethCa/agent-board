import { describe, expect, it, onTestFinished } from 'vitest';
import { startHookIngress } from '../src/hook-ingress.ts';
import { hashToken } from '../src/tokens.ts';
import type { DaemonEvent } from '../src/protocol.ts';
import { connectTestClient, insertFakeSession, startTestDaemon, tempDataDir } from './helpers.ts';

const STOP = { hook_event_name: 'Stop', session_id: 'claude-123', last_assistant_message: 'done' };

function postHook(port: number, init: { token?: string; body?: string; path?: string; method?: string } = {}) {
  return fetch(`http://127.0.0.1:${port}${init.path ?? '/hooks'}`, {
    method: init.method ?? 'POST',
    headers: init.token === undefined ? {} : { authorization: `Bearer ${init.token}` },
    body: init.method === 'GET' ? undefined : (init.body ?? JSON.stringify(STOP)),
  });
}

async function daemonWithSession() {
  const dataDir = tempDataDir();
  const daemon = await startTestDaemon({ dataDir });
  const session = insertFakeSession(dataDir, { id: 'session-1', hookToken: 'secret-token' });
  const client = await connectTestClient(daemon);
  const events: DaemonEvent[] = [];
  client.onEvent((event) => events.push(event));
  return { daemon, client, session, events };
}

describe('hook ingress', () => {
  it('rejects a hook call with no token', async () => {
    const { daemon, events } = await daemonWithSession();
    const response = await postHook(daemon.hookPort);
    expect(response.status).toBe(401);
    expect(events).toEqual([]);
  });

  it('rejects a hook call with a token no session holds', async () => {
    const { daemon, events } = await daemonWithSession();
    const response = await postHook(daemon.hookPort, { token: 'guessed-token' });
    expect(response.status).toBe(401);
    expect(events).toEqual([]);
  });

  it("rejects a token once its session has ended", async () => {
    const { daemon, session, events } = await daemonWithSession();
    session.end();
    const response = await postHook(daemon.hookPort, { token: 'secret-token' });
    expect(response.status).toBe(401);
    expect(events).toEqual([]);
  });

  it("accepts a live session's token and streams the hook to clients, attributed to that session", async () => {
    const { daemon, client, events } = await daemonWithSession();

    const response = await postHook(daemon.hookPort, { token: 'secret-token' });
    await client.call('daemon.health'); // the event is written before this response

    expect(response.status).toBe(200);
    expect(events).toEqual([{ type: 'hook', sessionId: 'session-1', event: 'Stop', payload: STOP }]);
  });

  it('accepts the auth scheme in any case', async () => {
    const { daemon } = await daemonWithSession();
    const response = await fetch(`http://127.0.0.1:${daemon.hookPort}/hooks`, {
      method: 'POST',
      headers: { authorization: 'bearer secret-token' },
      body: JSON.stringify(STOP),
    });
    expect(response.status).toBe(200);
  });

  it('rejects a body that is not a hook payload', async () => {
    const { daemon, events } = await daemonWithSession();
    expect((await postHook(daemon.hookPort, { token: 'secret-token', body: '{nope' })).status).toBe(400);
    expect((await postHook(daemon.hookPort, { token: 'secret-token', body: '[]' })).status).toBe(400);
    expect(events).toEqual([]);
  });

  it('rejects an oversized body', async () => {
    const { daemon, client, events } = await daemonWithSession();
    const body = JSON.stringify({ hook_event_name: 'Stop', padding: 'x'.repeat(2 * 1024 * 1024) });
    const response = await postHook(daemon.hookPort, { token: 'secret-token', body }).catch(() => undefined);
    // The server may answer 413 or drop the connection mid-upload; either way nothing gets through.
    if (response) expect(response.status).toBe(413);
    await client.call('daemon.health');
    expect(events).toEqual([]);
  });

  it('only serves POST /hooks', async () => {
    const { daemon } = await daemonWithSession();
    expect((await postHook(daemon.hookPort, { token: 'secret-token', path: '/other' })).status).toBe(404);
    expect((await postHook(daemon.hookPort, { token: 'secret-token', method: 'GET' })).status).toBe(405);
  });

  describe('replies', () => {
    async function ingress(onHook: Parameters<typeof startHookIngress>[0]['onHook']) {
      const started = await startHookIngress({
        sessionForToken: (hash) => (hash === hashToken('secret-token') ? 'session-1' : undefined),
        onHook,
      });
      onTestFinished(() => started.close());
      return started;
    }

    it("answers with the handler's JSON body, once it resolves", async () => {
      let answer: ((body: Record<string, unknown>) => void) | undefined;
      const { port } = await ingress(() => new Promise((resolve) => (answer = resolve)));

      const response = postHook(port, { token: 'secret-token' });
      await expect.poll(() => answer).toBeTypeOf('function');
      answer!({ hookSpecificOutput: { decision: { behavior: 'allow' } } });

      const answered = await response;
      expect(answered.status).toBe(200);
      expect(answered.headers.get('content-type')).toBe('application/json');
      expect(await answered.json()).toEqual({ hookSpecificOutput: { decision: { behavior: 'allow' } } });
    });

    it('answers with an empty 200 when the handler has nothing to say', async () => {
      const { port } = await ingress(() => undefined);
      const response = await postHook(port, { token: 'secret-token' });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('');
    });

    it('aborts the signal it gave the handler when the harness hangs up', async () => {
      let signal!: AbortSignal;
      const { port } = await ingress((_sessionId, _event, _payload, given) => {
        signal = given;
        return new Promise(() => {});
      });
      const hangUp = new AbortController();

      const response = fetch(`http://127.0.0.1:${port}/hooks`, {
        method: 'POST',
        headers: { authorization: 'Bearer secret-token' },
        body: JSON.stringify(STOP),
        signal: hangUp.signal,
      }).catch(() => 'hung up');
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(signal.aborted).toBe(false);
      hangUp.abort();

      expect(await response).toBe('hung up');
      await expect.poll(() => signal.aborted).toBe(true);
    });
  });
});
