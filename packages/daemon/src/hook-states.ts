import { systemClock, type Clock } from './clock.ts';
import { compactingAfterHook, isOwnDialog, lastMessageAfterHook } from './claude-state.ts';
import { stateAfterHook } from './harness-state.ts';
import { onlyAPersonAllows, promptCounts, stateWithPrompts, type HookReply, type PermissionHolds } from './permissions.ts';
import { STILL_WORKING, WAITING_FOR_YOU, type AgentState, type Harness, type SessionState, type Subagent } from './protocol.ts';
import { subagentsAfterHook, type SubagentStore } from './subagents.ts';
import type { PromptNow } from './deliveries.ts';
import { type Draft, draftAfter, oneLine, pressesEscape, submitsDraft } from './terminal-input.ts';
import { cutText } from './text-words.ts';

/**
 * Hooks of a turn's work, which a turn interrupted mid-hook can still deliver after the interrupt. Until the next
 * prompt they are stale: none may move the agent off the `idle` the interrupt left it in.
 */
const TURN_WORK_HOOKS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'SubagentStart', 'SubagentStop', 'PreCompact', 'PostCompact']);

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

/**
 * How long after the user's last key a draft at an agent's prompt holds back what others send it. A draft can be one
 * the board guessed wrong (the line was edited in ways it can't follow, or cleared by something it never saw): past
 * this, what waits on it is typed.
 */
export const DRAFT_HOLD_MS = 5 * 60_000;

/**
 * How long after its turn ends a line the user sent the agent mid-turn holds back what others send it. Claude takes
 * that line up soon after its `Stop`, as a prompt of its own, and anything typed meanwhile joins it; or it took it at a
 * step of the turn already, with no hook to say so. Past this, the board takes it for the latter.
 */
export const USER_QUEUE_HOLD_MS = 10_000;

/** Why nothing others send is typed at an agent the user sent a line mid-turn, before a prompt takes it up. */
export const USER_QUEUED_REASON = 'you sent it a line in its turn, still to be taken up';

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
  /** How long a session may stay `starting` without a hook before it is given up on: `STARTING_MAX_MS` by default. */
  startingMaxMs?: number;
  /** How long a draft holds back what others send the agent: `DRAFT_HOLD_MS` by default. */
  draftHoldMs?: number;
  /** How long after its turn a line the user sent mid-turn holds back what others send the agent: `USER_QUEUE_HOLD_MS` by default. */
  userQueueHoldMs?: number;
  /** A line the user sent the agent mid-turn holds back what others send it no longer, no prompt having taken it up. */
  userQueueLapsed?(sessionId: string): void;
  /** Whether a command the agent left running in the background still runs. */
  onCommand?(sessionId: string): boolean;
  /** Whether a first prompt waits to be typed at the agent once its session is up, not given on its command line. */
  firstPromptDue?(sessionId: string): boolean;
  /**
   * Whether the agent's session says it is up by its screen, not a hook (a Codex agent's first prompt waits on its
   * composer): its output, however long its start takes, is then no sign of hooks not arriving.
   */
  upByScreen?(sessionId: string): boolean;
  /** The agent left `starting` without a hook: its output came, or it gave up waiting. */
  startingEnded(sessionId: string): void;
  /** Agents the board heard no hook from when it last ran (`hooksSilent`), until each one's first hook. */
  silent?: Iterable<string>;
  /** The agent's `hooksSilent` changed: keeps it, and tells every client (a stale hook after an interrupt saves nothing). */
  silentChanged?(sessionId: string, silent: boolean): void;
  /** The agent's own turn ended with `finalMessage`. */
  /** Keeps the final message of the agent's own turn that just ended, before the state that says so is saved. */
  recordFinal(sessionId: string, finalMessage: string): void;
  /** The agent's own turn ended with `finalMessage`, saved and announced: hands it off. */
  finished(sessionId: string, finalMessage: string): void;
  /** Writes a line to the daemon's log: why an agent went waiting. */
  log?(message: string): void;
}

/** What hook moved an agent on, for the log: its event, a notification's type, and its message cut short. */
function hookCause(payload: Record<string, unknown>): string {
  const type = typeof payload.notification_type === 'string' ? ` ${payload.notification_type}` : '';
  const message = typeof payload.message === 'string' ? oneLine(payload.message) : '';
  const said = message === '' ? '' : ` "${cutText(message, 120)}"`;
  return `${String(payload.hook_event_name)}${type}${said}`;
}

