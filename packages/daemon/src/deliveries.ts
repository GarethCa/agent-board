import { systemClock, type Clock } from './clock.ts';
import { recount } from './counts.ts';
import { handOffMessage } from './handoff-text.ts';
import { refOf } from './crew-flags.ts';
import { invalidParams } from './params.ts';
import { FIRST_PROMPT, questionPrompt, type Agent, type Harness, type PermissionPrompt } from './protocol.ts';
import type { RunStart } from './schedules.ts';
import { CONTINUE, readRateLimitScreen } from './rate-limit-screen.ts';
import { answerInput, draftAfterInput, endsInEnter, oneLine, pastePieces, pressesKeys, promptRows, submittedText } from './terminal-input.ts';
import { cutText } from './text-cut.ts';
import type { SendTrail } from './send-log.ts';

/**
 * Why nothing is typed at an agent whose question dialog is up, and where to answer it: on the board too only while the
 * board can still answer it (its answers unsent, its hook held), else only in its terminal.
 */
function askingQuestions(name: string, prompt: PermissionPrompt): string {
  const { dialog } = prompt;
  const onBoard = dialog !== null && dialog.sentAt === null && !dialog.keptOpen && prompt.heldUntil !== null;
  return `${name} is asking you questions: answer them ${onBoard ? 'on the board or ' : ''}in its terminal`;
}

/**
 * How long the terminal must stay quiet after drawing the typed text for the harness to have taken it in, so Enter
 * isn't taken as part of a pasted line.
 */
const SETTLE_QUIET_MS = 150;

/** The longest typed text waits to be taken in before Enter is pressed all the same. */
const SETTLE_MAX_MS = 2_000;

/**
 * How long Enter gets to start a turn (its `UserPromptSubmit`) before it is pressed again, doubling each time: a slow
 * machine's harness can lose one that lands before it has taken in the text.
 */
const DEFAULT_SUBMIT_CONFIRM_MS = 3_000;

/**
 * How long after the user's last key in an agent's terminal nothing is typed there but their own: they may be part way
 * through a line, or about to type the next, and a message typed then would run into what they type.
 */
export const USER_IDLE_MS = 3_000;

/** Why nothing is typed for the board at an agent whose terminal the user is typing in. */
const USER_TYPING_REASON = 'you were typing in its terminal';

/** Why nothing is typed at an agent whose session isn't up yet. */
const NOT_UP_REASON = "its session isn't up yet";

/** Why nothing is typed at an agent whose session isn't up yet, with a first prompt to go first once it is. */
const NOT_UP_FIRST_REASON = `${NOT_UP_REASON}: its first prompt goes first`;

/** Why what was queued for an agent not up yet is handed back as the daemon closes (`handBackQueued`). */
const CLOSED_REASON = 'the daemon shut down before it was up';

/** Why what waited for an agent's turn to end is handed back as the daemon closes, with no store to keep it (`handBackQueued`). */
const CLOSED_IN_TURN_REASON = 'the daemon shut down before its turn ended';

/** How many more times Enter is pressed before what was typed is called not sent. */
const SUBMIT_RETRIES = 2;

/**
 * How many more times Enter is pressed on a first prompt: a new agent's harness, loading on a busy machine, may take
 * a minute or two to take it, and nobody waits on its answer meanwhile. With each wait capped at `MAX_SUBMIT_WAITS`
 * confirm times, that is about two minutes at the default confirm time.
 */
const FIRST_PROMPT_SUBMIT_RETRIES = 5;

/** The longest wait for a turn to start after one press of Enter, in confirm times: the backoff stops doubling there. */
const MAX_SUBMIT_WAITS = 10;

/** The key that closes a TUI's menu, picking none of its rows. */
const ESCAPE = '\x1b';

/** How many times Escape is pressed on the rate-limit menu before giving up: it may take no keys just after it opens. */
const MENU_CLOSES = 3;

/**
 * Why what was typed at an agent's prompt was given up on, its prompt standing at `now`: Enter, pressed again and again,
 * never started a turn; the user typed there meanwhile; a turn started before Enter was pressed; or it moved on (a
 * permission prompt, a question).
 */
const whyGaveUp = (now: PromptNow, retries = SUBMIT_RETRIES): string =>
  now === 'at-prompt'
    ? `no turn started on it after ${retries + 1} presses of Enter`
    : now === 'typing'
      ? 'you typed at its prompt meanwhile'
      : now === 'working'
        ? 'a turn started before Enter was pressed'
        : 'it moved on before Enter was pressed';

/**
 * A message sent to an agent mid-turn, waiting for that turn to end (`queueAfterTurn`): `typing` hears its typing
 * start, and `settled` how it went once typed (whether its turn started), or that it was handed back instead: `why`
 * says why, when no turn started on it.
 */
export interface AfterTurn extends WaitingMessage {
  typing(): void;
  settled(started: boolean, why?: string): void;
}

/** A message typed into an agent's turn under way, for its harness to take up after it: as it was sent, and by whom. */
interface InTurnMessage {
  text: string;
  /** The agent that sent it, told if it is handed back; none for the user's own. */
  from?: string;
}

/**
 * A message typed into an agent's turn, held in its harness's own queue until the harness takes it up, as `submits`
 * (the line it submits, as `promptHolds` reads it): what the harness has taken as prompts since it was typed
 * (`taken`, read from its transcript, none to read without one), and how many of the agent's turns have ended since.
 */
interface HeldMessage {
  message: InTurnMessage;
  submits: string;
  taken?: () => string[];
  turnsEnded: number;
}

/** A message held in a turn whose harness hasn't taken it up by the end of the turn after: long taken some way unseen. */
const HELD_TURNS = 2;

/** The tags round a block Claude folded, as its transcript keeps them: the block's text is the message. */
const FOLDED_TAG = /<\/?pasted_content id="[^"<>]*">/g;

/**
 * Whether the prompt a harness took holds `submits`, word for word: is it, or is one of several queued that went up as
 * one, so a short message is not in any prompt with its word in.
 */
const promptHolds = (prompt: string, submits: string) => submits !== '' && ` ${withoutTabs(oneLine(prompt.replace(FOLDED_TAG, '\n')))} `.includes(` ${submits} `);

/** What a message waiting for an agent's turn to end is, as its store keeps it. */
export interface WaitingMessage {
  text: string;
  /** The agent that sent it, which is told if it is never delivered; none for the user's own. */
  from?: string;
  /**
   * For a notice the board types itself (that a message to another agent was not delivered): the agent it is about. A
   * notice that can't be typed is dropped, never handed back: nobody sent it.
   */
  about?: string;
  /** For a notice: how many messages it says were not delivered, one if not given. */
  lost?: number;
}

/** A message kept in the store, waiting for the agent `sessionId`'s turn to end: `id` is its place in the store. */
export interface KeptWaiting extends WaitingMessage {
  id: number;
  sessionId: string;
}

/**
 * Where the messages waiting for agents' turns to end are kept (`queueAfterTurn`), so they outlive the daemon: each is
 * added as it is queued and removed once it is typed, handed back or dropped.
 */
export interface WaitingStore {
  /** Keeps `message` for the agent, and returns its id. */
  add(sessionId: string, message: WaitingMessage): number;
  remove(id: number): void;
  /** Everything kept, oldest first. */
  all(): KeptWaiting[];
}

/** Why a message queued in a turn its rate limit stopped was given up on: Enter there may pick from Claude's menu. */
const RATE_LIMITED_REASON = 'its turn hit a rate limit';

/** `text` as Claude submits it, a tab made four spaces, to compare what was typed with what it submitted. */
const withoutTabs = (text: string) => text.replaceAll('\t', '    ');

/** Why nothing more is typed at a prompt holding a message that was never sent: it would run on from it. */
const UNSENT_REASON = 'a message typed at its prompt was never sent';

/** Tells `trail` how typing a message went: a turn started on it, it was queued in a turn, or it was left a draft. */
function trailTyped(trail: SendTrail | undefined, typed: Typed): void {
  if (trail === undefined) return;
  if (!typed.typed) trail(`not typed, handed back: ${typed.reason}`);
  else if (!typed.sent) trail(`left as a draft at its prompt: ${typed.why ?? UNSENT_REASON}`);
  else trail(typed.inTurn === true ? 'a turn started as it was typed: queued in that turn' : 'turn started on it');
}

/**
 * What clears a draft of `lines` rows at a harness's prompt (`promptRows`), its cursor at its end, as the board's Clear
 * does with an unsent message: Ctrl-U clears the row up to the cursor, and Backspace at a row's start joins it to the one
 * above, for the next Ctrl-U. Both Claude Code and Codex take these keys so; a paste a harness shows as one placeholder
 * (`[Pasted text +4 lines]`) goes at the first Ctrl-U, and the keys after it do nothing at an empty prompt.
 */
const clearKeys = (lines: number) => `\x15${'\x7f\x15'.repeat(lines - 1)}`;

/**
 * How typing at an agent went: typed, and whether its turn started (or, `inTurn`, its one Enter queued it in the turn
 * under way), or else why it was given up on, left unsent; or not typed, and why.
 */
type Typed = { typed: true; sent: boolean; inTurn?: boolean; why?: string } | { typed: false; reason: string };

/**
 * How a message sent as the agent's next went (`answer`), once handed to it: typed and its turn started; queued until
 * its session is up; the paused agent `woken` with it, to be typed once its session is up; its one Enter queued it in a
 * turn under way (`inTurn`); or typed but not sent, `unsent` saying why it was given up on.
 */
export interface Delivered {
  queued: boolean;
  woken?: true;
  inTurn?: true;
  unsent?: string;
}

/**
 * How a message sent as the agent's next went (`answer`): `Delivered`, or, another agent's, not typed as the user is
 * typing at its prompt (`userTyping`), for its caller to keep until they stop.
 */
export type Answered = Delivered | { userTyping: true };

/** How sending an unsent message went (`send`): its turn started, or why not. */
export type UnsentSent = { started: true } | { started: false; why: string };

