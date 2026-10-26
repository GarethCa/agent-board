import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { PullRequest } from '@agent-board/tracker';
import { runGit } from './git.ts';
import { dimensionParam, invalidParams, paramsObject, stringParam } from './params.ts';
import {
  MAX_NAME_LENGTH,
  MAX_REVIEW_CAP,
  type Agent,
  type DaemonEvent,
  type DaemonMethods,
  type ReviewRound,
  type ReviewRoundStatus,
  type TerminalSize,
} from './protocol.ts';
import { mergeBlocked, reviewPrompt, startBlocked } from './review-doc.ts';
import type { AgentHost } from './agents.ts';
import type { RpcHandlers } from './rpc.ts';

type ReviewMethods = Pick<DaemonMethods, Extract<keyof DaemonMethods, `review.${string}`>>;

/** The terminal a reviewer starts in when the client gives no size, until one attaches and sizes it. */
const REVIEWER_SIZE: TerminalSize = { cols: 120, rows: 40 };

export interface ReviewHostOptions {
  db: DatabaseSync;
  agents: Pick<AgentHost, 'get' | 'spawnReviewer' | 'stop' | 'delete' | 'deliver' | 'finalMessage' | 'announce'>;
  /** The implementer's pull requests, as last seen. */
  pullRequests(sessionId: string): readonly PullRequest[];
  /** Looks at the implementer's pull requests again, so their checks are up to date. */
  refreshPullRequests(sessionId: string): Promise<void>;
  /**
   * Squash-merges pull request `number` of the implementer's branch while its head is still commit `head`, then looks
   * at its pull requests again.
   */
  merge(sessionId: string, number: number, head: string): Promise<void>;
  broadcast(event: DaemonEvent): void;
  log(message: string): void;
}

export interface ReviewHost {
  /** Hears an agent's turn end with a final message: a reviewer's is its doc, and it is stopped. */
  onHandoff(sessionId: string): void;
  /**
   * Hears an agent's session end: a reviewer's with no doc fails its round, unless it will carry on (`resumable`: a
   * restart stopped it, or it was paused).
   */
  onExit(sessionId: string, resumable: boolean): void;
  /**
   * Deletes an agent with `remove`: first the reviewers of its rounds, telling every client, as `remove` would not; and
   * after it, tells them of the rounds it reviewed, which no longer have their reviewer.
   */
  deleteAgent(sessionId: string, why: string, remove: () => Promise<null>): Promise<null>;
  handlers<Context>(): RpcHandlers<ReviewMethods, Context>;
}

interface RoundRow {
  id: string;
  implementer_session_id: string;
  round: number;
  reviewer_session_id: string | null;
  head: string | null;
  doc: string | null;
  failed_because: string | null;
  created_at: string;
  finished_at: string | null;
  sent_at: string | null;
  dismissed_at: string | null;
}

function toRound(row: RoundRow): ReviewRound {
  const status: ReviewRoundStatus = row.doc !== null ? 'ready' : row.failed_because !== null ? 'failed' : 'reviewing';
  return {
    id: row.id,
    implementer: row.implementer_session_id,
    round: row.round,
    reviewer: row.reviewer_session_id,
    head: row.head,
    status,
    doc: row.doc,
    failedBecause: row.failed_because,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
    sentAt: row.sent_at,
    dismissedAt: row.dismissed_at,
  };
}

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

/** A reviewer's tile name, its implementer's cut short so the whole fits `MAX_NAME_LENGTH`. */
function reviewerName(implementer: string, round: number): string {
  const suffix = ` · review r${round}`;
  return `${implementer.slice(0, MAX_NAME_LENGTH - suffix.length).trimEnd()}${suffix}`;
}

/**
 * Review rounds, backed by `review_rounds`: each spawns an ephemeral reviewer of an implementer's work, keeps
 * the doc it leaves as its final message, stops it, and sends the doc back when the user says. Every change is
 * broadcast to every client.
 */
