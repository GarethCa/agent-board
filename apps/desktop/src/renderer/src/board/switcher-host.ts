// Whose session window a pull request, page or session picked in ⌘K on the board opens in, with nothing open yet.
// Pure, so it is unit-tested.
import { pullRequestKey, pullRequestOfUrl, type Agent } from '@agent-board/daemon/protocol';
import type { Surface } from '@agent-board/daemon/window-layout';
import type { ReviewedPullRequest } from '../review/reviews';

/** What the board knows when a pick lands on it. */
export interface SwitcherBoard {
  agents: readonly Agent[];
  /** The agent selected, by its session, if one alone is. */
  selected: string | undefined;
  /** Whether it was picked to open beside (⇧↵). */
  beside: boolean;
  /** What each reviewer reviews, by its session. */
  reviewed: ReadonlyMap<string, ReviewedPullRequest>;
}

/**
 * The agent whose window the pick opens in, and what opens there:
 * - a reviewer opened beside (⇧↵), in its own window with the pull request it reviews beside it;
 * - else, opened beside, in the window of the agent selected;
 * - else a pull request, in the window of the agent whose it is, and a document or hand-off doc in its agent's window.
 *
 * Undefined for none: a page opened alone, or with nothing to be beside, opens in a window of its own.
 */
export function switcherPick(surface: Surface, { agents, selected, beside, reviewed }: SwitcherBoard): { host: Agent; surface: Surface } | undefined {
  if (beside) {
    const picked = surface.kind === 'session' && surface.target.kind === 'agent' ? surface.target.id : undefined;
    const reviews = picked === undefined ? undefined : reviewed.get(picked);
    const reviewer = agents.find((agent) => agent.sessionId === picked);
    if (reviews !== undefined && reviewer !== undefined) return { host: reviewer, surface: reviews.surface };
    const host = picked === selected ? undefined : agents.find((agent) => agent.sessionId === selected);
    if (host !== undefined) return { host, surface };
  }
  if (surface.kind === 'document' || surface.kind === 'doc') {
    const owner = agents.find((agent) => agent.sessionId === surface.sessionId);
    if (owner !== undefined) return { host: owner, surface };
  }
  if (surface.kind === 'pr') {
    const key = pullRequestKey(surface);
    const owner = agents.find((agent) =>
      [...agent.pullRequests, ...agent.pushedPullRequests].some((each) => {
        const ref = pullRequestOfUrl(each.url);
        return ref !== undefined && pullRequestKey(ref) === key;
      }),
    );
    if (owner !== undefined) return { host: owner, surface };
  }
  return undefined;
}

/** What a pick on the board opens: its host's window with the pick asked of it, a tab window of its own, or nothing. */
export type BoardOpening = { opens: 'window'; host: Agent; surface: Surface } | { opens: 'tab-window' } | { opens: 'nothing' };

/**
 * What a pick on the board opens. A host whose window is popped out runs in another renderer, which can't hear the tab
 * asked for, so the pick opens as if there were no host: a pull request or page in a tab window of its own, and a
 * session left to the board.
 */
export function boardOpening(surface: Surface, board: SwitcherBoard, poppedOut: (sessionId: string) => boolean): BoardOpening {
  const pick = switcherPick(surface, board);
  if (pick !== undefined && !poppedOut(pick.host.sessionId)) return { opens: 'window', ...pick };
  return surface.kind === 'session' ? { opens: 'nothing' } : { opens: 'tab-window' };
}
