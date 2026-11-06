import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Has every Node process of a test run keep its compiled code in one cache dir, by the variable children inherit. Node
 * keys entries by Node version and absolute path, so each worktree warms its own, and an edited file just misses. It
 * writes them at a clean exit, so a process killed by a signal, as a test's fake harness usually is, writes nothing
 * unless it flushes (`runFakeCli`). A dir already set is kept.
 */
export function compileCacheGlobalSetup(env: NodeJS.ProcessEnv = process.env): void {
  env.NODE_COMPILE_CACHE ??= join(tmpdir(), 'agent-board-compile-cache');
}
