import { systemClock, type Clock } from './clock.ts';
import { lastMessageAfterHook } from './claude-state.ts';
import { stateAfterHook } from './harness-state.ts';
import { stateWithPrompts, type HookReply, type PermissionHolds } from './permissions.ts';
import type { AgentState, Harness, SessionState, Subagent } from './protocol.ts';
import { subagentsAfterHook, type SubagentStore } from './subagents.ts';
import { draftAfterInput } from './terminal-input.ts';

/**
 * Hooks of a turn's work, which a turn interrupted mid-hook can still deliver after the interrupt. Until the next
 * prompt they are stale: none may move the agent off the `idle` the interrupt left it in.
 */
const TURN_WORK_HOOKS = new Set(['PreToolUse', 'PostToolUse', 'PermissionRequest', 'SubagentStart', 'SubagentStop', 'PreCompact', 'PostCompact']);

/** Whether `payload` is a hook from an interrupted turn's work, landing after the interrupt. */
function isStaleAfterInterrupt(payload: Record<string, unknown>): boolean {
  const event = payload.hook_event_name;
  if (event === 'Notification') return payload.notification_type === 'permission_prompt';
  return typeof event === 'string' && TURN_WORK_HOOKS.has(event);
}

/** How long output may go unaccompanied by a hook before an agent stops `starting`: hooks are late, not lost, up to here. */
const STARTING_OUTPUT_GRACE_MS = 5_000;

/** The longest an agent shows `starting`, hook or not. */
const STARTING_MAX_MS = 60_000;

/** What turning hooks into an agent's state reads of its row. */
export interface HookStateRow {
  session_id: string;
  harness: Harness;
  state: SessionState;
  description: string;
  ended_at: string | null;
}

interface HookStateOptions<Row extends HookStateRow> {
  permissions: Pick<PermissionHolds, 'prompts' | 'afterHook' | 'hold'>;
  subagents: Pick<SubagentStore, 'of'>;
  /** Records the agent's new state and subagents and tells every client; unless `always`, only if either changed. */
  save(row: Row, state: SessionState, next: readonly Subagent[], always: boolean): void;
  /** Marks the agent's state as not yet seen: a new ask. */
  unsee(sessionId: string): void;
  clock?: Clock;
  /** The agent left `starting` without a hook: its output came, or it gave up waiting. */
  startingEnded(sessionId: string): void;
  /** The agent's own turn ended with `finalMessage`. */
  /** Keeps the final message of the agent's own turn that just ended, before the state that says so is saved. */
  recordFinal(sessionId: string, finalMessage: string): void;
  /** The agent's own turn ended with `finalMessage`, saved and announced: hands it off. */
  finished(sessionId: string, finalMessage: string): void;
}

/**
 * How the hooks of a live agent's harness become its state (ADR-0004), with what they leave behind between turns: what
 * it last said, whether it sits at its prompt or was interrupted, whether you are typing at it, and whether its last
 * permission prompt was settled.
 */
