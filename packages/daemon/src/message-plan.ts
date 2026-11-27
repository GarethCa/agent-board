/**
 * What becomes of a message sent to an agent, decided in one place for every way one is sent: the composer and an
 * orchestrator's `send` (through `answer`), a hand-off (`deliver`), a board notice (`tell`) and a scheduled run. Each
 * says what it knows of the agent (`MessageTarget`) and goes by its own rules (`MESSAGE_RULES`); the plan is the same
 * for the same agent and rules, whichever path asks. What the user is typing at the agent's prompt holds a message back
 * on its own path, after the plan says now: `send` keeps it until they stop, and a run fired just after a key waits for
 * that quiet.
 */

/** Where the agent stands as a message is sent to it, as its sender's path reads it. */
export interface MessageTarget {
  name: string;
  /** Its session has ended (a paused agent's too). */
  ended: boolean;
  /** It is paused: anything sent to it wakes it in its conversation, as its first message. */
  paused: boolean;
  /** Why nothing may be typed at its prompt now, for a reason this path never waits out (a permission prompt, a question), if so. */
  blocked?: string | undefined;
  /** Why its session isn't up yet, if it isn't. */
  notUp?: string | undefined;
  /** Why it can't take a message typed now, for a reason that passes by itself (mid-turn, being typed to), if so. */
  busy?: string | undefined;
}

/** How one way of sending treats an agent that can't take its message at its prompt now. */
export interface MessageRules {
  /** A paused agent is woken with it, in its conversation; else it is refused as busy, for its sender to keep. */
  pausedWakes: boolean;
  /** An ended agent, not paused, is started again with it (a hand-off, a scheduled run); else it is refused. */
  endedWakes: boolean;
  /** One whose session isn't up yet keeps it until it is; else it is refused as busy. */
  queuesUntilUp: boolean;
  /**
   * What a busy agent does with it: refused as busy (its sender tries again, or records it skipped), kept until its turn
   * ends, or typed now, for its harness to queue for after the turn.
   */
  whenBusy: 'refuse' | 'after-turn' | 'now';
}

export const MESSAGE_RULES = {
  /** An orchestrator's `send`: kept until a busy agent's turn ends. One not up yet is kept by `answer`, which it goes through. */
  send: { pausedWakes: true, endedWakes: false, queuesUntilUp: true, whenBusy: 'after-turn' },
  /**
   * A message typed as the next input (the composer's, and `send`'s once it is the agent's turn): typed even mid-turn,
   * for its harness to queue, so it names nothing busy.
   */
  answer: { pausedWakes: true, endedWakes: false, queuesUntilUp: true, whenBusy: 'now' },
  /** A hand-off along an edge: its edge keeps it, or skips it, while the agent is busy. */
  deliver: { pausedWakes: true, endedWakes: true, queuesUntilUp: false, whenBusy: 'refuse' },
  /**
   * What the board itself tells an agent (a crew flag, a document's news): its caller tries again later. A paused agent
   * is never woken by the board's own news, only by what the user, an agent or a clock sends it.
   */
  tell: { pausedWakes: false, endedWakes: false, queuesUntilUp: false, whenBusy: 'refuse' },
  /** A clock's scheduled run. */
  scheduled: { pausedWakes: true, endedWakes: true, queuesUntilUp: true, whenBusy: 'refuse' },
} as const satisfies Record<string, MessageRules>;

/** One plan for a message: typed now, kept until the agent's turn ends or its session is up, waking it with it, or refused. */
export type MessagePlan =
  | { do: 'now' }
  | { do: 'after-turn' }
  | { do: 'until-up' }
  | { do: 'wake' }
  | { do: 'refuse'; reason: string; busy: boolean };

/**
 * The plan for a message to `target` under `rules`. A paused agent is woken with it where `pausedWakes` (all but the
 * board's own notices); an ended one is started again only where `endedWakes`. Then what stands in its way, in order:
 * what only the user can clear, a session not up yet, and a busy agent.
 */
export function planMessage(target: MessageTarget, rules: MessageRules): MessagePlan {
  if (target.paused) return rules.pausedWakes ? { do: 'wake' } : { do: 'refuse', reason: 'it is paused', busy: true };
  if (target.ended) return rules.endedWakes ? { do: 'wake' } : { do: 'refuse', reason: `${target.name} has ended`, busy: false };
  if (target.blocked !== undefined) return { do: 'refuse', reason: target.blocked, busy: true };
  if (target.notUp !== undefined) return rules.queuesUntilUp ? { do: 'until-up' } : { do: 'refuse', reason: target.notUp, busy: true };
  if (target.busy !== undefined) {
    if (rules.whenBusy === 'refuse') return { do: 'refuse', reason: target.busy, busy: true };
    return rules.whenBusy === 'after-turn' ? { do: 'after-turn' } : { do: 'now' };
  }
  return { do: 'now' };
}
