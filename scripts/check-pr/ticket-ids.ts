/**
 * Whether a change can trip the public release's leak check: a changed text file that names a Linear ticket (team key, dash, number).
 * The release rewrites some forms, such as a ticket in parentheses, and stops at the rest, so `pnpm check:pr` runs
 * `pnpm release:public --dry-run --skip-verify` (a few seconds) whenever one is in the diff and main cannot drift.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The Linear team key. The test builds its tickets from this, so the release's rename of sample data in tests can't split them. */
export const TEAM = 'JAR';
const TICKET = new RegExp(`\\b${TEAM}-\\d+`);
const BINARY = /\.(png|jpe?g|gif|ico|icns|webp|woff2?|ttf|otf|zip|gz)$/i;

/** The changed files (relative to `root`) that exist, are text, and mention a ticket ID. */
export function filesNamingTickets(files: readonly string[], root: string): string[] {
  return files.filter((file) => {
    if (BINARY.test(file)) return false;
    try {
      return TICKET.test(readFileSync(join(root, file), 'utf8'));
    } catch {
      return false; // deleted, or a directory
    }
  });
}