/**
 * Where an agent's prompt stands: between turns, holding only what was typed (`at-prompt`) or the user's typing too
 * (`typing`); in a turn with nothing of its own up, where Enter queues what is typed for after it, as both harnesses
 * do (`working`); or moved on, where Enter would answer something else (a permission prompt, a question) or its
 * session is gone.
 */
export type PromptNow = 'at-prompt' | 'typing' | 'working' | 'moved-on';

/** What delivering to an agent reads of its row. */
export interface DeliveryRow {
  name: string;
  ended_at: string | null;
  harness: Harness;
  /** The harness's own name for its conversation: Codex's, which `codex resume` needs. */
  harness_session_id: string | null;
  /** Set once the agent is being paused, or is: a pause under way has it set while its session still runs. */
  hibernated_at: string | null;
}

interface DeliveryOptions<Row extends DeliveryRow> {
  /** Writes `data` to the agent's terminal. */
  write(sessionId: string, data: string): void;
  getRow(sessionId: string): Row | undefined;
  /** The agent, or an invalid-params error if there is none. */
  requireAgent(sessionId: string): Pick<Agent, 'name' | 'endedAt' | 'state' | 'lastMessage' | 'permissions'>;
  /** Why a run can't start in the live agent now, or undefined if it can (`evenAsking` as for a hand-off). */
  whyNotReady(row: Row, evenAsking?: boolean, lapsedDrafts?: boolean): string | undefined;
  /** Relaunches the ended agent with `prompt` as its first message, carrying on Codex conversation `codexSessionId`. */
  relaunch(row: Row, prompt: string | undefined, why: string, codexSessionId?: string | null): RunStart;
  /** Where the agent's prompt stands now. */
  promptNow(sessionId: string): PromptNow;
  /**
   * How much longer the user's draft at the agent's prompt holds back what others send it, in ms (`DRAFT_HOLD_MS` after
   * their last key); undefined with none there. Without it, any draft (`promptNow` typing) holds them back.
   */
  draftHeldFor?(sessionId: string): number | undefined;
  /** Whether a line the user sent the agent mid-turn waits in its harness, still to be taken up as a prompt of its own. */
  userQueued?(sessionId: string): boolean;
  /** What resolves once a pause of the agent under way has ended its session; undefined while none is. */
  pausing(sessionId: string): Promise<void> | undefined;
  /** Tells every client the agent changed. */
  announce(sessionId: string): void;
  /**
   * What was sent to the agent before it was up or mid-turn (`what`: `A message`, `A scheduled run`), as `text`, was
   * never typed, and why: its sender heard it was queued, so it is handed back, to the agent that sent it (`from`), or
   * else for the user to see and resend.
   */
  undelivered(sessionId: string, what: string, text: string, reason: string, from?: string): void;
  /**
   * Marks the agent's transcript now, for what its harness takes as prompts from here on: a reader of the prompts
   * written to it since, each read at once, as a daemon shutting down needs. Undefined with no transcript to mark:
   * a message held in its turn then can't be seen taken up at a step of it, only by its `UserPromptSubmit`.
   */
  promptsFromNow?(sessionId: string): (() => string[]) | undefined;
  /**
   * What was typed at the agent's prompt (`what`) was given up on, no Enter starting a turn on it, and why: the user is
   * told, as only their Send or Clear moves it on (in its terminal, with `inTerminal`, as the board's Send refuses a
   * prompt they typed at); or, with no `what`, the agent's prompt holds nothing unsent now.
   */
  notSent?(sessionId: string, what?: string, why?: string, inTerminal?: boolean): void;
  log(message: string): void;
  /** Where the messages waiting for a turn to end are kept across restarts; in memory only without. */
  waiting?: WaitingStore;
  clock?: Clock;
  /** How long Enter first gets to start a turn (`DEFAULT_SUBMIT_CONFIRM_MS`). */
  submitConfirmMs?: number;
  /** How long after the user's last key in an agent's terminal it counts as theirs (`USER_IDLE_MS`). */
  userIdleMs?: number;
}

/**
 * What is typed at agents' prompts: the user's answers, scheduled runs and other agents' hand-offs, one line after
 * another per agent; an ended agent is relaunched with it instead. Nothing is typed once a permission prompt or a
 * question is up, where its keys would answer that. Each is submitted with Enter once the harness has taken it in, and
 * Enter is pressed again while no turn starts; one still not submitted is kept as the agent's unsent message, which the
 * user sends or clears by hand, and nothing more is typed onto it. Anything typed mid-turn (an answer, or another
 * whose agent started a turn while it was typed) gets one Enter, which the harness queues for after the turn: the turn's end then waits for it to start a turn of its own, as for any other.
 * Pressing Enter again rests on Enter at an empty prompt doing nothing in either harness, as it does in Claude Code and
 * Codex today: a turn whose hook is late is never started twice. An answer queued mid-turn is taken up with a
 * `UserPromptSubmit` once the turn ends, or, in Claude, at a step of the turn, with only its transcript to say so: one
 * not seen taken up as its session ends is handed back (`held`). Counts the hand-offs each agent has
 * still landing.
 */
