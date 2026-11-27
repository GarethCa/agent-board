/**
 * Closing or deleting an agent, one way wherever it is asked for: the app's Delete, an agent's close or remove, a
 * crew's close, the merge gate's cleanup. A ticket's chat goes after its helpers (each with its own reviewers), then
 * its reviewers, then the chat itself. Unsaved work is judged by one rule, `unsavedOf`, before any agent goes.
 */
import { AGENT_ERROR, type Agent, type ClosedKept } from './protocol.ts';
import { RpcMethodError } from './rpc.ts';
import { helpersOf } from './ticket-tiles.ts';
import { unsavedWork } from './worktrees.ts';

/** How a close or delete goes. */
export interface CloseHow {
  /** Why, for the log and the session's end. */
  why: string;
  /**
   * A close: its helpers and reviewers are checked as they run (a refusal leaves them running), then every agent it
   * checks is ended and checked, so nothing written as it stops is lost; a refusal then leaves them ended. Without, a
   * delete: each is checked as it runs, and again just before it is killed, and a refusal stops nothing.
   */
  ends?: boolean;
  /**
   * What unsaved work in the agent's own worktree does: refuse the close before any agent goes; keep its worktree and
   * branch as the agent goes, which the close then returns (the agent is ended first, with `ends` or without); or go
   * with them, unchecked.
   */
  unsaved: 'refuse' | 'keep' | 'lose';
  /** Its own worktree and branch, kept whatever they hold: the app's Delete that keeps the worktree, or the merge gate's call. */
  keep?: { worktree: boolean; branch: boolean };
  /**
   * How a ticket's helpers go: refused by their unsaved work, as by default, or as the chat goes, which the user's own
   * forced Delete, or Delete that keeps the worktree, asks.
   */
  helpers?: 'refuse' | 'as-agent';
  /** Its reviewers' unsaved work refuses it too. Else they go, work and all, as their reviews are kept. */
  checkReviewers?: boolean;
}

/** A close refused by unsaved work: which agent holds it, and why. */
export class UnsavedWorkError extends RpcMethodError {
  readonly sessionId: string;

  constructor(agent: Pick<Agent, 'sessionId' | 'name'>, reason: string) {
    super(AGENT_ERROR.unsavedWork, `${agent.name}: ${reason}`, reason);
    this.sessionId = agent.sessionId;
  }
}

/**
 * The one rule: what removing `agent`'s worktree and branch would lose, if anything. The board's own files (a handover,
 * a review) lose nothing. Asked only of an agent that owns its worktree: one adopted in the user's folder takes nothing.
 */
const unsavedOf = (agent: Agent): Promise<string | undefined> => unsavedWork(agent.repoRoot, agent.worktree, agent.ownedBranch, { ignoreBoardFiles: true });

export interface AgentCloserDeps {
  agents: {
    get(sessionId: string): Agent | undefined;
    list(): Agent[];
    stop(sessionId: string, why: string): Promise<unknown>;
    delete(sessionId: string, why: string, force: boolean, keepWorktree?: boolean, keepBranch?: boolean): Promise<unknown>;
  };
  reviews: {
    /** The live reviewers of `sessionId`'s rounds. */
    reviewersOf(sessionId: string): string[];
    /** Deletes `sessionId`'s reviewers, forced, then `remove`s it. */
    deleteAgent(sessionId: string, why: string, remove: () => Promise<null>): Promise<null>;
  };
  /** `unsavedOf` but in tests. */
  unsaved?: (agent: Agent) => Promise<string | undefined>;
  log(line: string): void;
}

export interface AgentCloser {
  /** Closes or deletes `sessionId` as `how` says, or refuses before any agent goes. What a `keep` close kept, else null. */
  closeAgent(sessionId: string, how: CloseHow): Promise<ClosedKept | null>;
}

export function createAgentCloser(deps: AgentCloserDeps): AgentCloser {
  const { agents, reviews, log } = deps;
  const unsavedOfAny = deps.unsaved ?? unsavedOf;
  const unsaved = async (agent: Agent) => (agent.ownsWorktree ? unsavedOfAny(agent) : undefined);
  /** Whether `how` lets unsaved work refuse it: a worktree kept loses nothing. */
  const refuses = (how: CloseHow) => how.unsaved === 'refuse' && how.keep?.worktree !== true;

  /** Refuses with the first of `checked` that holds unsaved work. */
  const refuse = async (checked: Agent[]) => {
    for (const { sessionId } of checked) {
      const agent = agents.get(sessionId);
      if (agent === undefined) continue;
      const reason = await unsaved(agent);
      if (reason !== undefined) throw new UnsavedWorkError(agent, reason);
    }
  };

  const end = async (sessionId: string, why: string) => {
    if (agents.get(sessionId)?.endedAt === null) await agents.stop(sessionId, why);
  };

  /** Removes one agent, after its reviewers, as `how` says; what it kept, with a `keep` close. */
  const remove = async (sessionId: string, how: CloseHow): Promise<ClosedKept | null> => {
    let kept: ClosedKept | null = null;
    let keep = { worktree: how.keep?.worktree === true, branch: how.keep?.branch === true };
    const agent = agents.get(sessionId);
    if (how.unsaved === 'keep' && agent !== undefined && !keep.worktree) {
      await end(sessionId, how.why);
      const reason = await unsaved(agents.get(sessionId) ?? agent);
      if (reason !== undefined) {
        keep = { worktree: true, branch: true };
        log(`kept ${agent.name}'s worktree ${agent.worktree} and branch ${agent.ownedBranch} at its close: ${reason}`);
        kept = { worktree: agent.worktree, branch: agent.ownedBranch, why: reason };
      }
    }
    // A delete looks once more just before the kill: helpers and reviewers went since its first look.
    if (how.ends !== true && refuses(how) && agent !== undefined) {
      const reviewers = how.checkReviewers === true ? reviews.reviewersOf(sessionId).flatMap((id) => agents.get(id) ?? []) : [];
      await refuse([...reviewers, agent]);
    }
    // Checked by this close's own rule: never again by another.
    await reviews.deleteAgent(sessionId, how.why, () => agents.delete(sessionId, how.why, true, keep.worktree, keep.branch).then(() => null));
    return kept;
  };

  return {
    async closeAgent(sessionId, how) {
      const agent = agents.get(sessionId);
      const helperHow: CloseHow =
        how.helpers === 'as-agent'
          ? how
          : { why: how.why, ...(how.ends === true ? { ends: true } : {}), ...(how.checkReviewers === true ? { checkReviewers: true } : {}), unsaved: 'refuse' };
      // Its own reviewers go as reviewers, after the helpers.
      const helpers = agent === undefined ? [] : helpersOf(agents.list(), sessionId).filter((helper) => helper.reviewOf !== sessionId);
      const reviewers =
        how.checkReviewers === true
          ? [sessionId, ...helpers.map((helper) => helper.sessionId)].flatMap((id) => reviews.reviewersOf(id)).flatMap((id) => agents.get(id) ?? [])
          : [];
      const checked = [...(refuses(helperHow) ? helpers : []), ...reviewers, ...(agent !== undefined && refuses(how) ? [agent] : [])];
      // A close ends the agent itself before its one look, as it is closing it anyway.
      await refuse(how.ends === true ? checked.filter((each) => each !== agent) : checked);
      if (how.ends === true && checked.length > 0) {
        for (const each of checked) await end(each.sessionId, how.why);
        await refuse(checked);
      }
      for (const helper of helpers) if (agents.get(helper.sessionId) !== undefined) await remove(helper.sessionId, helperHow);
      return remove(sessionId, how);
    },
  };
}
