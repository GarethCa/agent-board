import { lstatSync, mkdirSync, readlinkSync, renameSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Links `binDir/agent-board` to the CLI launcher at `cliPath` (ADR-0010), as VS Code's "Install 'code' command" does:
 * no sudo, and the link follows the launcher the daemon keeps up to date. Replaces a link already there, but never a
 * file of someone else's. Returns the link's path.
 */
export function installCli(cliPath: string, binDir: string): string {
  const link = join(binDir, 'agent-board');
  mkdirSync(binDir, { recursive: true });
  let existing;
  try {
    existing = lstatSync(link);
  } catch {
    // Nothing there yet.
  }
  if (existing !== undefined && !existing.isSymbolicLink()) {
    throw new Error(`${link} is already there and isn't a link; move it away first`);
  }
  if (existing !== undefined && readlinkSync(link) === cliPath) return link;
  // Made beside it and renamed over it, so `agent-board` is never missing meanwhile.
  const temp = `${link}.${process.pid}.tmp`;
  symlinkSync(cliPath, temp);
  renameSync(temp, link);
  return link;
}
