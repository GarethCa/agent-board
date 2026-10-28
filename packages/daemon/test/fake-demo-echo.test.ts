import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeBinDir, fakeHarnessEnv } from '@agent-board/fake-harness';
import { describe, expect, it, onTestFinished } from 'vitest';
import { createNodePtyBackend } from '../src/node-pty-backend.ts';

// The fake's demo TUI in a real terminal, typed at as the board types an agent's first message: as the real TUIs, it
// shows the message once, as its own `>` line, and the terminal doesn't echo the typing (paste markers and all).

describe('the fake claude’s demo TUI in a terminal', () => {
  it('shows a pasted prompt once, as its own line, with no echo of the typing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ab-demo-echo-'));
    const backend = createNodePtyBackend();
    onTestFinished(() => {
      for (const terminal of backend.list()) backend.kill(terminal.id, 'SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    });
    const env = fakeHarnessEnv({ scenario: 'demo-plan', home: dir, base: { PATH: process.env.PATH ?? '/usr/bin:/bin' } });
    backend.spawn({ id: 'demo', command: join(fakeBinDir, 'claude'), args: [], cwd: dir, env: { ...env, TERM: 'xterm-256color' } as Record<string, string>, cols: 100, rows: 30 });
    let output = '';
    const seen = (text: string) =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no ${JSON.stringify(text)}; output so far: ${JSON.stringify(output)}`)), 10_000);
        const check = () => {
          if (!output.includes(text)) return;
          clearTimeout(timer);
          resolve();
        };
        listeners.push(check);
        check();
      });
    const listeners: (() => void)[] = [];
    backend.attach('demo', { onData: (data) => ((output += data), listeners.forEach((listener) => listener())), onExit: () => {} });

    // Echo goes off before the welcome box is drawn.
    await seen('Welcome back!');
    backend.write('demo', '\x1b[200~Plan ACME-12\x1b[201~\r');
    await seen('Plan ACME-12');
    await seen('plan.md');

    expect(output).not.toContain('[200~');
    expect(output.split('Plan ACME-12').length - 1).toBe(1);
  });
});
