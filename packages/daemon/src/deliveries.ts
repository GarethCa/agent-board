import { systemClock, type Clock } from './clock.ts';
import { recount } from './counts.ts';
import { handoffLine } from './handoff-text.ts';
import { invalidParams } from './params.ts';
import type { Agent } from './protocol.ts';
import type { RunStart } from './schedules.ts';
import { CONTINUE, readRateLimitScreen } from './rate-limit-screen.ts';
import { answerInput, draftAfterInput, oneLine, submittedText } from './terminal-input.ts';
import { cutText } from './text-cut.ts';

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

/** Why nothing is typed at an agent whose session isn't up yet. */
const NOT_UP_REASON = "its session isn't up yet";

/** Why nothing is typed at an agent whose session isn't up yet, with a first prompt to go first once it is. */
const NOT_UP_FIRST_REASON = `${NOT_UP_REASON}: its first prompt goes first`;

/** Why what was queued for an agent not up yet is handed back as the daemon closes (`handBackQueued`). */
const CLOSED_REASON = 'the daemon shut down before it was up';

/** How many more times Enter is pressed before what was typed is called not sent. */
const SUBMIT_RETRIES = 2;

/** The key that closes a TUI's menu, picking none of its rows. */
const ESCAPE = '\x1b';

/** How many times Escape is pressed on the rate-limit menu before giving up: it may take no keys just after it opens. */
const MENU_CLOSES = 3;

/**
 * Why what was typed at an agent's prompt was given up on, its prompt standing at `now`: Enter, pressed again and again,
 * never started a turn; the user typed there meanwhile; a turn started before Enter was pressed; or it moved on (a
 * permission prompt, a question).
 */
const whyGaveUp = (now: PromptNow): string =>
  now === 'at-prompt'
    ? `no turn started on it after ${SUBMIT_RETRIES + 1} presses of Enter`
    : now === 'typing'
      ? 'you typed at its prompt meanwhile'
      : now === 'working'
        ? 'a turn started before Enter was pressed'
        : 'it moved on before Enter was pressed';

/** Why a message queued in a turn its rate limit stopped was given up on: Enter there may pick from Claude's menu. */
const RATE_LIMITED_REASON = 'its turn hit a rate limit';

/** Why nothing more is typed at a prompt holding a message that was never sent: it would run on from it. */
const UNSENT_REASON = 'a message typed at its prompt was never sent';

/**
 * What clears a draft of `lines` lines at a harness's prompt, its cursor at its end, as the board's Clear does with an
 * unsent message: Ctrl-U clears the line up to the cursor, and Backspace at a line's start joins it to the one above,
 * for the next Ctrl-U. Both Claude Code and Codex take these keys so; a paste a harness shows as one placeholder
 * (`[Pasted text +4 lines]`) goes at the first Ctrl-U, and the keys after it do nothing at an empty prompt.
 */
const clearKeys = (lines: number) => `\x15${'\x7f\x15'.repeat(lines - 1)}`;

/** How typing at an agent went: typed, and whether its turn started; or not typed, and why. */
type Typed = { typed: true; sent: boolean } | { typed: false; reason: string };

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
  requireAgent(sessionId: string): Pick<Agent, 'name' | 'endedAt' | 'state' | 'lastMessage'>;
  /** Why a run can't start in the live agent now, or undefined if it can (`evenAsking` as for a hand-off). */
  whyNotReady(row: Row, evenAsking?: boolean): string | undefined;
  /** Relaunches the ended agent with `prompt` as its first message, carrying on Codex conversation `codexSessionId`. */
  relaunch(row: Row, prompt: string | undefined, why: string, codexSessionId?: string | null): RunStart;
  /** Where the agent's prompt stands now. */
  promptNow(sessionId: string): PromptNow;
  /** What resolves once a pause of the agent under way has ended its session; undefined while none is. */
  pausing(sessionId: string): Promise<void> | undefined;
  /** Tells every client the agent changed. */
  announce(sessionId: string): void;
  /**
   * What was sent to the agent before it was up (`what`: `A message`, `A scheduled run`), as `text`, was never typed,
   * and why: its sender heard it was queued, so it is handed back for the user to see and resend.
   */
  undelivered(sessionId: string, what: string, text: string, reason: string): void;
  /**
   * What was typed at the agent's prompt (`what`) was given up on, no Enter starting a turn on it, and why: the user is
   * told, as only their Send or Clear moves it on (in its terminal, with `inTerminal`, as the board's Send refuses a
   * prompt they typed at); or, with no `what`, the agent's prompt holds nothing unsent now.
   */
  notSent?(sessionId: string, what?: string, why?: string, inTerminal?: boolean): void;
  log(message: string): void;
  clock?: Clock;
  /** How long Enter first gets to start a turn (`DEFAULT_SUBMIT_CONFIRM_MS`). */
  submitConfirmMs?: number;
}