export function createReviewHost(options: ReviewHostOptions): ReviewHost {
  const { db, agents } = options;
  const selectAll = db.prepare('SELECT * FROM review_rounds ORDER BY implementer_session_id, round');
  const selectOne = db.prepare('SELECT * FROM review_rounds WHERE id = ?');
  const selectOf = db.prepare('SELECT * FROM review_rounds WHERE implementer_session_id = ? ORDER BY round');
  const selectByReviewer = db.prepare('SELECT * FROM review_rounds WHERE reviewer_session_id = ?');
  const insert = db.prepare('INSERT INTO review_rounds (id, implementer_session_id, round) VALUES (?, ?, ?)');
  const setReviewer = db.prepare('UPDATE review_rounds SET reviewer_session_id = ?, head = ? WHERE id = ?');
  const setDoc = db.prepare(`UPDATE review_rounds SET doc = ?, finished_at = ${NOW} WHERE id = ? AND doc IS NULL AND failed_because IS NULL`);
  const setFailed = db.prepare(`UPDATE review_rounds SET failed_because = ?, finished_at = ${NOW} WHERE id = ? AND doc IS NULL AND failed_because IS NULL`);
  const setSent = db.prepare(`UPDATE review_rounds SET sent_at = ${NOW} WHERE id = ?`);
  const setDismissed = db.prepare(`UPDATE review_rounds SET dismissed_at = ${NOW}, reviewer_session_id = NULL WHERE id = ?`);
  const remove = db.prepare('DELETE FROM review_rounds WHERE id = ?');
  const updateCap = db.prepare('UPDATE agents SET review_cap = ? WHERE session_id = ?');
  const selectBaseCommit = db.prepare('SELECT base_commit FROM agents WHERE session_id = ?');

  const find = (id: string) => selectOne.get(id) as RoundRow | undefined;
  const get = (id: string): ReviewRound => {
    const row = find(id);
    if (row === undefined) throw invalidParams(`no review round ${id}`);
    return toRound(row);
  };
  const roundsOf = (sessionId: string) => (selectOf.all(sessionId) as unknown as RoundRow[]).map(toRound);
  const announce = (id: string): ReviewRound => {
    const round = get(id);
    options.broadcast({ type: 'review.updated', round });
    return round;
  };
  const requireAgent = (sessionId: string): Agent => {
    const agent = agents.get(sessionId);
    if (agent === undefined) throw invalidParams(`no agent ${sessionId}`);
    return agent;
  };
  const reviewing = (sessionId: string) =>
    (selectByReviewer.all(sessionId) as unknown as RoundRow[]).find((row) => toRound(row).status === 'reviewing');

  /**
   * What the implementer's work is compared with: the commit it started from, or the empty tree for a branch begun in a
   * repo with no commits (`wholeBranch`). For an agent from before that was kept, its repo's checked-out branch, or else
   * the commit its repo's checkout is at; never `HEAD`, which in the reviewer's worktree is the work itself.
   */
  const baseOf = async (implementer: Agent): Promise<{ base: string; wholeBranch: boolean }> => {
    const { base_commit: kept } = selectBaseCommit.get(implementer.sessionId) as { base_commit: string | null };
    if (kept !== null) {
      const kind = await runGit(implementer.repoRoot, ['cat-file', '-t', kept]);
      return { base: kept, wholeBranch: kind.ok && kind.stdout === 'tree' };
    }
    // A checked-out branch with no commit yet names nothing to compare with.
    const branch = await runGit(implementer.repoRoot, ['branch', '--show-current']);
    const born = branch.ok && branch.stdout !== '' && (await runGit(implementer.repoRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch.stdout}^{commit}`])).ok;
    if (born) return { base: branch.stdout, wholeBranch: false };
    const commit = await runGit(implementer.repoRoot, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
    if (!commit.ok) throw invalidParams(`can't tell what ${implementer.name}'s work started from: ${implementer.repoRoot} has no commits yet`);
    return { base: commit.stdout, wholeBranch: false };
  };

  /** Deletes the reviewers of the implementer's rounds that are still on the board, then tells of those rounds. */
  const deleteReviewers = async (rounds: readonly ReviewRound[]) => {
    for (const round of rounds) {
      if (round.reviewer === null || agents.get(round.reviewer) === undefined) continue;
      await agents.delete(round.reviewer, 'a new review round', true);
      announce(round.id);
    }
  };

  const start = async (sessionId: string, size: TerminalSize): Promise<ReviewRound> => {
    const implementer = requireAgent(sessionId);
    if (implementer.reviewOf !== null) throw invalidParams(`${implementer.name} is a reviewer: review the agent it reviews`);
    // An external session resumed outside git, or on a detached HEAD.
    if (implementer.branch === '') throw invalidParams(`${implementer.name} has no branch to review: it works outside git, or on a detached HEAD`);
    const rounds = roundsOf(sessionId);
    const blocked = startBlocked(implementer, rounds);
    if (blocked !== undefined) throw invalidParams(blocked);
    const number = (rounds.at(-1)?.round ?? 0) + 1;
    // Its number is taken before anything is awaited, so two starts never share one.
    const id = randomUUID();
    insert.run(id, sessionId, number);
    try {
      const previous = rounds.findLast((round) => round.doc !== null)?.doc ?? undefined;
      const prompt = reviewPrompt({ round: number, implementer: implementer.name, branch: implementer.branch, ...(await baseOf(implementer)), previous });
      const reviewer = await agents.spawnReviewer({
        of: sessionId,
        name: reviewerName(implementer.name, number),
        branch: `${implementer.branch}-review-r${number}`,
        prompt,
        ...size,
      });
      // Its worktree started at the implementer's tip: that commit is what it reviews, and all a merge may take.
      const head = await runGit(reviewer.worktree, ['rev-parse', 'HEAD']);
      setReviewer.run(reviewer.sessionId, head.ok ? head.stdout : null, id);
    } catch (error) {
      remove.run(id);
      throw error;
    }
    options.log(`started review round ${number} of ${sessionId}`);
    const started = announce(id);
    // The earlier rounds' reviewers are done with, and their docs kept: they and their worktrees go.
    await deleteReviewers(rounds).catch((error: Error) => options.log(`could not delete earlier reviewers of ${sessionId}: ${error.message}`));
    return started;
  };

  return {
    onHandoff(sessionId) {
      const row = reviewing(sessionId);
      const doc = agents.finalMessage(sessionId);
      if (row === undefined || doc === undefined || doc.trim() === '') return;
      setDoc.run(doc, row.id);
      announce(row.id);
      // Ephemeral: its doc is in, so it is done.
      agents.stop(sessionId, 'its review being in').catch((error: Error) => options.log(`could not stop reviewer ${sessionId}: ${error.message}`));
    },

    onExit(sessionId, resumable) {
      const row = reviewing(sessionId);
      if (row === undefined || resumable) return;
      setFailed.run('the reviewer ended before it left its review', row.id);
      announce(row.id);
    },

    async deleteAgent(sessionId, why, removeAgent) {
      for (const round of roundsOf(sessionId)) {
        if (round.reviewer !== null && agents.get(round.reviewer) !== undefined) {
          await agents.delete(round.reviewer, `its implementer's delete for ${why}`, true);
        }
      }
      const reviewed = (selectByReviewer.all(sessionId) as unknown as RoundRow[]).map((row) => row.id);
      const removed = await removeAgent();
      for (const id of reviewed) {
        // A reviewer stopped by a restart has no exit to come: its round would stay under review for good.
        setFailed.run('its reviewer was deleted before it left a review', id);
        announce(id);
      }
      return removed;
    },

    handlers: () => ({
      'review.list': () => (selectAll.all() as unknown as RoundRow[]).map(toRound),

      'review.start': (params) => {
        const fields = paramsObject(params);
        const size = fields.cols === undefined && fields.rows === undefined ? REVIEWER_SIZE : { cols: dimensionParam(fields, 'cols'), rows: dimensionParam(fields, 'rows') };
        return start(stringParam(fields, 'sessionId'), size);
      },

      'review.send': async (params) => {
        const round = get(stringParam(paramsObject(params), 'id'));
        if (round.doc === null) throw invalidParams(`round ${round.round} has no review to send`);
        const sent = await agents.deliver(round.reviewer ?? '', round.implementer, `review, round ${round.round}`, round.doc);
        if (!sent.started) throw invalidParams(`not sent: ${sent.reason}`);
        setSent.run(round.id);
        return announce(round.id);
      },

      'review.dismiss': async (params) => {
        const round = get(stringParam(paramsObject(params), 'id'));
        if (round.reviewer !== null && agents.get(round.reviewer) !== undefined) await agents.delete(round.reviewer, "the app's review.dismiss", true);
        setFailed.run('dismissed before its reviewer left a review', round.id);
        setDismissed.run(round.id);
        return announce(round.id);
      },

      'review.merge': async (params) => {
        const round = get(stringParam(paramsObject(params), 'id'));
        const implementer = requireAgent(round.implementer);
        if (round.head === null) throw invalidParams(`round ${round.round} doesn't know which commit it reviewed`);
        // Its checks as they are now, not as last seen.
        await options.refreshPullRequests(round.implementer);
        const pullRequests = options.pullRequests(round.implementer);
        const blocked = mergeBlocked({ name: implementer.name, pullRequests: [...pullRequests] }, roundsOf(round.implementer), round);
        if (blocked !== undefined) throw invalidParams(blocked);
        const pr = pullRequests.find((known) => known.state === 'open')!;
        // Only the commit the round reviewed: gh refuses if anything was pushed since.
        await options.merge(round.implementer, pr.number, round.head).catch((error: Error) => {
          throw invalidParams(`could not merge #${pr.number} at the reviewed commit ${round.head!.slice(0, 7)}: ${error.message}`);
        });
        options.log(`merged #${pr.number} of ${round.implementer} after review round ${round.round}`);
        return requireAgent(round.implementer);
      },

      'review.setCap': (params) => {
        const fields = paramsObject(params);
        const sessionId = stringParam(fields, 'sessionId');
        requireAgent(sessionId);
        const cap = fields.cap;
        if (typeof cap !== 'number' || !Number.isInteger(cap) || cap < 1 || cap > MAX_REVIEW_CAP) {
          throw invalidParams(`cap must be a whole number of rounds, 1 to ${MAX_REVIEW_CAP}`);
        }
        updateCap.run(cap, sessionId);
        agents.announce(sessionId);
        return requireAgent(sessionId);
      },
    }),
  };
}
