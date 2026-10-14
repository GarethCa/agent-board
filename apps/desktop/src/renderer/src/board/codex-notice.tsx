// The one-time notice that Codex agents start with `--dangerously-bypass-hook-trust` (ADR-0004), remembered per app
// profile once read: the New agent dialog shows it as a step, the repo picker inline.

/** What the flag does, as both places say it. */
export function CodexBypassExplanation() {
  return (
    <>
      <p>
        agent-board follows a Codex agent through hooks it adds to that session. Codex only runs hooks you have
        reviewed, so agent-board starts Codex with <code>--dangerously-bypass-hook-trust</code>.
      </p>
      <p>
        For that session the flag also skips review of every other hook: yours, your plugins&apos; and the
        repo&apos;s. Hooks run outside Codex&apos;s sandbox. When an agent&apos;s worktree has a <code>.codex</code> of
        its own, agent-board asks you first and starts Codex without the flag; if one appears while the agent runs,
        agent-board stops the agent.
      </p>
    </>
  );
}

/** Remembers, per app profile, that the user has read the bypass-flag notice. */
const BYPASS_NOTICE_SEEN = 'agent-board.codexBypassNoticeSeen';

export function bypassNoticeSeen(): boolean {
  try {
    return localStorage.getItem(BYPASS_NOTICE_SEEN) === '1';
  } catch {
    return false;
  }
}

export function markBypassNoticeSeen(): void {
  try {
    localStorage.setItem(BYPASS_NOTICE_SEEN, '1');
  } catch {
    // Not remembered: the notice shows again next time.
  }
}
