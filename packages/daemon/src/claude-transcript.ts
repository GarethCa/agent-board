// Claude Code's transcripts: `<config dir>/projects/<cwd, every other character a dash>/<session id>.jsonl`.
// `claude --resume <id>` looks for the conversation only under the folder it runs in.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
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

/**
 * Whether Claude has a conversation saved for session `id` to resume: the `recordedPath` its hooks named, else the file
 * Claude would write for `cwd` under its config dir (`CLAUDE_CONFIG_DIR`, else `~/.claude`, `~` being `env.HOME`).
 * Claude saves a conversation only once it has had a message, so an agent that never had a turn has none.
 */
export function hasClaudeTranscript(recordedPath: string | null, id: string, cwd: string, env: NodeJS.ProcessEnv): boolean {
  if (recordedPath !== null && existsSync(recordedPath)) return true;
  const configDir = env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), '.claude');
  return existsSync(join(configDir, 'projects', claudeProjectName(cwd), `${id}.jsonl`));
}