export function createDeliveries<Row extends DeliveryRow>(options: DeliveryOptions<Row>) {
  const { getRow, requireAgent, whyNotReady, relaunch, announce } = options;
  const clock = options.clock ?? systemClock;
  /** Set as the daemon closes (`close`): no timer of a delivery fires after, nor is a prompt read again. */
  let closed = false;
  /** What cancels each timer still pending, for `close` to cancel them all. */
  const timers = new Set<() => void>();
  /** `clock.setTimer`, its timer cancelled as the daemon closes, and never set once it has: nothing waiting runs on. */
  const setTimer = (callback: () => void, ms: number): (() => void) => {
    if (closed) return () => {};
    const cancel = clock.setTimer(() => {
      timers.delete(cancel);
      callback();
    }, ms);
    timers.add(cancel);
    return () => {
      timers.delete(cancel);
      cancel();
    };
  };
  const confirmMs = options.submitConfirmMs ?? DEFAULT_SUBMIT_CONFIRM_MS;
  const userIdleMs = options.userIdleMs ?? USER_IDLE_MS;
  /**
   * Per agent, when the user last pressed a key in its terminal (`typed`), and what cancels the timer that tells clients
   * it changed once they have been idle for `userIdleMs`: what waits for it (`deliverAfterTurn`) is typed then. No time
   * when that key was Enter, which sent their line (or did nothing at an empty prompt): nothing need wait after it.
   */
  const lastKey = new Map<string, { at: number | undefined; cancel: () => void }>();
  /** Whether the user pressed a key but Enter in the agent's terminal less than `userIdleMs` ago. */
  const typedLately = (sessionId: string) => {
    const at = lastKey.get(sessionId)?.at;
    return at !== undefined && clock.now() - at < userIdleMs;
  };
  /** Forgets the user's last key in the agent's terminal: its prompt went with its session. */
  const forgetKeys = (sessionId: string) => {
    lastKey.get(sessionId)?.cancel();
    lastKey.delete(sessionId);
  };
  /** Whether a draft of the user's at the agent's prompt holds back what others send it (`draftHeldFor`). */
  const draftHolds = (sessionId: string) =>
    options.draftHeldFor === undefined ? options.promptNow(sessionId) === 'typing' : (options.draftHeldFor(sessionId) ?? 0) > 0;
  /**
   * Whether the user is at the agent's prompt: a draft of theirs holds it, they pressed a key in its terminal lately, or
   * a line they sent mid-turn is still to be taken up. Nothing but their own is typed there then, so nothing runs into
   * what they type.
   */
  const userTyping = (sessionId: string) => draftHolds(sessionId) || typedLately(sessionId) || options.userQueued?.(sessionId) === true;
  /** Per agent handing off, how many of its deliveries are still landing: it shows `handing-off` until none are. */
  const handingOff = new Map<string, number>();
  /** Per agent, the answer being typed into its terminal, so the next waits for it. */
  const answering = new Map<string, Promise<void>>();
  /** Per agent, what hears its terminal's output while typed text lands. */
  const settling = new Map<string, () => void>();
  /** Per agent, what hears its next prompt submitted while Enter waits for its turn to start. */
  const submitting = new Map<string, () => void>();
  /** Per agent, what was typed at its prompt and never sent (`Hand-off from impl`), and in how many lines, until it is. */
  const unsent = new Map<string, { what: string; lines: number }>();
  /** Agents whose unsent message the user's Send is pressing Enter on: it stays unsent, and blocks, until then. */
  const sending = new Set<string>();
  /**
   * Per agent, what was typed and submitted mid-turn (the last of it as one line, `text`, and how many there were), for
   * its harness to take up once that turn ends, and in how many lines, until it does: a `UserPromptSubmit` with it, or
   * the turn's end. The user's own keys at the prompt end it too, as what is there is then theirs.
   */
  const queued = new Map<string, { what: string; lines: number; text: string; count: number }>();
  /**
   * Per agent, the messages typed into its turn (`answer`) that its harness holds in its own queue and hasn't been seen
   * taking up, oldest first. Each is let go once a prompt the harness takes holds it (`UserPromptSubmit`, or, read from
   * its transcript, Claude's taking it at a step of the turn), or it is left at the prompt unsent, or the turn after
   * ends without it (`HELD_TURNS`). The user's keys at the prompt leave them be: the harness's queue is still there.
   * The queue goes with the harness, so a session that ends first hands them back (`handBackInTurn`).
   */
  const held = new Map<string, HeldMessage[]>();
  /**
   * Agents whose unsent message is one queued in a turn the user interrupted: Codex's own `Interrupt` hook, and a `Stop`
   * the harness had fired before the interrupt reached it, landing after, are no news that it was taken. Held until
   * the next prompt (`turnSeen`), so a prompt whose hook is lost leaves the guard up, as it does `TURN_WORK_HOOKS`.
   */
  const interruptedWith = new Set<string>();
  /**
   * Agents whose session isn't up yet, with what settles it and why nothing is typed at them meanwhile (their first
   * prompt, if any, goes first): nothing is typed at them until it has. A relaunch's own replaces the one before, which
   * then leaves it in place as it settles.
   */
  const notUp = new Map<string, { settled: Promise<boolean>; reason: string }>();
  /**
   * Agents whose first prompt is being typed now, its session up: a `SessionStart` landing meanwhile (Claude's prompt
   * seen on its screen typed it first) still leaves it at its prompt for that prompt's Enter.
   */
  const typingFirst = new Set<string>();
  /** Per agent not up when they came, how many messages wait to be typed after its first prompt (`queueUntilUp`). */
  const waitingUp = new Map<string, number>();
  /**
   * What was queued for agents not up yet and not yet typed or handed back (`queueOrHandBack`), oldest first: whichever
   * comes first, its typing starting, its queue settling or the daemon closing (`handBackQueued`), takes each one.
   */
  const queuedItems = new Set<{ sessionId: string; what: string; text: string; trail?: SendTrail; from?: string }>();
  /** The trail of the message a paused agent is being woken with, for its first prompt to carry on (`firstPrompt`). */
  const wakeTrails = new Map<string, SendTrail>();
  /** The agent that sent the message a paused agent is being woken with: told, not the user, if it is never typed. */
  const wakeSenders = new Map<string, string>();
  /**
   * Per agent mid-turn when they came, the messages waiting for its turn to end, oldest first (`queueAfterTurn`), each
   * with its id in the store (`waiting`), if kept there.
   */
  const afterTurn = new Map<string, (AfterTurn & { keptAs?: number })[]>();
  /** Takes `item` out of the store, if it is kept there. */
  const unkeep = (item: { keptAs?: number }) => {
    if (item.keptAs === undefined) return;
    options.waiting?.remove(item.keptAs);
    delete item.keptAs;
  };
  // What the daemon before this one kept waiting: typed once each agent is ready again. Its store forgets what was kept
  // for an agent as it is deleted, so no agent is looked up here, before the host that finds them is up.
  for (const kept of options.waiting?.all() ?? []) {
    const { id, sessionId, ...message } = kept;
    const restored = {
      ...message,
      keptAs: id,
      typing: () => options.log(`a message kept for ${sessionId} over a restart is being typed`),
      settled: (started: boolean, why?: string) =>
        options.log(`a message kept for ${sessionId} over a restart: ${started ? 'turn started on it' : (why ?? 'no turn started on it')}`),
    };
    afterTurn.set(sessionId, [...(afterTurn.get(sessionId) ?? []), restored]);
  }
  /** Agents one of whose messages waiting for its turn to end is being typed now. */
  const typingAfterTurn = new Set<string>();

  /** Keeps `kept` as the agent's unsent message, or forgets it; `why` it was given up on tells the user (`notSent`). */
  const setUnsent = (sessionId: string, kept: { what: string; lines: number } | undefined, why?: string) => {
    interruptedWith.delete(sessionId);
    if (kept === undefined ? !unsent.has(sessionId) : unsent.get(sessionId)?.what === kept.what) return;
    if (kept === undefined) unsent.delete(sessionId);
    else unsent.set(sessionId, kept);
    if (kept === undefined) options.notSent?.(sessionId);
    else if (why !== undefined) options.notSent?.(sessionId, kept.what, why, options.promptNow(sessionId) === 'typing');
    announce(sessionId);
  };

  /**
   * Writes `line` and resolves once the harness has drawn it and its terminal has stayed quiet for `SETTLE_QUIET_MS`,
   * or after `SETTLE_MAX_MS` whatever it draws.
   */
  const typeAndSettle = (sessionId: string, line: string) =>
    new Promise<void>((resolve) => {
      let cancelQuiet = () => {};
      const done = () => {
        if (settling.get(sessionId) === heard) settling.delete(sessionId);
        cancelQuiet();
        cancelLongest();
        resolve();
      };
      const heard = () => {
        cancelQuiet();
        cancelQuiet = setTimer(done, SETTLE_QUIET_MS);
      };
      const cancelLongest = setTimer(done, SETTLE_MAX_MS);
      settling.set(sessionId, heard);
      options.write(sessionId, line);
    });

  /**
   * Presses Enter, unless `press` is false, and resolves whether the agent's turn started within `ms`. Only one waits
   * per agent: everything typed at an agent, Send too, goes through its one queue (`inTurn`).
   */
  const enterSubmits = (sessionId: string, ms: number, press = true) =>
    new Promise<boolean>((resolve) => {
      const settle = (submitted: boolean) => {
        if (submitting.get(sessionId) === onSubmit) submitting.delete(sessionId);
        cancel();
        resolve(submitted);
      };
      const onSubmit = () => settle(true);
      // Listening before the press: a quick harness's hook may beat the write's return.
      submitting.set(sessionId, onSubmit);
      const cancel = setTimer(() => settle(false), ms);
      if (press) options.write(sessionId, '\r');
    });

  /**
   * Submits what is typed at the agent's prompt, and resolves whether its turn started: presses Enter, and again,
   * waiting longer each time, while no turn starts and the prompt holds only what was typed. Never presses it on a
   * prompt the user is typing at, before the first press too, nor on one that has moved on (a permission prompt, a
   * question), where it would answer something else. With `queue`, an agent found working before the first press
   * gets one Enter, which queues what was typed for after its turn, as the user's own would; no turn starts on it
   * now, so none is waited for, and `queue` keeps it for the turn's end to check on. Unless the turn starts, `gaveUp`
   * says what then: after the last press, or on finding the prompt typed at, or moved on (or working, without `queue`)
   * before the first (nothing was submitted). It presses `retries` more times after the first, the wait doubling up to
   * `MAX_SUBMIT_WAITS` confirm times.
   */
  const pressEnter = async (
    sessionId: string,
    gaveUp: (now: PromptNow) => boolean,
    { queue, retries = SUBMIT_RETRIES }: { queue?: () => void; retries?: number } = {},
  ): Promise<boolean> => {
    for (let attempt = 0; ; attempt += 1) {
      // The daemon closed meanwhile: its database with it.
      if (closed) return false;
      const now = options.promptNow(sessionId);
      // Moved on after a press: its turn started though no hook said so, or its session is gone.
      if ((now === 'moved-on' || now === 'working') && attempt > 0) return true;
      if (now === 'working' && queue !== undefined) {
        options.write(sessionId, '\r');
        queue();
        return true;
      }
      if (now !== 'at-prompt' || attempt > retries) return gaveUp(now);
      if (attempt > 0) options.log(`pressing Enter again at ${sessionId}'s prompt: no turn started`);
      if (await enterSubmits(sessionId, confirmMs * Math.min(2 ** attempt, MAX_SUBMIT_WAITS))) return true;
    }
  };

  /** Resolves after `ms`. */
  const pause = (ms: number) => new Promise<void>((resolve) => void setTimer(resolve, ms));

  /** Runs `step` after whatever is still being typed at the agent: two typed at once would run together. */
  const inTurn = async <T>(sessionId: string, step: () => Promise<T>): Promise<T> => {
    const mine = (answering.get(sessionId) ?? Promise.resolve()).then(step);
    const tail = mine.then(
      () => {},
      () => {},
    );
    answering.set(sessionId, tail);
    try {
      return await mine;
    } finally {
      if (answering.get(sessionId) === tail) answering.delete(sessionId);
    }
  };

  /**
   * Types `line` at the agent's prompt once its turn in the queue comes, and submits it once it has landed, so it isn't
   * taken as a pasted line; `what` names it if it is never sent. Types nothing while the prompt holds a message never
   * sent, or `stillReady` says why not now (the agent went to work meanwhile): it says why instead, never losing the
   * line by throwing. With `midTurn`, as for the user's answers, a turn under way takes it as queued (`pressEnter`):
   * given as the message it is, it is held until its harness takes it up (`held`), and handed back if its session ends
   * first.
   */
  const typeInput = (
    sessionId: string,
    line: string,
    what: string,
    stillReady: () => string | undefined = () => undefined,
    midTurn: boolean | InTurnMessage = false,
  ) =>
    inTurn(sessionId, () => typeNow(sessionId, line, what, stillReady, { midTurn }));

  /**
   * Types `line` at the agent's prompt now and submits it, as `typeInput` does once its turn in the queue comes,
   * pressing Enter `retries` more times while no turn starts (`pressEnter`).
   */
  const typeNow = async (
    sessionId: string,
    line: string,
    what: string,
    stillReady: () => string | undefined,
    { midTurn = false, retries = SUBMIT_RETRIES }: { midTurn?: boolean | InTurnMessage; retries?: number } = {},
  ): Promise<Typed> => {
    const reason = unsent.has(sessionId) ? UNSENT_REASON : stillReady();
    if (reason !== undefined) return { typed: false, reason };
    // Marked before it is typed: a harness may take it up as soon as it is submitted.
    const taken = typeof midTurn === 'object' ? options.promptsFromNow?.(sessionId) : undefined;
    await typeAndSettle(sessionId, line);
    // Measured at Claude, where Ctrl-U clears one wrapped row; not at Codex, which keeps its count by lines.
    const lines = getRow(sessionId)?.harness === 'claude' ? promptRows(line) : line.split('\r').length;
    let inTurn = false;
    let why: string | undefined;
    // Two queued in one turn may go up as one message: the second Enter landed on the first's text.
    const queue = () => {
      inTurn = true;
      const before = queued.get(sessionId);
      const text = oneLine(submittedText(line));
      queued.set(sessionId, { what: before?.what ?? what, lines: (before?.lines ?? 0) + lines, text, count: (before?.count ?? 0) + 1 });
      if (typeof midTurn !== 'object') return;
      const message: HeldMessage = { message: midTurn, submits: withoutTabs(text), turnsEnded: 0, ...(taken === undefined ? {} : { taken }) };
      held.set(sessionId, [...(held.get(sessionId) ?? []), message]);
    };
    const sent = await pressEnter(
      sessionId,
      (now) => {
        why = whyGaveUp(now, retries);
        options.log(`${what} to ${sessionId} was typed at its prompt but not sent: ${why}`);
        // A session that has ended has no prompt to hold it: kept, it would stop whatever its next session is sent.
        if (getRow(sessionId)?.ended_at === null) setUnsent(sessionId, { what, lines }, why);
        return false;
      },
      { ...(midTurn ? { queue } : {}), retries },
    );
    return { typed: true, sent, ...(inTurn ? { inTurn } : {}), ...(why === undefined ? {} : { why }) };
  };

  /**
   * What to write for `input` (`answerInput`) at the agent's prompt. Claude folds a long paste and marks it as pasted, so
   * it goes as smaller ones (`pastePieces`); from what is known of Codex, it expands one as it submits it, with no wrapper,
   * so it goes whole.
   */
  const inputFor = (sessionId: string, input: string): string => (getRow(sessionId)?.harness === 'claude' ? pastePieces(input).join('') : input);

  /**
   * Types `text` at the agent's prompt as one line (a long one pasted, `answerInput`) and submits it, as `typeInput`
   * does: a turn that started meanwhile takes it as queued, as for the user's answers (`midTurn`).
   */
  const typeLine = (sessionId: string, text: string, what: string, stillReady?: () => string | undefined) =>
    typeInput(sessionId, inputFor(sessionId, answerInput(oneLine(text))), what, stillReady, true);

  /**
   * Why the agent's unsent message can't be sent from the board now, or with `clearing` cleared, or undefined if it
   * can. Clearing a prompt the user typed at too is theirs to ask (`byUser`): it clears their words with it.
   */
  const whyNotNow = (sessionId: string, clearing = false, byUser = true): string | undefined => {
    const { name, endedAt } = requireAgent(sessionId);
    if (endedAt !== null) return `${name} has ended`;
    if (!unsent.has(sessionId)) return `${name} has no unsent message at its prompt`;
    if (sending.has(sessionId)) return `${name}'s unsent message is being sent`;
    const now = options.promptNow(sessionId);
    if (now === 'typing' && !(clearing && byUser)) return `${byUser ? 'you are' : 'the user is'} typing in ${name}'s terminal`;
    if (now === 'moved-on' || now === 'working') return `${name} is not at its prompt`;
    return undefined;
  };

  /**
   * Why the user's answer, its turn in the queue come, can't be typed at the agent now: it ended, or a permission
   * prompt or question came up while it waited, where its keys would answer that instead.
   */
  const whyNotAnswer = (sessionId: string): string | undefined => {
    const agent = requireAgent(sessionId);
    const { name, endedAt, state, lastMessage } = agent;
    if (endedAt !== null) return `${name} has ended`;
    if (options.promptNow(sessionId) !== 'moved-on') return undefined;
    if (state === 'needs-permission') return `${name} needs permission first`;
    const asking = questionPrompt(agent);
    if (asking !== undefined) return askingQuestions(name, asking);
    // Its harness may show a menu of what to do about it, where Enter would pick one.
    if (state === 'rate-limited') return `${name} is rate-limited: answer it in its terminal, or Continue on credits`;
    // Claude asked for input (`agent_needs_input`): a question of its turn, or a dialog of its own, which Enter would answer.
    const question = lastMessage === null ? '' : `, "${cutText(oneLine(lastMessage), 120)}"`;
    return `${name} is waiting on a question or dialog of its own${question}: answer it in its terminal`;
  };

  /**
   * Keeps what was queued in the agent's turn, cut short with no Enter to be pressed, as its unsent message: the turn
   * was interrupted (the harness may have put it back at the prompt, as Claude Code does on Escape), or rate limited.
   */
  const cutShort = (sessionId: string, why: string) => {
    const kept = queued.get(sessionId);
    if (kept === undefined) return;
    queued.delete(sessionId);
    // Left at its prompt as unsent: the user's to send or clear now.
    held.delete(sessionId);
    options.log(`${kept.what} queued at ${sessionId} was ${why} with its turn`);
    // The user's own interrupt is theirs to follow up; a rate limit is not.
    setUnsent(sessionId, kept, why === 'rate-limited' ? RATE_LIMITED_REASON : undefined);
    if (why === 'interrupted') interruptedWith.add(sessionId);
  };

  /**
   * Why a run or hand-off can't be typed at the live agent `row` now: its session isn't up yet, `whyNotReady` (held by
   * a draft past its hold too, but with `lapsedDrafts` false), or the user pressed a key in its terminal lately
   * (`typedLately`).
   */
  const whyNotReadyNow = (sessionId: string, row: Row, evenAsking?: boolean, lapsedDrafts?: boolean): string | undefined =>
    notUp.get(sessionId)?.reason ?? whyNotReady(row, evenAsking, lapsedDrafts) ?? (typedLately(sessionId) ? USER_TYPING_REASON : undefined);

  /** Why a run or hand-off whose turn in the queue has come can't be typed at the agent now (`whyNotReadyNow`). */
  const stillReady = (sessionId: string, evenAsking: boolean, lapsedDrafts?: boolean): string | undefined => {
    const row = getRow(sessionId);
    if (row === undefined) return 'the agent has been deleted';
    return row.ended_at !== null ? 'its session has ended' : whyNotReadyNow(sessionId, row, evenAsking, lapsedDrafts);
  };

  /**
   * Keeps `item` until the agent's turn ends, or the user at its prompt stops typing (`deliverAfterTurn`), in the store
   * too (`waiting`), so it outlives the daemon.
   */
  const queueAfterTurn = (sessionId: string, item: AfterTurn) => {
    const { text, from, about, lost } = item;
    const keptAs = options.waiting?.add(sessionId, {
      text,
      ...(from === undefined ? {} : { from }),
      ...(about === undefined ? {} : { about }),
      ...(lost === undefined ? {} : { lost }),
    });
    afterTurn.set(sessionId, [...(afterTurn.get(sessionId) ?? []), { ...item, ...(keptAs === undefined ? {} : { keptAs }) }]);
    announce(sessionId);
  };

  /**
   * Types a scheduled run's `prompt` at the agent, once nothing is typed ahead of it and it is still ready
   * (`stillReady`). `notTyped` hears if it never is, as no turn of it will end.
   */
  const startRun = (sessionId: string, prompt: string, notTyped?: (reason: string) => void) =>
    void typeLine(sessionId, prompt, 'A scheduled run', () => stillReady(sessionId, false)).then(
      (typed) => {
        if (typed.typed) return;
        options.log(`skipped a run of ${sessionId}: ${typed.reason}`);
        notTyped?.(typed.reason);
      },
      (error: Error) => {
        options.log(`could not start a run of ${sessionId}: ${error.message}`);
        notTyped?.(error.message);
      },
    );

  /**
   * Per agent, its scheduled run held as the user pressed a key in its terminal lately (`typedLately`) with nothing
   * typed there: typed once they have been idle for `userIdleMs`. Given up on, `notTyped` told why, if they press Enter
   * first (a turn of theirs may start, whose end its clock would take for the run's) or its session goes.
   */
  const heldRuns = new Map<string, { prompt: string; notTyped?: (reason: string) => void }>();
  /** Gives up on the agent's held run, if it has one, telling its clock why. */
  const giveUpRun = (sessionId: string, reason: string) => {
    const held = heldRuns.get(sessionId);
    if (held === undefined) return;
    heldRuns.delete(sessionId);
    options.log(`skipped a run of ${sessionId}: ${reason}`);
    held.notTyped?.(reason);
  };
  /** Types the agent's held run, the user idle at last, if it is still ready for it (`startRun`). */
  const releaseRun = (sessionId: string) => {
    const held = heldRuns.get(sessionId);
    if (held === undefined) return;
    heldRuns.delete(sessionId);
    startRun(sessionId, held.prompt, held.notTyped);
  };

  /**
   * Types `line` at the agent whose session isn't up yet once it is, after its first prompt and whatever else came
   * before it, as the user's own message is: an agent at work on its first prompt takes it as queued for after that
   * turn (`pressEnter`). One relaunched before it came up waits on for its new session, behind that one's first prompt.
   * Resolves with how it went: not typed if its session ends first, or holds its first prompt unsent, or a permission
   * prompt or question is up when its turn comes (`whyNotAnswer`), which its caller hands back (`undelivered`), never
   * dropping it. Messages and scheduled runs only: a hand-off is busy until the agent is up, for its edge to retry.
   * `typing` hears once it starts being typed: from then on it is the agent's prompt's, never handed back.
   */
  const queueUntilUp = async (sessionId: string, line: string, what: string, typing: () => void, from?: string): Promise<Typed | { heldForUser: true }> => {
    options.log(`${what} to ${sessionId} is queued until its session is up`);
    recount(waitingUp, sessionId, 1);
    announce(sessionId);
    try {
      for (;;) {
        let heldForUser = false;
        const whyNot = () => {
          const refused = notUp.get(sessionId)?.reason ?? whyNotAnswer(sessionId);
          // Another agent's message never runs into what the user is typing there: kept until they stop.
          heldForUser = refused === undefined && from !== undefined && userTyping(sessionId);
          const reason = refused ?? (heldForUser ? USER_TYPING_REASON : undefined);
          // Typed next, as nothing stands in its way.
          if (reason === undefined) typing();
          return reason;
        };
        const typed = await typeInput(sessionId, line, what, whyNot, true);
        if (heldForUser) return { heldForUser: true };
        if (typed.typed || !notUp.has(sessionId)) {
          if (!typed.typed) options.log(`${what} queued for ${sessionId} until it was up was not typed: ${typed.reason}`);
          return typed;
        }
      }
    } catch (error) {
      // The agent was deleted meanwhile (`whyNotAnswer` found none).
      return { typed: false, reason: (error as Error).message };
    } finally {
      recount(waitingUp, sessionId, -1);
      // Its daemon closed meanwhile: nothing is told.
      try {
        announce(sessionId);
      } catch (error) {
        options.log(`could not tell clients of ${sessionId}'s queued messages: ${(error as Error).message}`);
      }
    }
  };

  /**
   * Queues `text`, typed as `line`, for the agent not up yet (`queueUntilUp`), handing it to `undelivered` if it is
   * never typed: the sender has heard it was queued, so it is never dropped unsaid. `notTyped` hears why too: a
   * scheduled run's clock, whose run would otherwise wait on a turn that never starts. Another agent's (`from`), the
   * user typing at its prompt once it is up, waits with its messages until they stop (`queueAfterTurn`).
   */
  const queueOrHandBack = (
    sessionId: string,
    line: string,
    what: string,
    text: string,
    trail?: SendTrail,
    notTyped?: (reason: string) => void,
    from?: string,
  ) => {
    const item = { sessionId, what, text, ...(trail === undefined ? {} : { trail }), ...(from === undefined ? {} : { from }) };
    queuedItems.add(item);
    void queueUntilUp(
      sessionId,
      line,
      what,
      () => {
        queuedItems.delete(item);
        trail?.('typing at its prompt, its session up');
      },
      from,
    )
      .then((typed) => {
        if ('heldForUser' in typed) {
          // The daemon closing handed it back already.
          if (!queuedItems.delete(item)) return;
          trail?.('not typed: the user is typing at its prompt, kept until they stop');
          queueAfterTurn(sessionId, {
            text,
            ...(from === undefined ? {} : { from }),
            typing: () => trail?.('typing at its prompt, the user idle'),
            settled: (started, why) => trail?.(started ? 'turn started on it' : (why ?? 'no turn started on it')),
          });
          return;
        }
        if (typed.typed) return trailTyped(trail, typed);
        // The daemon closing handed it back already.
        if (!queuedItems.delete(item)) return;
        trailTyped(trail, typed);
        options.undelivered(sessionId, what, text, typed.reason, from);
        notTyped?.(typed.reason);
      })
      .catch((error: Error) => options.log(`could not keep ${what} for ${sessionId}, never delivered: ${error.message}`));
  };

  /**
   * Hands back everything waiting for the agent's turn to end (`undelivered`), and why: its sender heard it was queued,
   * so it is never dropped unsaid. Nothing is handed back for an agent deleted meanwhile, which has nowhere to show it,
   * nor a board notice (`about`), which nobody sent.
   */
  const handBackAfterTurn = (sessionId: string, reason: string) => {
    const items = afterTurn.get(sessionId);
    if (items === undefined) return;
    afterTurn.delete(sessionId);
    for (const item of items) {
      try {
        unkeep(item);
        if (item.about === undefined) options.undelivered(sessionId, 'A message', item.text, reason, item.from);
        else options.log(`a notice for ${sessionId} about ${item.about} was dropped, never typed: ${reason}`);
      } catch (error) {
        options.log(`could not keep a message for ${sessionId}, never delivered: ${(error as Error).message}`);
      }
      item.settled(false, `handed back: ${reason}`);
    }
    try {
      announce(sessionId);
    } catch (error) {
      options.log(`could not tell clients of ${sessionId}'s waiting messages: ${(error as Error).message}`);
    }
  };

  /** Whether the agent's transcript says its harness took up the message held in its turn: read now, at once. */
  const heldTaken = (sessionId: string, one: HeldMessage): boolean => {
    try {
      return one.taken?.().some((prompt) => promptHolds(prompt, one.submits)) ?? false;
    } catch (error) {
      options.log(`could not read ${sessionId}'s transcript for a message held in its turn: ${(error as Error).message}`);
      return false;
    }
  };

  /** Sets the messages still held in the agent's turn, of those it held (`held`). */
  const keepHeld = (sessionId: string, left: HeldMessage[]) => {
    if (left.length > 0) held.set(sessionId, left);
    else held.delete(sessionId);
  };

  /**
   * The agent's turn ended: lets go of the messages held in it that its harness took up at a step of it (as Claude
   * does, with no `UserPromptSubmit`), and of those held since the turn before, taken up some way unseen.
   */
  const heldAtTurnEnd = (sessionId: string) => {
    const messages = held.get(sessionId);
    if (messages === undefined) return;
    keepHeld(
      sessionId,
      messages.filter((one) => {
        if (heldTaken(sessionId, one)) return false;
        one.turnsEnded += 1;
        if (one.turnsEnded < HELD_TURNS) return true;
        options.log(`a message held in ${sessionId}'s turn was not seen taken up by the end of the turn after: let go`);
        return false;
      }),
    );
  };

  /**
   * Hands back the messages typed into the agent's turn that its harness hasn't taken up (`held`), its queue gone with
   * its session or the daemon, as not delivered (`undelivered`), each to whoever sent it: never lost unsaid. One its
   * transcript shows taken up is in the agent's conversation already, and stays there: handed back, it would go twice.
   */
  const handBackInTurn = (sessionId: string, reason: string) => {
    const messages = held.get(sessionId) ?? [];
    held.delete(sessionId);
    for (const one of messages) {
      if (heldTaken(sessionId, one)) {
        options.log(`a message held in ${sessionId}'s turn is in its transcript, taken up: not handed back`);
        continue;
      }
      const { text, from } = one.message;
      try {
        options.undelivered(sessionId, 'A message', text, reason, from);
      } catch (error) {
        options.log(`could not keep a message for ${sessionId}, never delivered: ${(error as Error).message}`);
      }
    }
  };

  /** `answer`, telling `trail` of each step but a refusal, which `answer` tells it of. */
  const answerWith = async (sessionId: string, text: string, paste: boolean, trail: SendTrail | undefined, from?: string): Promise<Answered> => {
    // A pause under way ends first: the message then wakes the agent, never typed into a terminal that is going.
    const pausing = options.pausing(sessionId);
    if (pausing !== undefined) await pausing;
    const agent = requireAgent(sessionId);
    if (agent.state === 'hibernated') {
      if (oneLine(text) === '') throw invalidParams('the answer must not be empty');
      const row = getRow(sessionId)!;
      // Its first prompt, typed once its session is up, carries on this message's trail.
      if (trail !== undefined) wakeTrails.set(sessionId, trail);
      if (from !== undefined) wakeSenders.set(sessionId, from);
      const woken = relaunch(row, text, 'to wake it for a message', row.harness_session_id);
      if (!woken.started) {
        wakeTrails.delete(sessionId);
        wakeSenders.delete(sessionId);
        throw invalidParams(`${agent.name} can't be woken: ${woken.reason}`);
      }
      trail?.('waking it with it, to be typed once its session is up');
      return { queued: false, woken: true };
    }
    if (agent.endedAt !== null) throw invalidParams(`${agent.name} has ended`);
    // Its state says so while any permission prompt, its own or a subagent's, is pending.
    if (agent.state === 'needs-permission') throw invalidParams(`${agent.name} needs permission first`);
    // Claude's question dialog is up: typed keys would pick its answers, which only the user does.
    const asking = questionPrompt(agent);
    if (asking !== undefined) throw invalidParams(askingQuestions(agent.name, asking));
    if (oneLine(text) === '') throw invalidParams('the answer must not be empty');
    // One with an image goes whole: a cut through its path would keep the harness from taking it as a dropped file.
    const line = paste ? answerInput(text, true) : inputFor(sessionId, answerInput(text));
    if (notUp.has(sessionId)) {
      trail?.('queued until its session is up');
      queueOrHandBack(sessionId, line, 'A message', text, trail, undefined, from);
      return { queued: true };
    }
    let heldForUser = false;
    const whyNot = () => {
      // Another agent's message never runs into what the user is typing there: its caller keeps it until they stop.
      const refused = whyNotAnswer(sessionId);
      heldForUser = refused === undefined && from !== undefined && userTyping(sessionId);
      const reason = refused ?? (heldForUser ? USER_TYPING_REASON : undefined);
      // Typed next, as nothing stands in its way.
      if (reason === undefined) trail?.('typing at its prompt');
      return reason;
    };
    const typed = await typeInput(sessionId, line, 'A message', whyNot, { text, ...(from === undefined ? {} : { from }) });
    if (typed.typed) trailTyped(trail, typed);
    if (typed.typed && !typed.sent) return { queued: false, unsent: typed.why ?? UNSENT_REASON };
    if (typed.typed) return typed.inTurn === true ? { queued: false, inTurn: true } : { queued: false };
    if (heldForUser) {
      trail?.('not typed: the user is typing at its prompt');
      return { userTyping: true };
    }
    // Refused, never typed: the caller still has it.
    throw invalidParams(
      typed.reason === UNSENT_REASON ? `${agent.name} has a message typed at its prompt that was never sent: send or clear it first` : typed.reason,
    );
  };

  /** Whether the live agent is being paused: its session is going, so nothing is typed at it. */
  const beingPaused = (row: Row) => row.ended_at === null && row.hibernated_at !== null;

  /**
   * Hands back everything still queued for agents not up yet and not being typed (`undelivered`), as the daemon
   * closes: kept, it is shown once the daemon is back, where the queue itself would go with the daemon's memory. Call
   * before the database closes. One that can't be kept is logged, never holding up the rest. What waits for a turn to
   * end stays in its store (`waiting`), for the next daemon to type; without a store, it is handed back too. So is a
   * message held in a turn and not taken up (`held`): its harness's queue goes with the daemon. A scheduled
   * run held as the user typed is given up on, its clock told.
   */
  const handBackQueued = () => {
    for (const sessionId of [...heldRuns.keys()]) giveUpRun(sessionId, 'the daemon shut down first');
    if (options.waiting === undefined) for (const sessionId of [...afterTurn.keys()]) handBackAfterTurn(sessionId, CLOSED_IN_TURN_REASON);
    for (const sessionId of [...held.keys()]) handBackInTurn(sessionId, CLOSED_IN_TURN_REASON);
    const items = [...queuedItems];
    queuedItems.clear();
    for (const { sessionId, what, text, trail, from } of items) {
      trail?.(`handed back: ${CLOSED_REASON}`);
      try {
        options.undelivered(sessionId, what, text, CLOSED_REASON, from);
      } catch (error) {
        options.log(`could not keep ${what} for ${sessionId}, never delivered: ${(error as Error).message}`);
      }
    }
  };

  return {
    /**
     * Whether anything is being typed or sent at the agent's prompt now, its turn not yet started: a pause would lose
     * it.
     */
    busy: (sessionId: string) => answering.has(sessionId) || sending.has(sessionId),

    /** Whether the agent has a hand-off still landing. */
    isHandingOff: (sessionId: string) => handingOff.has(sessionId),

    /** Forgets the deleted agent's hand-offs still landing, and its unsent or queued message. */
    forget(sessionId: string) {
      forgetKeys(sessionId);
      giveUpRun(sessionId, 'the agent has been deleted');
      // Its Enter loop stops now, not after its wait: what is queued behind it, a relaunch's first prompt too, goes on.
      submitting.get(sessionId)?.();
      for (const item of afterTurn.get(sessionId) ?? []) {
        unkeep(item);
        item.settled(false, 'its agent was deleted');
      }
      afterTurn.delete(sessionId);
      handingOff.delete(sessionId);
      unsent.delete(sessionId);
      sending.delete(sessionId);
      queued.delete(sessionId);
      held.delete(sessionId);
      interruptedWith.delete(sessionId);
    },

    userTyping,

    /** What was typed at the agent's prompt and never sent, if anything: `Hand-off from impl`. */
    unsent: (sessionId: string): string | undefined => unsent.get(sessionId)?.what,

    /**
     * The agent's own turn started or ran (a hook of it: `UserPromptSubmit`, a tool call, `Stop`…): whatever was typed
     * at its prompt has been taken. A hook that only ends a turn (`endsTurn`: Codex's `Interrupt`, or a `Stop` of the
     * turn the user interrupted, already in flight) is no news of a message queued in that turn.
     */
    turnSeen(sessionId: string, endsTurn = false) {
      submitting.get(sessionId)?.();
      if (endsTurn && interruptedWith.has(sessionId)) return;
      if (!sending.has(sessionId)) setUnsent(sessionId, undefined);
    },

    /**
     * The agent's harness submitted `prompt` (its `UserPromptSubmit`): what was queued mid-turn has been taken up if the
     * prompt is it, or, of several queued in one turn (which may go up as one), ends with the last. Another while the
     * agent works is the turn under way's own, its hook late, as a just-started agent's is; one at its prompt is a
     * turn of its own, the user's, so what was queued is gone or in it. Each message held in the turn (`held`) is let
     * go once a prompt holds it, one at a time as a harness may take them.
     */
    promptSubmitted(sessionId: string, prompt: unknown) {
      const holding = held.get(sessionId);
      if (holding !== undefined) keepHeld(sessionId, typeof prompt === 'string' ? holding.filter((one) => !promptHolds(prompt, one.submits)) : []);
      const kept = queued.get(sessionId);
      if (kept === undefined) return;
      const submitted = typeof prompt === 'string' ? withoutTabs(oneLine(prompt)) : undefined;
      const text = withoutTabs(kept.text);
      const taken = submitted === undefined || submitted === text || (kept.count > 1 && submitted.endsWith(` ${text}`));
      if (taken || options.promptNow(sessionId) !== 'working') queued.delete(sessionId);
    },

    /**
     * The agent's own turn ended. With `pressable`, as after its `Stop` or a failed turn, what was queued in it should
     * start a turn of its own now: it gets as long as Enter does to, then Enter is pressed as for anything else typed,
     * and it is kept as unsent if no turn starts at a prompt holding only it. Without, it is kept as unsent at once,
     * with no Enter (`cutShort`): an interrupted turn (the user cut it short, and Send or Clear is theirs), or a rate
     * limited one, whose harness may show a menu of what to do about it, where Enter would pick one. The messages held
     * in the turn stay held until a prompt shows them taken up (`heldAtTurnEnd`), or Enter leaves them unsent.
     */
    turnEnded(sessionId: string, pressable: boolean, why = 'interrupted') {
      heldAtTurnEnd(sessionId);
      const kept = queued.get(sessionId);
      if (kept === undefined) return;
      if (!pressable) return cutShort(sessionId, why);
      const heldThen = held.get(sessionId) ?? [];
      inTurn(sessionId, async () => {
        // Taken up already (`promptSubmitted`).
        if (queued.get(sessionId) !== kept) return;
        queued.delete(sessionId);
        if (await enterSubmits(sessionId, confirmMs, false)) return;
        options.log(`no turn started at ${sessionId} on ${kept.what} queued in the turn that ended`);
        await pressEnter(sessionId, (now) => {
          // Moved on or at work without a hook: it was taken up. The user typing there: whatever is there is theirs.
          if (now !== 'at-prompt') return true;
          options.log(`${kept.what} queued at ${sessionId} was typed at its prompt but not sent: ${whyGaveUp(now)}`);
          setUnsent(sessionId, kept, whyGaveUp(now));
          // Unsent at its prompt: the user's to send or clear now.
          keepHeld(sessionId, (held.get(sessionId) ?? []).filter((one) => !heldThen.includes(one)));
          return false;
        });
      }).catch((error: unknown) => options.log(`pressing Enter on ${kept.what} queued at ${sessionId} failed: ${(error as Error).message}`));
    },

    /**
     * Types `command`, one the harness runs itself at its prompt with no turn (`/effort high`), and presses Enter once it
     * has landed, after whatever is being typed at the agent already: only at a prompt between turns holding nothing,
     * neither a message never sent nor the user's own typing, with nothing up that Enter would answer. As it starts no
     * turn, none is waited for. Resolves undefined once typed, else why not now, for the caller to try again later.
     */
    typeCommand(sessionId: string, command: string): Promise<string | undefined> {
      const notNow = (): string | undefined => {
        const row = getRow(sessionId);
        if (row === undefined || row.ended_at !== null) return 'its session has ended';
        if (unsent.has(sessionId)) return UNSENT_REASON;
        if (queued.has(sessionId) || afterTurn.has(sessionId)) return 'a message waits to be taken up first';
        const now = options.promptNow(sessionId);
        if (now === 'typing') return 'you are typing at its prompt';
        if (now !== 'at-prompt') return 'it is not at its prompt';
        return whyNotReadyNow(sessionId, row, true);
      };
      return inTurn(sessionId, async () => {
        const before = notNow();
        if (before !== undefined) return before;
        await typeAndSettle(sessionId, command);
        // The user started typing meanwhile, or something came up: what is at the prompt is theirs now, to send or clear,
        // and nothing more is typed onto it until they do.
        const after = notNow();
        if (after !== undefined) {
          options.log(`${command} was typed at ${sessionId}'s prompt but not sent: ${after}`);
          if (getRow(sessionId)?.ended_at === null) setUnsent(sessionId, { what: `Reasoning (${command})`, lines: 1 }, whyGaveUp(options.promptNow(sessionId)));
          return after;
        }
        options.write(sessionId, '\r');
        options.log(`typed ${command} at ${sessionId}'s prompt`);
        return undefined;
      });
    },

    /** The agent's terminal printed something. */
    outputSeen(sessionId: string) {
      settling.get(sessionId)?.();
    },

    /**
     * The user typed `data` at the agent's terminal: Enter, Ctrl-C or Ctrl-U there sends or clears its unsent message.
     * Escape or Ctrl-C mid-turn interrupts the turn a message was queued in, as `agent.interrupt` does; Enter or
     * Ctrl-U there is the user's own say over what is at the prompt. Any key starts their idle wait again
     * (`userIdleMs`), a terminal's own reports (focus, the mouse) none.
     */
    typed(sessionId: string, data: string) {
      if (pressesKeys(data)) {
        lastKey.get(sessionId)?.cancel();
        const enter = endsInEnter(data);
        if (enter) giveUpRun(sessionId, 'the user sent a message of their own there first');
        // Idle again: a run held for it is typed, and what else waits for it to be (a message, a crew's flag) on the
        // agent's change (`deliverAfterTurn`, and whoever tells it). A draft left there holds that until its time is up
        // (`draftHeldFor`), when the agent's change comes again.
        const idle = () => {
          lastKey.delete(sessionId);
          releaseRun(sessionId);
          const row = getRow(sessionId);
          if (row === undefined || row.ended_at !== null) return;
          try {
            announce(sessionId);
          } catch (error) {
            options.log(`could not tell clients ${sessionId}'s user is idle: ${(error as Error).message}`);
          }
          const left = options.draftHeldFor?.(sessionId) ?? 0;
          if (left > 0) lastKey.set(sessionId, { at: undefined, cancel: setTimer(idle, left) });
        };
        lastKey.set(sessionId, { at: enter ? undefined : clock.now(), cancel: setTimer(idle, userIdleMs) });
      }
      if (unsent.has(sessionId) && !sending.has(sessionId) && !draftAfterInput(true, data)) setUnsent(sessionId, undefined);
      if (!queued.has(sessionId)) return;
      if (data === '\x1b' || data.includes('\x03')) cutShort(sessionId, 'interrupted');
      else if (!draftAfterInput(true, data)) queued.delete(sessionId);
    },

    /**
     * The agent's session ended (`byShutdown`, as the daemon shuts down): its prompt, and what was typed at it, went
     * with it. A message held in its turn, in its harness's own queue and not taken up, is handed back
     * (`handBackInTurn`).
     */
    ended(sessionId: string, byShutdown = false) {
      submitting.get(sessionId)?.();
      forgetKeys(sessionId);
      giveUpRun(sessionId, 'its session has ended');
      // The daemon going away: what waits for its turn stays in its store, to be typed once the agent is resumed.
      // One whose text went in has left it already (`deliverAfterTurn`): typed once, never twice.
      if (byShutdown && options.waiting !== undefined) {
        for (const item of afterTurn.get(sessionId) ?? []) {
          item.settled(false, item.keptAs === undefined ? 'typed as the daemon shut down, before its turn was seen' : `kept: ${CLOSED_IN_TURN_REASON}`);
        }
      } else {
        handBackAfterTurn(sessionId, byShutdown ? CLOSED_IN_TURN_REASON : 'its session ended before its turn did');
      }
      queued.delete(sessionId);
      handBackInTurn(sessionId, byShutdown ? CLOSED_IN_TURN_REASON : 'its session ended before its turn took it up');
      interruptedWith.delete(sessionId);
      setUnsent(sessionId, undefined);
    },

    /**
     * Sends the agent's unsent message, as the user asked: presses Enter on it as a delivery does, after whatever is
     * being typed at it, and resolves once its turn starts or no Enter starts one. It stays unsent until then, so
     * nothing is typed onto it meanwhile. If no Enter starts a turn, the user's Send takes the prompt as holding nothing
     * to send (an Enter on text submits it, and the harness has long taken it in; they see the prompt): it is no longer
     * unsent. Refuses unless the agent sits at its prompt with nothing the user typed there. Asked by an orchestrator
     * (`byUser` false), which sees no prompt, it stays unsent then: an Enter can be lost, as it was on the message.
     * Resolves with how it went.
     */
    async send(sessionId: string, byUser = true): Promise<UnsentSent> {
      const refused = whyNotNow(sessionId, false, byUser);
      if (refused !== undefined) throw invalidParams(refused);
      sending.add(sessionId);
      return inTurn(sessionId, async () => {
        try {
          let why: string | undefined;
          // Gone unless the user typed at it meanwhile (their words are theirs to send), or it moved on unpressed.
          const gone = await pressEnter(sessionId, (now) => {
            why = now === 'typing' && !byUser ? 'the user typed at its prompt meanwhile' : whyGaveUp(now);
            if (now !== 'at-prompt' || !byUser) return false;
            options.log(`no turn started at ${sessionId}'s prompt on Send: it holds nothing to send`);
            return true;
          });
          // Settled in its own step, so what waits behind it in the queue finds the prompt as it is now.
          if (gone) setUnsent(sessionId, undefined);
          return why === undefined ? { started: true } : { started: false, why };
        } finally {
          sending.delete(sessionId);
        }
      });
    },

    /**
     * Clears the agent's unsent message, as the user asked: clears its lines at the prompt (`clearKeys`), with anything
     * the user typed there, and resolves with the keys written. Refuses as `send` does, but for the user typing there;
     * asked by an orchestrator (`byUser` false), that too, as their words would go with it.
     */
    clear(sessionId: string, byUser = true): string {
      const refused = whyNotNow(sessionId, true, byUser);
      if (refused !== undefined) throw invalidParams(refused);
      const keys = clearKeys(unsent.get(sessionId)!.lines);
      options.write(sessionId, keys);
      setUnsent(sessionId, undefined);
      return keys;
    },

    /**
     * Resumes the rate-limited agent's turn on usage credits, as the user asked: the step its harness offers for it,
     * never typed on its own. Claude Code shows the menu it opens on a rate limit, or its prompt holding `continue`,
     * which it submits by itself at the reset. The menu is closed with Escape, as its own cancel (again while it stays
     * up), which picks no row and leaves Claude's own continue at the reset armed; then `continue` is typed at the
     * empty prompt unless it holds it already, and Enter is pressed, again while no turn starts. `screen` reads the
     * agent's screen. Whether it may is checked again once its turn in the typing queue comes, so a second ask behind
     * the first is refused, and before each Escape after the first, so a turn the user started meanwhile is never
     * interrupted. Resolves once its turn starts; refuses with `invalidParams`, saying why, when the agent is
     * not rate-limited, has a message never sent, the user typing at its prompt or other text there, or shows neither
     * screen, and when no turn starts.
     */
    async continueOnCredits(sessionId: string, screen: () => Promise<string[] | null>) {
      const whyNot = (): string | undefined => {
        const { name, endedAt, state } = requireAgent(sessionId);
        if (endedAt !== null) return `${name} has ended`;
        if (state !== 'rate-limited') return `${name} is not rate-limited: only a turn its usage limit stopped continues on credits`;
        if (unsent.has(sessionId)) return `${name} has a message typed at its prompt that was never sent: answer it in its terminal`;
        if (options.promptNow(sessionId) === 'typing') return `you are typing in ${name}'s terminal`;
        return undefined;
      };
      const before = whyNot();
      if (before !== undefined) throw invalidParams(before);
      const { name } = requireAgent(sessionId);
      const refused = await inTurn(sessionId, async (): Promise<string | undefined> => {
        const now = whyNot();
        if (now !== undefined) return now;
        let shows = readRateLimitScreen((await screen()) ?? []);
        for (let close = 0; shows.kind === 'menu' && close < MENU_CLOSES; close += 1) {
          if (close > 0) {
            await pause(confirmMs);
            // A turn the user started meanwhile is theirs: Escape would interrupt it.
            const meanwhile = whyNot();
            if (meanwhile !== undefined) return meanwhile;
            shows = readRateLimitScreen((await screen()) ?? []);
            if (shows.kind !== 'menu') break;
          }
          await typeAndSettle(sessionId, ESCAPE);
          shows = readRateLimitScreen((await screen()) ?? []);
        }
        if (shows.kind === 'menu') return `${name}'s rate-limit menu did not close: answer it in its terminal`;
        if (shows.kind === 'unknown') return `${name} shows neither its rate-limit menu nor its prompt (${shows.line}): answer it in its terminal`;
        if (shows.holds !== '' && shows.holds !== CONTINUE) return `${name}'s prompt holds other text (${shows.holds}): answer it in its terminal`;
        options.log(`continuing ${sessionId} on credits`);
        if (shows.holds === '') await typeAndSettle(sessionId, CONTINUE);
        for (let attempt = 0; attempt <= SUBMIT_RETRIES; attempt += 1) {
          if (await enterSubmits(sessionId, confirmMs * 2 ** attempt)) return undefined;
          if (requireAgent(sessionId).state !== 'rate-limited') return undefined;
        }
        return `no turn started at ${name}'s prompt on ${CONTINUE}: see its terminal`;
      });
      if (refused !== undefined) throw invalidParams(refused);
    },

    /**
     * Types `prompt` at the just-launched agent's prompt as its first message, once `ready` resolves true (its session
     * is up), ahead of anything else typed at it: so it never sits in the harness's argv, where any `pkill -f` naming a
     * word of it would end the agent. Until `ready` settles, nothing else is typed at the agent, and what is sent to
     * it waits behind it (`queueUntilUp`). Never typed blind: nothing is typed if `ready` resolves false (its session
     * ended first). Kept as its unsent message if no turn starts on it. With no `prompt` (an agent started with no task,
     * or relaunched with no new one), only what was sent to it meanwhile waits for `ready`: a message typed into a
     * harness still loading would sit at its prompt, unsent. A new session's prompt holds nothing, so what the last one
     * left there is forgotten; a first prompt refused once its session is up is handed back (`undelivered`).
     */
    firstPrompt(sessionId: string, prompt: string | undefined, ready: Promise<boolean>) {
      setUnsent(sessionId, undefined);
      const trail = wakeTrails.get(sessionId);
      wakeTrails.delete(sessionId);
      const from = wakeSenders.get(sessionId);
      wakeSenders.delete(sessionId);
      const settled = ready.then(
        (up) => up,
        () => false,
      );
      const entry = { settled, reason: prompt === undefined ? NOT_UP_REASON : NOT_UP_FIRST_REASON };
      notUp.set(sessionId, entry);
      void settled.then(() => notUp.get(sessionId) === entry && notUp.delete(sessionId));
      const ended = () => (getRow(sessionId)?.ended_at === null ? undefined : 'its session has ended');
      inTurn(sessionId, async () => {
        if (!(await settled) || prompt === undefined) {
          trail?.('not typed: its session ended before it was up');
          return;
        }
        typingFirst.add(sessionId);
        try {
          const stillUp = () => {
            const reason = ended();
            if (reason === undefined) trail?.('typing at its prompt, its session up');
            return reason;
          };
          const typed = await typeNow(sessionId, inputFor(sessionId, answerInput(prompt, true)), FIRST_PROMPT, stillUp, { retries: FIRST_PROMPT_SUBMIT_RETRIES });
          trailTyped(trail, typed);
          if (!typed.typed) options.undelivered(sessionId, FIRST_PROMPT, prompt, typed.reason, from);
        } finally {
          typingFirst.delete(sessionId);
        }
      }).catch((error: unknown) => options.log(`typing ${sessionId}'s first prompt failed: ${(error as Error).message}`));
    },

    /** Resolves once the agent's session is up (true) or ended before it was (false); at once, true, if it is up now. */
    untilUp: (sessionId: string): Promise<boolean> => notUp.get(sessionId)?.settled ?? Promise.resolve(true),

    /** Why nothing is typed at the agent yet, its session not up (`NOT_UP_REASON`), or undefined once it is. */
    whyNotUp: (sessionId: string): string | undefined => notUp.get(sessionId)?.reason,

    /** Whether the agent's first prompt is being typed now (`typingFirst`). */
    isTypingFirst: (sessionId: string) => typingFirst.has(sessionId),

    /** Hands back everything still queued as the daemon closes (`handBackQueued`); `close` does it first. */
    handBackQueued,

    /**
     * As the daemon closes, before its database does: hands back what is queued (`handBackQueued`), then cancels every
     * timer a delivery waits on (Enter's wait for a turn to start, typed text settling, a pause), and sets none after,
     * so nothing pending presses Enter or reads an agent's prompt from the closed database.
     */
    close() {
      handBackQueued();
      closed = true;
      for (const cancel of [...timers]) cancel();
      timers.clear();
    },

    /** How many messages sent to the agent before its session was up still wait to be typed (`queueUntilUp`). */
    queuedUntilUp: (sessionId: string): number => waitingUp.get(sessionId) ?? 0,

    /**
     * How many messages sent to the agent mid-turn still wait for a turn of its to end (`queueAfterTurn`), the one being
     * typed now included.
     */
    waitingAfterTurn: (sessionId: string): number => afterTurn.get(sessionId)?.length ?? 0,

    /**
     * Keeps `item` for the live agent mid-turn, to be typed once a turn of its has ended and it is ready for its next
     * message (`deliverAfterTurn`), after those kept before it: never typed into a turn, a question or a dialog. Kept
     * in memory: as the daemon closes, it is handed back as not delivered (`handBackQueued`).
     */
    queueAfterTurn,

    /**
     * Drops the board notices waiting for the agent that are `about` another (`AfterTurn.about`), but one being typed
     * now: a newer one, or the agent's own new message to it, says what they said. Resolves with how many messages the
     * notices that went said were not delivered (`lost`).
     */
    dropNotices(sessionId: string, about: string): number {
      const items = afterTurn.get(sessionId);
      if (items === undefined) return 0;
      const typingNow = typingAfterTurn.has(sessionId) ? items[0] : undefined;
      const dropped = items.filter((item) => item.about === about && item !== typingNow);
      if (dropped.length === 0) return 0;
      let lost = 0;
      for (const item of dropped) {
        unkeep(item);
        item.settled(false, 'dropped: a newer message to the same agent says what it said');
        lost += item.lost ?? 1;
      }
      const kept = items.filter((item) => !dropped.includes(item));
      if (kept.length === 0) afterTurn.delete(sessionId);
      else afterTurn.set(sessionId, kept);
      announce(sessionId);
      return lost;
    },

    /**
     * Types the oldest message waiting for the agent's turn to end, if it is ready for its next message now (`tell`'s
     * test, even asking): each starts a turn of its own, so the next waits for that one to end, and the caller calls
     * again on the agent's next change. Hands them all back if it ended or is being paused; one typed whose Enter
     * started no turn is its unsent message, which the user is told of, as for any other.
     */
    deliverAfterTurn(sessionId: string) {
      const items = afterTurn.get(sessionId);
      if (items === undefined || typingAfterTurn.has(sessionId)) return;
      const row = getRow(sessionId);
      if (row === undefined) return;
      if (row.ended_at !== null) return handBackAfterTurn(sessionId, 'its session ended before its turn did');
      if (beingPaused(row)) return handBackAfterTurn(sessionId, 'it was paused before its turn ended');
      // A draft held past its time (`draftHeldFor`) holds a waiting message no longer: the board may have it wrong.
      if (unsent.has(sessionId) || whyNotReadyNow(sessionId, row, true, false) !== undefined) return;
      // Kept first in line while it is typed, so it is counted, a send meanwhile goes behind it, and a hand-back (its
      // session ending, the daemon closing) takes it too.
      const item = items[0]!;
      /** Takes `item` off the line once typed or given up on; false if a hand-back took it first, and settled it. */
      const take = () => {
        const now = afterTurn.get(sessionId);
        if (now?.[0] !== item) return false;
        if (now.length === 1) afterTurn.delete(sessionId);
        else afterTurn.set(sessionId, now.slice(1));
        unkeep(item);
        return true;
      };
      /** Why not now, or nothing as its text goes in: out of the store then, so a restart before its turn is seen never types it twice. */
      const ready = () => {
        const reason = stillReady(sessionId, true, false);
        if (reason === undefined) unkeep(item);
        return reason;
      };
      typingAfterTurn.add(sessionId);
      item.typing();
      void typeInput(sessionId, inputFor(sessionId, answerInput(item.text)), 'A message', ready)
        .then(
          (typed) => {
            if (!typed.typed) {
              // It went to work or asked before it was typed: still first in line, for its next turn's end. One whose
              // session ended meanwhile is handed back as it ends, or was already.
              if (afterTurn.get(sessionId)?.[0] === item) item.settled(false, `not typed, still waiting: ${typed.reason}`);
              return;
            }
            if (take()) item.settled(typed.sent, typed.why ?? 'no turn started on it');
          },
          (error: Error) => {
            options.log(`could not type a waiting message at ${sessionId}: ${error.message}`);
            if (!take()) return;
            // The error itself is for the log: the user is told plainly.
            if (item.about === undefined) options.undelivered(sessionId, 'A message', item.text, 'it could not be typed', item.from);
            item.settled(false, 'it could not be typed');
          },
        )
        .catch((error: Error) => options.log(`could not keep a message for ${sessionId}, never delivered: ${error.message}`))
        .finally(() => {
          typingAfterTurn.delete(sessionId);
          // Its daemon closed meanwhile: nothing is told.
          try {
            announce(sessionId);
          } catch (error) {
            options.log(`could not tell clients of ${sessionId}'s waiting messages: ${(error as Error).message}`);
          }
        });
    },

    /**
     * Sends `text` as the agent's next message. A paused agent is woken with it as its first message (held until its
     * harness starts, never typed into a terminal still starting), carrying on its conversation. One whose session isn't
     * up yet gets it once it is, after its first prompt (`queueUntilUp`): resolves at once, `queued`. Resolves with how
     * it went (`Answered`): one typed whose Enter started no turn is the agent's unsent message, and says why. `from`,
     * the agent that sent it, is told instead of the user if one queued is never typed.
     */
    async answer(sessionId: string, text: string, paste = false, trail?: SendTrail, from?: string): Promise<Answered> {
      try {
        return await answerWith(sessionId, text, paste, trail, from);
      } catch (error) {
        trail?.(`not typed: ${(error as Error).message}`);
        throw error;
      }
    },

    runScheduled(sessionId: string, prompt: string, notTyped?: (reason: string) => void): RunStart {
      const row = getRow(sessionId);
      if (row === undefined) return { started: false, reason: 'the agent has been deleted' };
      // A paused agent carries on its conversation, Codex's too; an ended one starts Codex on a new one, as always.
      if (row.ended_at !== null) return relaunch(row, prompt, 'for its scheduled run', row.hibernated_at === null ? undefined : row.harness_session_id);
      if (beingPaused(row)) return { started: false, reason: 'it was being paused' };
      if (notUp.has(sessionId)) {
        queueOrHandBack(sessionId, inputFor(sessionId, answerInput(oneLine(prompt))), 'A scheduled run', prompt, undefined, notTyped);
        return { started: true, queued: true };
      }
      // A line still being typed, an earlier run's or the user's, starts a turn this one would only queue behind.
      const busy = answering.has(sessionId) || sending.has(sessionId) ? 'a message is being sent to it' : undefined;
      const reason = unsent.has(sessionId)
        ? UNSENT_REASON
        : (whyNotReady(row) ?? busy ?? (heldRuns.has(sessionId) ? 'a run waits for the user to stop typing' : undefined));
      if (reason !== undefined) return { started: false, reason };
      // Started as far as its caller knows: one that turns out not typed is told so, as no turn of it will end.
      if (typedLately(sessionId)) {
        options.log(`a run of ${sessionId} waits for the user to stop typing at its prompt`);
        heldRuns.set(sessionId, { prompt, ...(notTyped === undefined ? {} : { notTyped }) });
      } else startRun(sessionId, prompt, notTyped);
      return { started: true };
    },

    /**
     * Types `text` for the board at the live agent's prompt (a crew member's flag, to its orchestrator) as a hand-off is
     * delivered: after any line still being typed to it, and only while it is ready for its next message (`whyNotReady`,
     * even asking) and holds no message never sent, so never into a turn, a question or dialog, or the user's
     * half-typed line. Says why not, busy, if it isn't; a caller tries again later.
     */
    async tell(to: string, text: string): Promise<RunStart> {
      const row = getRow(to);
      if (row === undefined) return { started: false, reason: 'the agent has been deleted' };
      if (row.ended_at !== null) return { started: false, reason: 'it has ended' };
      if (beingPaused(row)) return { started: false, reason: 'it was being paused', busy: true };
      const reason = unsent.has(to) ? UNSENT_REASON : whyNotReadyNow(to, row, true);
      if (reason !== undefined) return { started: false, reason, busy: true };
      const typed = await typeInput(to, inputFor(to, answerInput(text)), 'A crew flag', () => stillReady(to, true), true);
      if (!typed.typed) return { started: false, reason: typed.reason, busy: true };
      return typed.sent ? { started: true } : { started: true, unsent: true };
    },

    async deliver(from: string, to: string, name: string, text: string): Promise<RunStart> {
      // A pause under way ends first: the hand-off then wakes the agent.
      const pausing = options.pausing(to);
      if (pausing !== undefined) await pausing;
      const row = getRow(to);
      if (row === undefined) return { started: false, reason: 'the agent has been deleted' };
      if (oneLine(text) === '') return { started: false, reason: 'there was nothing to send' };
      // An agent not up yet is busy, at once (`whyNotReadyNow`): its edge keeps the hand-off and tries again, never
      // holding `from` handing off for as long as the agent takes to come up.
      const reason = row.ended_at !== null ? undefined : unsent.has(to) ? UNSENT_REASON : whyNotReadyNow(to, row, true);
      if (reason !== undefined) return { started: false, reason, busy: true };
      const fromName = getRow(from)?.name ?? 'another agent';
      const line = handOffMessage(fromName, refOf({ sessionId: from }), name, text);
      if (line === undefined) return { started: false, reason: 'there was nothing to send' };
      recount(handingOff, from, 1);
      announce(from);
      try {
        if (row.ended_at !== null) return relaunch(row, line, `for a hand-off from ${from}`, row.harness_session_id);
        const typed = await typeLine(to, line, `Hand-off from ${fromName}`, () => stillReady(to, true));
        if (!typed.typed) return { started: false, reason: typed.reason, busy: true };
        return typed.sent ? { started: true } : { started: true, unsent: true };
      } finally {
        // Deleting `from` meanwhile forgot its count.
        recount(handingOff, from, -1);
        announce(from);
      }
    },
  };
}
