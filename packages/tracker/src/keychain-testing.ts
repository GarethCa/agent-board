import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Creates an unlocked, empty macOS keychain file outside the user's keychain search list, so tests never read or
 * write the login keychain. Returns its path and the function that deletes it.
 */
export function createTempKeychain(): { path: string; remove(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'ab-keychain-'));
  const path = join(dir, 'test.keychain-db');
  execFileSync('security', ['create-keychain', '-p', 'test', path]);
  execFileSync('security', ['unlock-keychain', '-p', 'test', path]);
  // No auto-lock while a test runs.
  execFileSync('security', ['set-keychain-settings', path]);
  return {
    path,
    remove() {
      try {
        execFileSync('security', ['delete-keychain', path]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}
