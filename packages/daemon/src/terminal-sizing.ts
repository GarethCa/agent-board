import type { TerminalSize } from './protocol.ts';

/**
 * What one client has done to a session's terminal: the size it last asked for, and when it last used the terminal
 * (typed into it, or resized it in a way that counts). A tick from the votes' own counter, not a clock.
 */
interface Vote {
  size?: TerminalSize;
  usedAt?: number;
}

/**
 * Who sets the size of a terminal several clients view. A PTY has one size, and the client that used it last sets it,
 * as tmux's `window-size latest` does: using it is typing into it, or a resize that counts. A local window's resize
 * always counts; some clients' count only once they have typed into the session, so one that opens a terminal only to
 * look never reflows it. When the last user leaves, the one before it takes over at the size it last asked for.
 */
export interface SizeVotes<Client> {
  /** `client` asked for `size`. It uses the terminal if `counts`, or if it has typed into it before. */
  resized(client: Client, size: TerminalSize, options: { counts: boolean }): void;
  /** `client` typed into the terminal. */
  typed(client: Client): void;
  /** `client` stopped viewing the terminal: it has no say any more. Whether it had a vote to take back. */
  left(client: Client): boolean;
  /** The size the terminal should be: the last one asked for by its most recent user, if any has asked. */
  size(): TerminalSize | undefined;
}

export function createSizeVotes<Client>(): SizeVotes<Client> {
  const votes = new Map<Client, Vote>();
  let tick = 0;
  const voteOf = (client: Client) => {
    let vote = votes.get(client);
    if (vote === undefined) votes.set(client, (vote = {}));
    return vote;
  };
  return {
    resized(client, size, { counts }) {
      const vote = voteOf(client);
      vote.size = size;
      if (counts || vote.usedAt !== undefined) vote.usedAt = ++tick;
    },
    typed(client) {
      voteOf(client).usedAt = ++tick;
    },
    left(client) {
      return votes.delete(client);
    },
    size() {
      let best: Vote | undefined;
      for (const vote of votes.values()) {
        if (vote.size === undefined || vote.usedAt === undefined) continue;
        if (best === undefined || vote.usedAt > best.usedAt!) best = vote;
      }
      return best?.size;
    },
  };
}