export function createHookStates<Row extends HookStateRow>(options: HookStateOptions<Row>) {
  const { permissions, subagents, save } = options;
  /**
   * Agents whose `waiting` came from Claude's `idle_prompt` after their turn ended: they sit at their prompt, not on a
   * question. A scheduled agent like that is waiting for its next run, not for you.
   */
  const idlePrompted = new Set<string>();
  /** What each agent last said to the user (`lastMessageAfterHook`). */
  const lastMessages = new Map<string, string>();
  /** Agents interrupted since their last prompt: hooks still landing from that turn's work are ignored. */
  const interrupted = new Set<string>();
  /**
   * Agents whose latest turn was interrupted, until their next prompt: it ended on no message, so the last one kept is of a
   * turn before it. That stays kept for hand-offs; only what is shown of the agent leaves it out (`endedOnNoMessage`).
   */
  const noMessage = new Set<string>();
  /** Agents with a draft the user typed at their prompt (`draftAfterInput`) and hasn't submitted. */
  const drafting = new Set<string>();
  /**
   * Agents whose latest permission request has been settled (answered in the terminal or the turn moved on): a
   * `permission_prompt` notification then is the late echo of that prompt, not a new one.
   */
  const permissionSettled = new Set<string>();
  const clock = options.clock ?? systemClock;
  /**
   * Agents started with a first prompt, whose session has sent no hook yet: their first turn hasn't begun. Each leaves
   * on its first hook, or without one: on output once `STARTING_OUTPUT_GRACE_MS` have passed (the session is up and
   * drawing but its hooks aren't arriving), or after `STARTING_MAX_MS` whatever happens, so it never sticks.
   */
  const starting = new Map<string, { since: number; cancel: () => void }>();
  const stopStarting = (sessionId: string): boolean => {
    const entry = starting.get(sessionId);
    if (entry === undefined) return false;
    entry.cancel();
    starting.delete(sessionId);
    return true;
  };
  const giveUpStarting = (sessionId: string) => {
    if (stopStarting(sessionId)) options.startingEnded(sessionId);
  };

  /**
   * Whether the agent's last message asks the user something: its last paragraph has a question mark. A turn that ends
   * on a question leaves Claude only `idle_prompt`, as a turn that ends on an answer does.
   */
  const asking = (sessionId: string) => {
    const message = lastMessages.get(sessionId);
    return message !== undefined && message.trim().split(/\n\s*\n/).at(-1)!.includes('?');
  };

  /**
   * Whether the agent sits at its prompt between turns, ready for its next message and, unless `evenAsking`, not asking
   * you anything.
   */
  const atPrompt = (row: Row, evenAsking = false) =>
    row.ended_at === null &&
    permissions.prompts(row.session_id).length === 0 &&
    (evenAsking || !asking(row.session_id)) &&
    (row.state === 'idle' || (row.state === 'waiting' && idlePrompted.has(row.session_id)));

  return {
    /** The agent was started with a first prompt: it shows `starting` until its session's first hook. */
    promptQueued(sessionId: string) {
      stopStarting(sessionId);
      starting.set(sessionId, { since: clock.now(), cancel: clock.setTimer(() => giveUpStarting(sessionId), STARTING_MAX_MS) });
    },

    /** The agent's session printed something: past the grace, an agent still `starting` with no hook stops. */
    outputSeen(sessionId: string) {
      const entry = starting.get(sessionId);
      if (entry !== undefined && clock.now() - entry.since >= STARTING_OUTPUT_GRACE_MS) giveUpStarting(sessionId);
    },

    /** Whether the agent's session has yet to send its first hook, with a first prompt queued. */
    isStarting: (sessionId: string) => starting.has(sessionId),

    /** What the agent last said to the user, if anything. */
    lastMessage: (sessionId: string) => lastMessages.get(sessionId),

    /**
     * Whether only its idle prompt (Claude's `idle_prompt`, a minute after a turn) left the agent waiting, and its state
     * hasn't changed since: it asks nothing, as Claude's `agent_needs_input` would.
     */
    idlePrompted: (sessionId: string) => idlePrompted.has(sessionId),

    /**
     * The state a live agent with an enabled schedule shows: `scheduled` at its prompt, waiting for its next run, and
     * `waiting` for you, so in the needs-you inbox, when its turn ended on a question.
     */
    scheduledState(row: Row): AgentState {
      if (atPrompt(row)) return 'scheduled';
      if (row.ended_at === null && row.state === 'idle' && asking(row.session_id)) return 'waiting';
      return row.state;
    },

    /**
     * Why a scheduled run can't start in the live agent now, or undefined if it can. With `evenAsking`, as for a hand-off,
     * a last message asking you something doesn't stop it: what's typed is the agent's next input either way.
     */
    whyNotReady(row: Row, evenAsking = false): string | undefined {
      const sessionId = row.session_id;
      const askingYou = !evenAsking && asking(sessionId);
      if (row.state === 'rate-limited') return 'it was rate-limited';
      // A failed turn leaves the agent at its prompt.
      if (!atPrompt(row, evenAsking) && !(row.state === 'failed' && permissions.prompts(sessionId).length === 0)) {
        const waiting =
          row.state === 'waiting' || row.state === 'needs-permission' || permissions.prompts(sessionId).length > 0 || askingYou;
        return waiting ? 'it was waiting for you' : 'it was still working';
      }
      if (askingYou) return 'it was waiting for you';
      if (drafting.has(sessionId)) return 'you were typing in its terminal';
      return undefined;
    },

    /**
     * Moves the live agent `row` on by one of its hooks, and hands off its final message when its own turn ends.
     * Returns the hook's reply: a held PermissionRequest's.
     */
    onHook(row: Row, payload: Record<string, unknown>, signal: AbortSignal): Promise<HookReply> | undefined {
      const sessionId = row.session_id;
      const prompted = stopStarting(sessionId);
      if (payload.hook_event_name === 'UserPromptSubmit') {
        interrupted.delete(sessionId);
        noMessage.delete(sessionId);
        drafting.delete(sessionId);
      } else if (interrupted.has(sessionId) && isStaleAfterInterrupt(payload)) return undefined;
      const settled = permissions.afterHook(sessionId, payload);
      const reply = payload.hook_event_name === 'PermissionRequest' ? permissions.hold(sessionId, payload, signal) : undefined;
      if (payload.hook_event_name === 'PermissionRequest') {
        permissionSettled.delete(sessionId);
        // Another prompt is a new ask, even when the state was already needs-permission.
        options.unsee(sessionId);
      } else if (settled) permissionSettled.add(sessionId);
      // A permission notification landing after its prompt was settled would put the agent back to needs-permission with
      // nothing to answer, until some later hook.
      // The cost: if a later prompt's PermissionRequest never reaches the daemon (a failed hook), its notification is
      // dropped too, and the agent shows its hooks' state until the next hook.
      if (
        payload.hook_event_name === 'Notification' &&
        payload.notification_type === 'permission_prompt' &&
        permissionSettled.has(sessionId) &&
        permissions.prompts(sessionId).length === 0
      ) {
        return undefined;
      }
      const previousMessage = lastMessages.get(sessionId) ?? null;
      const lastMessage = lastMessageAfterHook(previousMessage, payload);
      if (lastMessage === null) lastMessages.delete(sessionId);
      else lastMessages.set(sessionId, lastMessage);
      const next = subagentsAfterHook(subagents.of(sessionId), payload, new Date());
      const pending = permissions.prompts(sessionId).length;
      // An agent started with no task has nothing to run yet: its session starting leaves it idle for its first message.
      const awaitingTask = payload.hook_event_name === 'SessionStart' && row.state === 'idle' && row.description === '' && !prompted;
      const state = stateWithPrompts(awaitingTask ? 'idle' : stateAfterHook(row.harness, row.state, payload), { pending, settled });
      const idlePrompt = payload.hook_event_name === 'Notification' && payload.notification_type === 'idle_prompt';
      if (idlePrompt && row.state === 'idle' && state === 'waiting') idlePrompted.add(sessionId);
      else if (state !== row.state) idlePrompted.delete(sessionId);
      // Its own turn ended with a final message (a subagent's Stop is SubagentStop): it is kept before the state is saved,
      // so what that announces already carries it, and hands it off.
      const finalMessage = payload.last_assistant_message;
      const ended = payload.hook_event_name === 'Stop' && payload.agent_id === undefined && typeof finalMessage === 'string';
      if (ended) options.recordFinal(sessionId, finalMessage);
      save(row, state, next, ended || settled || reply !== undefined || lastMessage !== previousMessage);
      if (ended) options.finished(sessionId, finalMessage);
      return reply;
    },

    /** Notes what the user typed at the agent's prompt: a draft, until it is submitted or cleared. */
    typed(sessionId: string, data: string) {
      if (draftAfterInput(drafting.has(sessionId), data)) drafting.add(sessionId);
      else drafting.delete(sessionId);
    },

    /** The agent's turn was interrupted: hooks still landing from its work are stale until its next prompt. */
    interrupted(sessionId: string) {
      interrupted.add(sessionId);
      noMessage.add(sessionId);
    },

    /** Whether the agent's latest turn was interrupted, so the final message kept is of an earlier turn. */
    endedOnNoMessage: (sessionId: string) => noMessage.has(sessionId),

    /** The agent's permission prompt was decided on the board. */
    permissionDecided(sessionId: string) {
      permissionSettled.add(sessionId);
    },

    /** The agent was relaunched: what it last said and any draft at its old prompt are gone. */
    relaunched(sessionId: string) {
      lastMessages.delete(sessionId);
      drafting.delete(sessionId);
    },

    /** The agent's process exited. Its tile still shows what it last said. */
    ended(sessionId: string) {
      stopStarting(sessionId);
      permissionSettled.delete(sessionId);
      interrupted.delete(sessionId);
      idlePrompted.delete(sessionId);
      drafting.delete(sessionId);
    },

    /** The agent was deleted. */
    deleted(sessionId: string) {
      stopStarting(sessionId);
      noMessage.delete(sessionId);
      idlePrompted.delete(sessionId);
      drafting.delete(sessionId);
      lastMessages.delete(sessionId);
    },
  };
}
