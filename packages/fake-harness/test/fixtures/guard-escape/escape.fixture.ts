import { it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The guard can't read a script file, so only the PATH tripwire sees this, and `|| true` hides the exit code.
it('reaches claude from inside a script', () => {
  const dir = mkdtempSync(join(tmpdir(), 'escape-'));
  try {
    const script = join(dir, 'run.sh');
    writeFileSync(script, 'claude --version || true\n');
    execFileSync('/bin/sh', [script]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