/**
 * What is typed at agents' prompts: the user's answers, scheduled runs and other agents' hand-offs, one line after
 * another per agent; an ended agent is relaunched with it instead. Nothing is typed once a permission prompt or a
 * question is up, where its keys would answer that. Each is submitted with Enter once the harness has taken it in, and
 * Enter is pressed again while no turn starts; one still not submitted is kept as the agent's unsent message, which the
 * user sends or clears by hand, and nothing more is typed onto it. Anything typed mid-turn (an answer, or another
 * whose agent started a turn while it was typed) gets one Enter, which the harness queues for after the turn: the turn's end then waits for it to start a turn of its own, as for any other.
 * Pressing Enter again rests on Enter at an empty prompt doing nothing in either harness, as it does in Claude Code and
 * Codex today: a turn whose hook is late is never started twice. Telling an answer queued mid-turn was taken up rests
 * on its `UserPromptSubmit` firing when the harness takes it up, mid-turn or after. Counts the hand-offs each agent has
 * still landing.
 */
export function createDeliveries<Row extends DeliveryRow>(options: DeliveryOptions<Row>) {
  const { getRow, requireAgent, whyNotReady, relaunch, announce } = options;
  const clock = options.clock ?? systemClock;
  const confirmMs = options.submitConfirmMs ?? DEFAULT_SUBMIT_CONFIRM_MS;
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
   * the turn's end.
   */
  const queued = new Map<string, { what: string; lines: number; text: string; count: number }>();
  /**
   * Agents whose unsent message is one queued in a turn the user interrupted: Codex's own `Interrupt` hook, landing
   * after, is no news that it was taken.
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
  const queuedItems = new Set<{ sessionId: string; what: string; text: string }>();

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
        cancelQuiet = clock.setTimer(done, SETTLE_QUIET_MS);
      };
      const cancelLongest = clock.setTimer(done, SETTLE_MAX_MS);
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
      const cancel = clock.setTimer(() => settle(false), ms);
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
   * before the first (nothing was submitted).
   */
  const pressEnter = async (sessionId: string, gaveUp: (now: PromptNow) => boolean, queue?: () => void): Promise<boolean> => {
    for (let attempt = 0; ; attempt += 1) {
      const now = options.promptNow(sessionId);
      // Moved on after a press: its turn started though no hook said so, or its session is gone.
      if ((now === 'moved-on' || now === 'working') && attempt > 0) return true;
      if (now === 'working' && queue !== undefined) {
        options.write(sessionId, '\r');
        queue();
        return true;
      }
      if (now !== 'at-prompt' || attempt > SUBMIT_RETRIES) return gaveUp(now);
      if (attempt > 0) options.log(`pressing Enter again at ${sessionId}'s prompt: no turn started`);
      if (await enterSubmits(sessionId, confirmMs * 2 ** attempt)) return true;
    }
  };

  /** Resolves after `ms`. */
  const pause = (ms: number) => new Promise<void>((resolve) => void clock.setTimer(resolve, ms));

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
   * line by throwing. With `midTurn`, as for the user's answers, a turn under way takes it as queued (`pressEnter`).
   */
  const typeInput = (sessionId: string, line: string, what: string, stillReady: () => string | undefined = () => undefined, midTurn = false) =>
    inTurn(sessionId, () => typeNow(sessionId, line, what, stillReady, midTurn));

  /** Types `line` at the agent's prompt now and submits it, as `typeInput` does once its turn in the queue comes. */
  const typeNow = async (sessionId: string, line: string, what: string, stillReady: () => string | undefined, midTurn: boolean): Promise<Typed> => {
    const reason = unsent.has(sessionId) ? UNSENT_REASON : stillReady();
    if (reason !== undefined) return { typed: false, reason };
    await typeAndSettle(sessionId, line);
    const lines = line.split('\r').length;
    // Two queued in one turn may go up as one message: the second Enter landed on the first's text.
    const queue = () => {
      const before = queued.get(sessionId);
      queued.set(sessionId, {
        what: before?.what ?? what,
        lines: (before?.lines ?? 0) + lines,
        text: oneLine(submittedText(line)),
        count: (before?.count ?? 0) + 1,
      });
    };
    const sent = await pressEnter(sessionId, (now) => {
      options.log(`${what} to ${sessionId} was typed at its prompt but not sent: ${whyGaveUp(now)}`);
      setUnsent(sessionId, { what, lines }, whyGaveUp(now));
      return false;
    }, midTurn ? queue : undefined);
    return { typed: true, sent };
  };

  /**
   * Types `text` at the agent's prompt as one line (a long one pasted, `answerInput`) and submits it, as `typeInput`
   * does: a turn that started meanwhile takes it as queued, as for the user's answers (`midTurn`).
   */
  const typeLine = (sessionId: string, text: string, what: string, stillReady?: () => string | undefined) =>
    typeInput(sessionId, answerInput(oneLine(text)), what, stillReady, true);

  /**
   * Why the agent's unsent message can't be sent from the board now, or with `clearing` cleared, or undefined if it
   * can. Clearing a prompt the user typed at too is theirs to ask: it clears their words with it.
   */
  const whyNotNow = (sessionId: string, clearing = false): string | undefined => {
    const { name, endedAt } = requireAgent(sessionId);
    if (endedAt !== null) return `${name} has ended`;
    if (!unsent.has(sessionId)) return `${name} has no unsent message at its prompt`;
    if (sending.has(sessionId)) return `${name}'s unsent message is being sent`;
    const now = options.promptNow(sessionId);
    if (now === 'typing' && !clearing) return `you are typing in ${name}'s terminal`;
    if (now === 'moved-on' || now === 'working') return `${name} is not at its prompt`;
    return undefined;
  };

  /**
   * Why the user's answer, its turn in the queue come, can't be typed at the agent now: it ended, or a permission
   * prompt or question came up while it waited, where its keys would answer that instead.
   */
  const whyNotAnswer = (sessionId: string): string | undefined => {
    const { name, endedAt, state, lastMessage } = requireAgent(sessionId);
    if (endedAt !== null) return `${name} has ended`;
    if (options.promptNow(sessionId) !== 'moved-on') return undefined;
    if (state === 'needs-permission') return `${name} needs permission first`;
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
    options.log(`${kept.what} queued at ${sessionId} was ${why} with its turn`);
    // The user's own interrupt is theirs to follow up; a rate limit is not.
    setUnsent(sessionId, kept, why === 'rate-limited' ? RATE_LIMITED_REASON : undefined);
    if (why === 'interrupted') interruptedWith.add(sessionId);
  };

  /** Why a run or hand-off can't be typed at the live agent `row` now: its session isn't up yet, or `whyNotReady`. */
  const whyNotReadyNow = (sessionId: string, row: Row, evenAsking?: boolean): string | undefined =>
    notUp.get(sessionId)?.reason ?? whyNotReady(row, evenAsking);

  /** Why a run or hand-off whose turn in the queue has come can't be typed at the agent now (`whyNotReadyNow`). */
  const stillReady = (sessionId: string, evenAsking: boolean): string | undefined => {
    const row = getRow(sessionId);
    if (row === undefined) return 'the agent has been deleted';
    return row.ended_at !== null ? 'its session has ended' : whyNotReadyNow(sessionId, row, evenAsking);
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
  const queueUntilUp = async (sessionId: string, line: string, what: string, typing: () => void): Promise<Typed> => {
    options.log(`${what} to ${sessionId} is queued until its session is up`);
    recount(waitingUp, sessionId, 1);
    announce(sessionId);
    try {
      for (;;) {
        const whyNot = () => {
          const reason = notUp.get(sessionId)?.reason ?? whyNotAnswer(sessionId);
          // Typed next, as nothing stands in its way.
          if (reason === undefined) typing();
          return reason;
        };
        const typed = await typeInput(sessionId, line, what, whyNot, true);
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
   * never typed: the sender has heard it was queued, so it is never dropped unsaid.
   */
  const queueOrHandBack = (sessionId: string, line: string, what: string, text: string) => {
    const item = { sessionId, what, text };
    queuedItems.add(item);
    void queueUntilUp(sessionId, line, what, () => queuedItems.delete(item))
      .then((typed) => {
        // Typed, or the daemon closing handed it back already.
        if (!queuedItems.delete(item)) return;
        if (!typed.typed) options.undelivered(sessionId, what, text, typed.reason);
      })
      .catch((error: Error) => options.log(`could not keep ${what} for ${sessionId}, never delivered: ${error.message}`));
  };

  /** Whether the live agent is being paused: its session is going, so nothing is typed at it. */
  const beingPaused = (row: Row) => row.ended_at === null && row.hibernated_at !== null;

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
      handingOff.delete(sessionId);
      unsent.delete(sessionId);
      sending.delete(sessionId);
      queued.delete(sessionId);
      interruptedWith.delete(sessionId);
    },

    /** What was typed at the agent's prompt and never sent, if anything: `Hand-off from impl`. */
    unsent: (sessionId: string): string | undefined => unsent.get(sessionId)?.what,

    /**
     * The agent's own turn started or ran (a hook of it: `UserPromptSubmit`, a tool call, `Stop`…): whatever was typed
     * at its prompt has been taken. Its `Interrupt` hook (Codex's) is no news of a message queued in the turn the user
     * interrupted.
     */
    turnSeen(sessionId: string, interrupt = false) {
      submitting.get(sessionId)?.();
      if (interrupt && interruptedWith.has(sessionId)) return;
      if (!sending.has(sessionId)) setUnsent(sessionId, undefined);
    },

    /**
     * The agent's harness submitted `prompt` (its `UserPromptSubmit`): what was queued mid-turn has been taken up if the
     * prompt is it, or, of several queued in one turn (which may go up as one), ends with the last. Another while the
     * agent works is the turn under way's own, its hook late, as a just-started agent's is; one at its prompt is a
     * turn of its own, the user's, so what was queued is gone or in it.
     */
    promptSubmitted(sessionId: string, prompt: unknown) {
      const kept = queued.get(sessionId);
      if (kept === undefined) return;
      const submitted = typeof prompt === 'string' ? oneLine(prompt) : undefined;
      const taken = submitted === undefined || submitted === kept.text || (kept.count > 1 && submitted.endsWith(` ${kept.text}`));
      if (taken || options.promptNow(sessionId) !== 'working') queued.delete(sessionId);
    },

    /**
     * The agent's own turn ended. With `pressable`, as after its `Stop` or a failed turn, what was queued in it should
     * start a turn of its own now: it gets as long as Enter does to, then Enter is pressed as for anything else typed,
     * and it is kept as unsent if no turn starts at a prompt holding only it. Without, it is kept as unsent at once,
     * with no Enter (`cutShort`): an interrupted turn (the user cut it short, and Send or Clear is theirs), or a rate
     * limited one, whose harness may show a menu of what to do about it, where Enter would pick one.
     */
    turnEnded(sessionId: string, pressable: boolean, why = 'interrupted') {
      const kept = queued.get(sessionId);
      if (kept === undefined) return;
      if (!pressable) return cutShort(sessionId, why);
      void inTurn(sessionId, async () => {
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
          return false;
        });
      });
    },

    /** The agent's terminal printed something. */
    outputSeen(sessionId: string) {
      settling.get(sessionId)?.();
    },

    /**
     * The user typed `data` at the agent's terminal: Enter, Ctrl-C or Ctrl-U there sends or clears its unsent message.
     * Escape or Ctrl-C mid-turn interrupts the turn a message was queued in, as `agent.interrupt` does; Enter or
     * Ctrl-U there is the user's own say over what is at the prompt.
     */
    typed(sessionId: string, data: string) {
      if (unsent.has(sessionId) && !sending.has(sessionId) && !draftAfterInput(true, data)) setUnsent(sessionId, undefined);
      if (!queued.has(sessionId)) return;
      if (data === '\x1b' || data.includes('\x03')) cutShort(sessionId, 'interrupted');
      else if (!draftAfterInput(true, data)) queued.delete(sessionId);
    },

    /** The agent's session ended: its prompt, and what was typed at it, went with it. */
    ended(sessionId: string) {
      queued.delete(sessionId);
      interruptedWith.delete(sessionId);
      setUnsent(sessionId, undefined);
    },

    /**
     * Sends the agent's unsent message, as the user asked: presses Enter on it as a delivery does, after whatever is
     * being typed at it, and resolves once its turn starts or no Enter starts one. It stays unsent until then, so
     * nothing is typed onto it meanwhile. If no Enter starts a turn, the prompt holds nothing to send (an Enter on text
     * submits it, and the harness has long taken it in): it is no longer unsent. Refuses unless the agent sits at its
     * prompt with nothing the user typed there.
     */
    async send(sessionId: string) {
      const refused = whyNotNow(sessionId);
      if (refused !== undefined) throw invalidParams(refused);
      sending.add(sessionId);
      await inTurn(sessionId, async () => {
        try {
          // Gone unless the user typed at it meanwhile (their words are theirs to send), or it moved on unpressed.
          const gone = await pressEnter(sessionId, (now) => {
            if (now !== 'at-prompt') return false;
            options.log(`no turn started at ${sessionId}'s prompt on Send: it holds nothing to send`);
            return true;
          });
          // Settled in its own step, so what waits behind it in the queue finds the prompt as it is now.
          if (gone) setUnsent(sessionId, undefined);
        } finally {
          sending.delete(sessionId);
        }
      });
    },

    /**
     * Clears the agent's unsent message, as the user asked: clears its lines at the prompt (`clearKeys`), with anything
     * the user typed there, and resolves with the keys written. Refuses as `send` does, but for the user typing there.
     */
    clear(sessionId: string): string {
      const refused = whyNotNow(sessionId, true);
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
     * harness still loading would sit at its prompt, unsent.
     */
    firstPrompt(sessionId: string, prompt: string | undefined, ready: Promise<boolean>) {
      const settled = ready.then(
        (up) => up,
        () => false,
      );
      const entry = { settled, reason: prompt === undefined ? NOT_UP_REASON : NOT_UP_FIRST_REASON };
      notUp.set(sessionId, entry);
      void settled.then(() => notUp.get(sessionId) === entry && notUp.delete(sessionId));
      const ended = () => (getRow(sessionId)?.ended_at === null ? undefined : 'its session has ended');
      inTurn(sessionId, async () => {
        if (!(await settled) || prompt === undefined) return;
        typingFirst.add(sessionId);
        try {
          await typeNow(sessionId, answerInput(prompt, true), 'Its first prompt', ended, false);
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

    /**
     * Hands back everything still queued for agents not up yet and not being typed (`undelivered`), as the daemon
     * closes: kept, it shows with Resend once the daemon is back, where the queue itself would go with the daemon's
     * memory. Call before the database closes. One that can't be kept is logged, never holding up the rest.
     */
    handBackQueued() {
      const items = [...queuedItems];
      queuedItems.clear();
      for (const { sessionId, what, text } of items) {
        try {
          options.undelivered(sessionId, what, text, CLOSED_REASON);
        } catch (error) {
          options.log(`could not keep ${what} for ${sessionId}, never delivered: ${(error as Error).message}`);
        }
      }
    },

    /** How many messages sent to the agent before its session was up still wait to be typed (`queueUntilUp`). */
    queuedUntilUp: (sessionId: string): number => waitingUp.get(sessionId) ?? 0,

    /**
     * Sends `text` as the agent's next message. A paused agent is woken with it as its first message (held until its
     * harness starts, never typed into a terminal still starting), carrying on its conversation. One whose session isn't
     * up yet gets it once it is, after its first prompt (`queueUntilUp`): resolves at once, `queued`.
     */
    async answer(sessionId: string, text: string, paste = false): Promise<{ queued: boolean }> {
      // A pause under way ends first: the message then wakes the agent, never typed into a terminal that is going.
      const pausing = options.pausing(sessionId);
      if (pausing !== undefined) await pausing;
      const agent = requireAgent(sessionId);
      if (agent.state === 'hibernated') {
        if (oneLine(text) === '') throw invalidParams('the answer must not be empty');
        const row = getRow(sessionId)!;
        const woken = relaunch(row, text, 'to wake it for a message', row.harness_session_id);
        if (!woken.started) throw invalidParams(`${agent.name} can't be woken: ${woken.reason}`);
        return { queued: false };
      }
      if (agent.endedAt !== null) throw invalidParams(`${agent.name} has ended`);
      // Its state says so while any permission prompt, its own or a subagent's, is pending.
      if (agent.state === 'needs-permission') throw invalidParams(`${agent.name} needs permission first`);
      if (oneLine(text) === '') throw invalidParams('the answer must not be empty');
      if (notUp.has(sessionId)) {
        queueOrHandBack(sessionId, answerInput(text, paste), 'A message', text);
        return { queued: true };
      }
      const typed = await typeInput(sessionId, answerInput(text, paste), 'A message', () => whyNotAnswer(sessionId), true);
      if (typed.typed) return { queued: false };
      // Refused, never typed: the caller still has it.
      throw invalidParams(
        typed.reason === UNSENT_REASON ? `${agent.name} has a message typed at its prompt that was never sent: send or clear it first` : typed.reason,
      );
    },

    runScheduled(sessionId: string, prompt: string): RunStart {
      const row = getRow(sessionId);
      if (row === undefined) return { started: false, reason: 'the agent has been deleted' };
      // A paused agent carries on its conversation, Codex's too; an ended one starts Codex on a new one, as always.
      if (row.ended_at !== null) return relaunch(row, prompt, 'for its scheduled run', row.hibernated_at === null ? undefined : row.harness_session_id);
      if (beingPaused(row)) return { started: false, reason: 'it was being paused' };
      if (notUp.has(sessionId)) {
        queueOrHandBack(sessionId, answerInput(oneLine(prompt)), 'A scheduled run', prompt);
        return { started: true, queued: true };
      }
      const reason = unsent.has(sessionId) ? UNSENT_REASON : whyNotReadyNow(sessionId, row);
      if (reason !== undefined) return { started: false, reason };
      typeLine(sessionId, prompt, 'A scheduled run', () => stillReady(sessionId, false)).then(
        (typed) => !typed.typed && options.log(`skipped a run of ${sessionId}: ${typed.reason}`),
        (error: Error) => options.log(`could not start a run of ${sessionId}: ${error.message}`),
      );
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
      const typed = await typeInput(to, answerInput(text, false), 'A crew flag', () => stillReady(to, true), true);
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
      const line = handoffLine(fromName, name, text);
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