/**
 * Whether a message asks the user something: its last paragraph has a question mark. A turn that ends on a question
 * leaves Claude only `idle_prompt`, as a turn that ends on an answer does.
 */
export function asksSomething(message: string | undefined): boolean {
  return message !== undefined && message.trim().split(/\n\s*\n/).at(-1)!.includes('?');
}

/**
 * How the hooks of a live agent's harness become its state (ADR-0004), with what they leave behind between turns: what
 * it last said, whether it sits at its prompt or was interrupted, whether you are typing at it, and whether its last
 * permission prompt was settled.
 */
export function createHookStates<Row extends HookStateRow>(options: HookStateOptions<Row>) {
  const { permissions, subagents, save } = options;
  /**
   * Agents whose `waiting` came after their turn ended, from `idle` (Claude's `idle_prompt`, or an `agent_needs_input`
   * about another session it tracks): they sit at their prompt, not on a question of their own. A scheduled agent like
   * that is waiting for its next run, not for you.
   */
  const waitsAtPrompt = new Set<string>();
  /** Agents waiting only because their idle prompt fired after a failed turn: still at their prompt. */
  const idleAfterFailure = new Set<string>();
  /** What each agent last said to the user (`lastMessageAfterHook`). */
  const lastMessages = new Map<string, string>();
  /** Since when each agent compacting its conversation has been at it (`compactingAfterHook`). */
  const compacting = new Map<string, string>();
  /** Agents interrupted since their last prompt: hooks still landing from that turn's work are ignored. */
  const interrupted = new Set<string>();
  /**
   * Agents whose latest turn was interrupted, until their next prompt: it ended on no message, so the last one kept is of a
   * turn before it. That stays kept for hand-offs; only what is shown of the agent leaves it out (`endedOnNoMessage`).
   */
  const noMessage = new Set<string>();
  /** Agents with a draft the user typed at their prompt (`draftAfter`) and hasn't submitted, and when they last pressed a key there. */
  const drafts = new Map<string, Draft & { at: number }>();
  /**
   * Agents the user submitted a draft to mid-turn, until their next prompt: the harness holds it for after the turn,
   * and Escape, interrupting the turn, puts it back at the prompt as their draft. Nothing others send is typed at the
   * agent meanwhile, where it would join that line (`whyNotReady`). Once the turn has ended, each has what cancels the
   * timer that lets it go (`USER_QUEUE_HOLD_MS`).
   */
  const queuedByUser = new Map<string, (() => void) | undefined>();
  /**
   * Agents whose latest permission request has been settled (answered in the terminal or the turn moved on): a
   * `permission_prompt` notification then is the late echo of that prompt, not a new one.
   */
  const permissionSettled = new Set<string>();
  const clock = options.clock ?? systemClock;
  const startingMaxMs = options.startingMaxMs ?? STARTING_MAX_MS;
  const draftHoldMs = options.draftHoldMs ?? DRAFT_HOLD_MS;
  const userQueueHoldMs = options.userQueueHoldMs ?? USER_QUEUE_HOLD_MS;
  /** Forgets the line the user sent the agent mid-turn: a prompt took it up, Escape put it back, or the agent went. */
  const dropQueued = (sessionId: string) => {
    queuedByUser.get(sessionId)?.();
    queuedByUser.delete(sessionId);
  };
  /**
   * The turn the user sent the agent a line in has ended: the line holds back what others send it for
   * `userQueueHoldMs` more at most, its own prompt, as it is taken up, ending that sooner.
   */
  const queueTurnEnded = (sessionId: string) => {
    if (!queuedByUser.has(sessionId) || queuedByUser.get(sessionId) !== undefined) return;
    const lapse = () => {
      queuedByUser.delete(sessionId);
      options.log?.(`agent ${sessionId}: the line the user sent mid-turn was never seen taken up as a prompt, so it holds nothing back`);
      options.userQueueLapsed?.(sessionId);
    };
    queuedByUser.set(sessionId, clock.setTimer(lapse, userQueueHoldMs));
  };
  /**
   * How much longer the user's draft at the agent's prompt holds back what others send it: none left once
   * `draftHoldMs` has passed since their last key there; undefined with no draft there.
   */
  const draftHeldFor = (sessionId: string) => {
    const draft = drafts.get(sessionId);
    return draft === undefined ? undefined : Math.max(0, draft.at + draftHoldMs - clock.now());
  };
  /**
   * Agents started with a first prompt, whose session has sent no hook yet: their first turn hasn't begun. Each leaves
   * on its first hook, or without one: on output once `STARTING_OUTPUT_GRACE_MS` have passed (the session is up and
   * drawing but its hooks aren't arriving), or after `STARTING_MAX_MS` whatever happens, so it never sticks.
   */
  const starting = new Map<string, { since: number; cancel: () => void; up?: boolean }>();
  /** Agents whose process exited while they were `starting`: their start failed, until they are relaunched. */
  const startFailed = new Set<string>();
  /**
   * Agents started with a first prompt whose session has sent no hook yet, from when they were started. One still
   * unheard `STARTING_MAX_MS` after that, and no longer `starting`, goes silent.
   */
  const unheard = new Map<string, { since: number; cancel: () => void }>();
  /**
   * Agents whose session sent no hook in their first `STARTING_MAX_MS`, until it sends one, through restarts, wakes and
   * resumes: the board can't follow their turns. Only a hook clears it.
   */
  const silent = new Set<string>(options.silent);
  const stopUnheard = (sessionId: string) => {
    unheard.get(sessionId)?.cancel();
    unheard.delete(sessionId);
  };
  /** Sets the unheard agent silent once its time is up, unless it is still `starting` (its give-up checks again). */
  const silenceIfUnheard = (sessionId: string) => {
    const entry = unheard.get(sessionId);
    if (entry === undefined || starting.has(sessionId) || clock.now() - entry.since < startingMaxMs) return;
    stopUnheard(sessionId);
    if (silent.has(sessionId)) return;
    silent.add(sessionId);
    options.silentChanged?.(sessionId, true);
  };
  const stopStarting = (sessionId: string): boolean => {
    const entry = starting.get(sessionId);
    if (entry === undefined) return false;
    entry.cancel();
    starting.delete(sessionId);
    return true;
  };
  const giveUpStarting = (sessionId: string) => {
    if (!stopStarting(sessionId)) return;
    options.startingEnded(sessionId);
    silenceIfUnheard(sessionId);
  };
  /**
   * The starting agent's session is up, its first prompt still to be typed: its output from now (the prompt drawn as
   * it is typed) is no sign of hooks not arriving, and it stays `starting` for `STARTING_MAX_MS` more.
   */
  const markUp = (sessionId: string) => {
    const entry = starting.get(sessionId);
    if (entry === undefined) return;
    entry.cancel();
    starting.set(sessionId, { since: clock.now(), cancel: clock.setTimer(() => giveUpStarting(sessionId), startingMaxMs), up: true });
  };

  /** Whether the agent's last message asks the user something (`asksSomething`). */
  const asking = (sessionId: string) => asksSomething(lastMessages.get(sessionId));
  /**
   * Whether the live agent's turn is over, nothing of its own up: at its prompt (`atPrompt`, even asking), or stopped
   * there by a failed or rate-limited turn. A notification then tells of something else.
   */
  const turnOver = (row: Row) =>
    atPrompt(row, true) ||
    (row.ended_at === null &&
      permissions.prompts(row.session_id).length === 0 &&
      (row.state === 'failed' || row.state === 'rate-limited' || (row.state === 'waiting' && idleAfterFailure.has(row.session_id))));
  /** Whether the live agent sits at its prompt after a turn that ended asking the user something. */
  const askingAtPrompt = (row: Row) => row.ended_at === null && row.state === 'idle' && asking(row.session_id);

  /**
   * Whether the agent sits at its prompt between turns, ready for its next message and, unless `evenAsking`, not asking
   * you anything.
   */
  const atPrompt = (row: Row, evenAsking = false) =>
    row.ended_at === null &&
    permissions.prompts(row.session_id).length === 0 &&
    (evenAsking || !asking(row.session_id)) &&
    (row.state === 'idle' || (row.state === 'waiting' && waitsAtPrompt.has(row.session_id)));

  /** Where the live agent's prompt stands, whatever the user has typed there: `promptNow`, but never `typing`. */
  const promptUnderDraft = (row: Row): Exclude<PromptNow, 'typing'> => {
    const pending = permissions.prompts(row.session_id).length > 0;
    const failed = row.ended_at === null && !pending && (row.state === 'failed' || (row.state === 'waiting' && idleAfterFailure.has(row.session_id)));
    if (atPrompt(row, true) || failed) return 'at-prompt';
    const working = row.ended_at === null && !pending && (row.state === 'running' || row.state === 'thinking');
    return working ? 'working' : 'moved-on';
  };

  /**
   * Where the live agent's prompt stands after something was typed at it: the user typing there too, still at it as
   * a hand-off finds it (`whyNotReady` with `evenAsking`), or after a failed turn (which leaves it there, waiting
   * once its idle prompt fires); working through a turn with nothing of its own up; or moved on.
   */
  const promptNow = (row: Row): PromptNow => (drafts.has(row.session_id) ? 'typing' : promptUnderDraft(row));

  /**
   * Whether the live agent has something up over its prompt that keys answer: a permission prompt, a question or
   * dialog of its own, or a rate limit's menu.
   */
  const overPrompt = (row: Row) =>
    row.ended_at === null &&
    (permissions.prompts(row.session_id).length > 0 ||
      row.state === 'needs-permission' ||
      row.state === 'rate-limited' ||
      (row.state === 'waiting' && !waitsAtPrompt.has(row.session_id) && !idleAfterFailure.has(row.session_id)));

  return {
    /** The agent was started with a first prompt: it shows `starting` until its session's first hook. */
    promptQueued(sessionId: string) {
      stopStarting(sessionId);
      startFailed.delete(sessionId);
      stopUnheard(sessionId);
      starting.set(sessionId, { since: clock.now(), cancel: clock.setTimer(() => giveUpStarting(sessionId), startingMaxMs) });
      if (!silent.has(sessionId)) {
        unheard.set(sessionId, { since: clock.now(), cancel: clock.setTimer(() => silenceIfUnheard(sessionId), startingMaxMs) });
      }
    },

    /** The agent's session printed something: past the grace, an agent still `starting` with no hook at all stops. */
    outputSeen(sessionId: string) {
      const entry = starting.get(sessionId);
      if (entry === undefined || entry.up === true || options.upByScreen?.(sessionId) === true) return;
      if (clock.now() - entry.since >= STARTING_OUTPUT_GRACE_MS) giveUpStarting(sessionId);
    },

    /** Whether the live agent sits at its prompt between turns, asking you nothing. */
    isAtPrompt: (row: Row) => atPrompt(row),

    /** Whether the user has a draft at the agent's prompt they typed and haven't submitted (`draftAfterInput`). */
    isDrafting: (sessionId: string) => drafts.has(sessionId),

    draftHeldFor,

    /** Whether a line the user sent the agent mid-turn is still to be taken up as a prompt of its own (`queuedByUser`). */
    isUserQueued: (sessionId: string) => queuedByUser.has(sessionId),

    /** The agent's turn was seen to end with no hook of its own (`quiet-turns`): a line the user sent in it lapses soon. */
    turnEndedQuietly: (sessionId: string) => queueTurnEnded(sessionId),

    /** Whether the agent's session has yet to send its first hook, with a first prompt queued. */
    isStarting: (sessionId: string) => starting.has(sessionId),

    /** The starting Codex agent's composer is up (Codex fires no hook before its first prompt): as `markUp`. */
    composerUp: (sessionId: string) => markUp(sessionId),

    /** Whether the starting agent's session is up, its first prompt still to go up: what it prints now is its prompt. */
    isUp: (sessionId: string) => starting.get(sessionId)?.up === true,

    /** Whether the agent's process exited while it was `starting`, before its session's first hook. */
    startFailed: (sessionId: string) => startFailed.has(sessionId),

    /** Whether the agent's session sent no hook in its first `STARTING_MAX_MS`, and has sent none since. */
    hooksSilent: (sessionId: string) => silent.has(sessionId),

    /** What the agent last said to the user, if anything. */
    lastMessage: (sessionId: string) => lastMessages.get(sessionId),

    /** Since when the agent has been compacting its conversation, while it is. */
    compactingSince: (sessionId: string) => compacting.get(sessionId),

    /**
     * Whether the agent went `waiting` from `idle`, after its turn ended, and its state hasn't changed since: it sits at
     * its prompt asking nothing, as Claude's `agent_needs_input` during a turn would.
     */
    waitsAtPrompt: (sessionId: string) => waitsAtPrompt.has(sessionId),

    /**
     * The state a live agent with an enabled schedule shows: `scheduled` at its prompt, waiting for its next run, and
     * `waiting` for you, so in the needs-you inbox, when its turn ended on a question.
     */
    scheduledState(row: Row): AgentState {
      if (atPrompt(row)) return 'scheduled';
      if (askingAtPrompt(row)) return 'waiting';
      return row.state;
    },

    /** Whether the live agent sits at its prompt after a turn that ended asking the user something. */
    askingAtPrompt,

    /**
     * Why a scheduled run can't start in the live agent now, or undefined if it can. With `evenAsking`, as for a hand-off,
     * a last message asking you something doesn't stop it: what's typed is the agent's next input either way. A draft
     * at its prompt stops it; without `lapsedDrafts`, as for a message others sent, only one still held (`draftHeldFor`).
     * So does a line the user sent it mid-turn, still to be taken up (`queuedByUser`). Asked at its prompt with no end
     * of that turn heard, it starts that hold's lapse, as no word of the end may ever come.
     */
    whyNotReady(row: Row, evenAsking = false, lapsedDrafts = true): string | undefined {
      const sessionId = row.session_id;
      const askingYou = !evenAsking && asking(sessionId);
      if (row.state === 'rate-limited') return 'it was rate-limited';
      // A failed turn leaves the agent at its prompt.
      if (!atPrompt(row, evenAsking) && !(row.state === 'failed' && permissions.prompts(sessionId).length === 0)) {
        const waiting =
          row.state === 'waiting' || row.state === 'needs-permission' || permissions.prompts(sessionId).length > 0 || askingYou;
        return waiting ? WAITING_FOR_YOU : STILL_WORKING;
      }
      if (askingYou) return WAITING_FOR_YOU;
      if (queuedByUser.has(sessionId)) {
        // A turn whose end the board never heard (a lost `Stop`, no idle prompt seen) is over all the same: the
        // hold's lapse starts now, once.
        queueTurnEnded(sessionId);
        return USER_QUEUED_REASON;
      }
      if (drafts.has(sessionId) && (lapsedDrafts || (draftHeldFor(sessionId) ?? 0) > 0)) return 'you were typing in its terminal';
      return undefined;
    },

    promptNow,

    /** Whether `payload` is a hook from the agent's interrupted turn, landing after the interrupt: no news of a new one. */
    isStale: (sessionId: string, payload: Record<string, unknown>) => interrupted.has(sessionId) && isStaleAfterInterrupt(payload),

    /**
     * Moves the live agent `row` on by one of its hooks, and hands off its final message when its own turn ends.
     * Returns the hook's reply: a held PermissionRequest's.
     */
    onHook(row: Row, payload: Record<string, unknown>, signal: AbortSignal): Promise<HookReply> | undefined {
      const sessionId = row.session_id;
      stopUnheard(sessionId);
      // Its first hook after it went silent: what is saved is told, so its tile drops the warning.
      const unsilenced = silent.delete(sessionId);
      if (unsilenced) options.silentChanged?.(sessionId, false);
      // Claude's session is up, its first prompt still to be typed: it stays `starting` until that prompt's own hook.
      // (Codex fires `SessionStart` only with a prompt: one while its first is still due is of a turn begun by hand.)
      const typingFirst =
        row.harness === 'claude' && payload.hook_event_name === 'SessionStart' && options.firstPromptDue?.(sessionId) === true;
      if (typingFirst) markUp(sessionId);
      const prompted = !typingFirst && stopStarting(sessionId);
      if (payload.hook_event_name === 'UserPromptSubmit') {
        interrupted.delete(sessionId);
        noMessage.delete(sessionId);
        drafts.delete(sessionId);
        dropQueued(sessionId);
      } else if (interrupted.has(sessionId) && isStaleAfterInterrupt(payload)) return undefined;
      const settled = permissions.afterHook(sessionId, payload);
      // Claude asks in its terminal while the agent's own request is held; a subagent's dialog may wait on its hook first.
      const asksInTerminal = row.harness === 'claude' && payload.agent_id === undefined;
      // A request only a person may allow is no prompt of the board's: holding it would keep Claude from its own dialog
      // until its tool timeout denies the call, with the agent flagged for nothing the board can do. It goes at once, and
      // leaves the agent as it was; a dialog Claude then draws flags it by its own notification.
      const personOnly = asksInTerminal && onlyAPersonAllows(payload);
      if (personOnly) options.log?.(`agent ${sessionId}: Claude asks a person, not the board, to allow ${String(payload.tool_name)} (no suggestions came with its request)`);
      const held = payload.hook_event_name === 'PermissionRequest' && !personOnly;
      const reply = held ? permissions.hold(sessionId, payload, signal, asksInTerminal) : undefined;
      if (payload.hook_event_name === 'PermissionRequest') {
        // A new ask, held or not: a permission notification after it is its dialog's, no late echo of an earlier one.
        permissionSettled.delete(sessionId);
        // Another prompt is a new ask, even when the state was already needs-permission.
        if (held) options.unsee(sessionId);
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
      // A notification once its turn is over tells of another session Claude tracks: not its last word. A dialog of
      // Claude's own is: it is what is up.
      const ownDialog = isOwnDialog(payload);
      const notifiedAtPrompt = payload.hook_event_name === 'Notification' && !ownDialog && turnOver(row);
      const lastMessage = notifiedAtPrompt ? previousMessage : lastMessageAfterHook(previousMessage, payload);
      if (lastMessage === null) lastMessages.delete(sessionId);
      else lastMessages.set(sessionId, lastMessage);
      const wasCompacting = compacting.get(sessionId) ?? null;
      const compactingSince = compactingAfterHook(wasCompacting, payload, new Date(clock.now()).toISOString());
      if (compactingSince === null) compacting.delete(sessionId);
      else compacting.set(sessionId, compactingSince);
      const next = subagentsAfterHook(subagents.of(sessionId), payload, new Date());
      const counts = promptCounts(permissions.prompts(sessionId));
      // An agent started with no task, or resumed (woken, restarted) with no new prompt, has nothing to run yet: its
      // session starting leaves it idle for its next message. One whose first prompt is still to be typed sits idle at
      // its prompt for it. A prompt it was resumed with moves it on at its own hook.
      const awaitingTask =
        payload.hook_event_name === 'SessionStart' &&
        row.state === 'idle' &&
        (typingFirst || (!prompted && (row.description === '' || payload.source === 'resume')));
      const hooked = stateWithPrompts(awaitingTask ? 'idle' : personOnly ? row.state : stateAfterHook(row.harness, row.state, payload), { ...counts, settled });
      // A notification at its prompt (its idle prompt, word of another session) while a command it left runs says nothing
      // of you: it stays idle, so the command's end, before the harness takes up its result, never shows it waiting.
      const state = row.state === 'idle' && hooked === 'waiting' && !ownDialog && options.onCommand?.(sessionId) === true ? 'idle' : hooked;
      // A dialog of Claude's own over the prompt it waited at (after its idle prompt, as it usually comes): a new ask.
      const dialogOverPrompt = ownDialog && state === 'waiting' && row.state === 'waiting' && turnOver(row);
      if (dialogOverPrompt) options.unsee(sessionId);
      // Its turn ended: no question of its own is up, whichever notification moved it on, unless Claude opened a dialog.
      if (row.state === 'idle' && state === 'waiting' && !ownDialog) waitsAtPrompt.add(sessionId);
      else if (state !== row.state || ownDialog) waitsAtPrompt.delete(sessionId);
      if (row.state === 'failed' && state === 'waiting' && !ownDialog) idleAfterFailure.add(sessionId);
      else if (state !== row.state || ownDialog) idleAfterFailure.delete(sessionId);
      if (state === 'waiting' && (row.state !== 'waiting' || dialogOverPrompt)) {
        const atItsPrompt = waitsAtPrompt.has(sessionId) || idleAfterFailure.has(sessionId);
        const up = ownDialog ? "a dialog of Claude's own up" : 'a question of its own up';
        const where = atItsPrompt ? 'at its prompt, its turn ended' : `from ${row.state}, ${up}`;
        const went = dialogOverPrompt ? "has a dialog of Claude's own up at its prompt" : `went waiting ${where}`;
        options.log?.(`agent ${sessionId} ${went}: ${hookCause(payload)}`);
      }
      // Its own turn ended with a final message (a subagent's Stop is SubagentStop): it is kept before the state is saved,
      // so what that announces already carries it, and hands it off.
      const finalMessage = payload.last_assistant_message;
      const ended = payload.hook_event_name === 'Stop' && payload.agent_id === undefined && typeof finalMessage === 'string';
      if (ended) options.recordFinal(sessionId, finalMessage);
      // Its turn is over: the line the user sent in it is taken up soon, if it wasn't at a step.
      const ownTurnOver =
        payload.hook_event_name === 'Stop' ||
        payload.hook_event_name === 'StopFailure' ||
        (payload.hook_event_name === 'Notification' && payload.notification_type === 'idle_prompt');
      if (ownTurnOver && payload.agent_id === undefined) queueTurnEnded(sessionId);
      save(row, state, next, unsilenced || ended || settled || reply !== undefined || lastMessage !== previousMessage || compactingSince !== wasCompacting);
      if (ended) options.finished(sessionId, finalMessage);
      return reply;
    },

    /**
     * Notes what the user typed at the agent's prompt: a draft, until it is submitted or cleared. Given its `row`, keys
     * answering something up over its prompt (a permission prompt, a question, a rate limit's menu) type nothing there.
     * `cols`, its terminal's width, says how long a line fits on one row of its prompt, all of which Ctrl-U clears.
     */
    typed(sessionId: string, data: string, row?: Row, cols?: number) {
      if (row !== undefined && overPrompt(row)) return;
      const draft = drafts.get(sessionId);
      // Mid-turn the user types a draft too, key by key, before the Enter that queues it.
      if (row !== undefined && promptUnderDraft(row) === 'working' && submitsDraft(draft, data, cols)) {
        // Another line sent in the same turn joins the first in the harness's queue.
        if (!queuedByUser.has(sessionId)) queuedByUser.set(sessionId, undefined);
      }
      const restored = queuedByUser.has(sessionId) && pressesEscape(data);
      if (restored) dropQueued(sessionId);
      const next = restored ? { length: undefined } : draftAfter(draft, data, cols);
      if (next === undefined) drafts.delete(sessionId);
      else drafts.set(sessionId, { ...next, at: clock.now() });
    },

    /** The agent's turn was interrupted: hooks still landing from its work are stale until its next prompt. */
    interrupted(sessionId: string) {
      // A line the user sent in the turn is no longer waiting for one. No draft is made of it: Claude may have taken it
      // at a step already, and a draft the prompt never had would hold hand-offs and runs till the user pressed a key.
      dropQueued(sessionId);
      interrupted.add(sessionId);
      noMessage.add(sessionId);
      compacting.delete(sessionId);
    },

    /** Whether the agent's latest turn was interrupted, so the final message kept is of an earlier turn. */
    endedOnNoMessage: (sessionId: string) => noMessage.has(sessionId),

    /** The agent's permission prompt was decided on the board. */
    permissionDecided(sessionId: string) {
      permissionSettled.add(sessionId);
    },

    /** The agent was relaunched: what it last said and any draft at its old prompt are gone. Silent, it stays so. */
    relaunched(sessionId: string) {
      startFailed.delete(sessionId);
      lastMessages.delete(sessionId);
      drafts.delete(sessionId);
      dropQueued(sessionId);
    },

    /** The agent's process exited. Its tile still shows what it last said. */
    ended(sessionId: string) {
      if (starting.has(sessionId)) startFailed.add(sessionId);
      stopStarting(sessionId);
      stopUnheard(sessionId);
      idleAfterFailure.delete(sessionId);
      permissionSettled.delete(sessionId);
      interrupted.delete(sessionId);
      waitsAtPrompt.delete(sessionId);
      drafts.delete(sessionId);
      dropQueued(sessionId);
      compacting.delete(sessionId);
    },

    /** The agent was deleted. */
    deleted(sessionId: string) {
      stopStarting(sessionId);
      startFailed.delete(sessionId);
      stopUnheard(sessionId);
      silent.delete(sessionId);
      idleAfterFailure.delete(sessionId);
      noMessage.delete(sessionId);
      waitsAtPrompt.delete(sessionId);
      drafts.delete(sessionId);
      dropQueued(sessionId);
      lastMessages.delete(sessionId);
    },
  };
}
