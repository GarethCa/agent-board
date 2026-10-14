// Claude Code's transcripts: `<config dir>/projects/<cwd, every other character a dash>/<session id>.jsonl`.
// `claude --resume <id>` looks for the conversation only under the folder it runs in.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/** Claude's project folder name for `cwd`: every character but a letter or digit a dash. */
function claudeProjectName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * Copies the transcript at `transcriptPath` into `cwd`'s project folder beside it, so a session resumed in another
 * folder (a new worktree, or one the user picked) carries on its conversation. Leaves one already there alone, and
 * does nothing when the transcript is gone.
 */
export function carryClaudeTranscript(transcriptPath: string, cwd: string): void {
  const target = join(dirname(dirname(transcriptPath)), claudeProjectName(cwd), basename(transcriptPath));
  if (target === transcriptPath || existsSync(target) || !existsSync(transcriptPath)) return;
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(transcriptPath, target);
}
