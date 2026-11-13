// Permission prompts the needs-you inbox can answer, by holding the harness's PermissionRequest hook open (ADR-0004).
// Harness-agnostic: Claude and Codex both read `hookSpecificOutput.decision.behavior` from the hook's reply.
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  DIALOG_TAKE_MS,
  PLAN_TOOL,
  QUESTION_TOOL,
  type SessionState,
  type PermissionDecision,
  type PermissionPrompt,
  type PromptAnswer,
  type PromptQuestion,
} from './protocol.ts';

/** What a hook call is answered with: a JSON body, or nothing. */
export type HookReply = Record<string, unknown> | undefined;

/**
 * How long a PermissionRequest hook is held for an inbox answer when its harness's terminal waits on the hook (Codex,
 * a Claude subagent): short, as that terminal shows no prompt until the hold lapses (ADR-0004).
 */
export const DEFAULT_PERMISSION_HOLD_MS = 20_000;

/**
 * How long a PermissionRequest hook is held when its harness asks in its terminal at the same time, as Claude does for
 * the agent itself: its dialog shows while the hook is held, and whichever answers first decides (ADR-0004). Holding
 * costs one idle connection and blocks nothing, so it lasts until the prompt is settled (answered on the board, the call
 * run or failed, the turn over); a day is only a safety cap, past a night or a weekend day away.
 */
export const ASKING_PERMISSION_HOLD_MS = 24 * 60 * 60_000;

/**
 * Hooks after which the asker can't still be waiting on an earlier permission: its turn ended (Codex's `Interrupt`
 * ends one with no `Stop`), or a new one began.
 */
const TURN_BOUNDARIES = new Set(['Stop', 'StopFailure', 'Interrupt', 'UserPromptSubmit', 'SubagentStop']);

export interface PermissionHoldsOptions {
  /** How long a request is held while its terminal waits on the hook. */
  holdMs: number;
  /** How long a request is held while its terminal asks too (`asksInTerminal`). */
  askingHoldMs: number;
  /**
   * How long after the board sends a question prompt's answers its call may take to run before the prompt says Claude
   * kept its dialog open (`PromptDialog.keptOpen`). Defaults to `DIALOG_TAKE_MS`.
   */
  dialogTakeMs?: number;
  /** A session's prompts changed on their own: a hold lapsed, the harness gave up on its hook, or Claude kept its dialog open. */
  onChange(sessionId: string): void;
  /**
   * A question prompt whose answers the board sent was settled by its call running without them: Claude took the
   * allow but not its answers, so it carries on as if the user had answered nothing. The prompt is gone; tell the user.
   */
  onAnswersDropped?(sessionId: string): void;
}

export interface PermissionHolds {
  /**
   * Holds a PermissionRequest hook open as a new prompt of the session's. Resolves with the hook's reply: the user's
   * decision, or nothing (so the harness asks in its terminal) once the hold lapses, `signal` aborts, or the request
   * is settled elsewhere. `asksInTerminal`: the harness asks in its terminal while the hook is held, so it is held for
   * the long hold.
   */
  hold(sessionId: string, payload: Record<string, unknown>, signal: AbortSignal, asksInTerminal?: boolean): Promise<HookReply>;
  /** The session's prompts, held or kept as context, oldest first. */
  prompts(sessionId: string): PermissionPrompt[];
  /**
   * Answers the session's prompt `requestId` while it is held. Returns false if it is not (any more), and for a question
   * prompt, which only its answers answer (`sendAnswers`).
   */
  decide(sessionId: string, requestId: string, decision: PermissionDecision): boolean;
  /**
   * Keeps `answer` (null clears it) as the answer to question `index` of the session's question prompt `requestId`,
   * sending nothing. Returns false unless that prompt is held, its answers unsent, and `answer` fits the question.
   */
  answerQuestion(sessionId: string, requestId: string, index: number, answer: PromptAnswer | null): boolean;
  /**
   * Sends the answers kept on the session's question prompt `requestId`: allows its call with them as its
   * `updatedInput`. The prompt stays, no longer held, until its call runs. Returns false unless it is held and every
   * question is answered.
   */
  sendAnswers(sessionId: string, requestId: string): boolean;
  /**
   * Notes another hook of the session's, and settles the prompts it shows were answered elsewhere (in the terminal).
   * Only a hook from the agent or subagent that asked can settle its prompt: the call itself running (a
   * `PostToolUse` or `PostToolUseFailure` of the same tool and input), or the asker's turn ending or a new one starting. Calls running
   * beside it settle nothing. Returns whether any prompt went.
   */
  afterHook(sessionId: string, payload: Record<string, unknown>): boolean;
  /**
   * Releases the held hook of the session's prompt `requestId` with no decision, so the harness asks in its terminal
   * now, as it does when the hold lapses; the prompt stays listed. Returns false if it is not held (any more).
   */
  release(sessionId: string, requestId: string): boolean;
  /** Forgets the session's prompts, releasing their hooks with no decision. */
  drop(sessionId: string): void;
  /** Releases every held hook and stops telling anyone about changes. */
  close(): void;
}

interface Held {
  prompt: PermissionPrompt;
  /** What the harness suggested allowing with this request, to be granted for the session. */
  suggestions: object[];
  /** Answers the hook; gone once it has been answered. */
  reply: ((reply: HookReply) => void) | undefined;
  /** Once its answers are sent: says Claude kept its dialog open if its call hasn't run by then. */
  keptOpenTimer?: ReturnType<typeof setTimeout>;
  /** The answers the board sent, by question, as its `updatedInput.answers`. */
  sent?: Record<string, string>;
}

/** States that outrank a pending permission: the agent has ended, failed or hit a rate limit. */
const OVER_PERMISSIONS = new Set<SessionState>(['done', 'failed', 'rate-limited']);

/**
 * An agent's state given its permission prompts: `needs-permission` while any is `pending`, even if a subagent's or
 * a parallel call's hook says it runs. Once a hook has `settled` its last one, an agent its hooks left at
 * `needs-permission` carries on `running`.
 */
export function stateWithPrompts(state: SessionState, prompts: { pending: number; questions?: number; settled: boolean }): SessionState {
  if (prompts.pending > 0) return OVER_PERMISSIONS.has(state) ? state : 'needs-permission';
  // Questions up in the harness's own dialog: the agent waits on the user's answer, which no permission is.
  if ((prompts.questions ?? 0) > 0) return OVER_PERMISSIONS.has(state) ? state : 'waiting';
  return prompts.settled && state === 'needs-permission' ? 'running' : state;
}

/** How many of `prompts` ask for a permission (`pending`) and how many ask questions, for `stateWithPrompts`. */
export function promptCounts(prompts: readonly PermissionPrompt[]): { pending: number; questions: number } {
  const questions = prompts.filter((prompt) => prompt.questions !== null).length;
  return { pending: prompts.length - questions, questions };
}

/**
 * The questions of a question-tool call (`QUESTION_TOOL`), from its `tool_input`, or null for any other call. Claude's
 * dialog asks them; malformed ones are dropped, and a call with none left is still a question call, with none to show.
 */
export function questionsOf(payload: Record<string, unknown>): PromptQuestion[] | null {
  if (payload.tool_name !== QUESTION_TOOL) return null;
  const input = payload.tool_input;
  const raw = typeof input === 'object' && input !== null && 'questions' in input && Array.isArray(input.questions) ? (input.questions as unknown[]) : [];
  const text = (value: unknown): string => (typeof value === 'string' ? value : '');
  return raw.flatMap((each): PromptQuestion[] => {
    if (typeof each !== 'object' || each === null) return [];
    const { question, header, options, multiSelect } = each as Record<string, unknown>;
    if (typeof question !== 'string' || question === '') return [];
    const picks = (Array.isArray(options) ? options : []).flatMap((option: unknown) => {
      const { label, description } = (typeof option === 'object' && option !== null ? option : {}) as Record<string, unknown>;
      return typeof label === 'string' && label !== '' ? [{ label, description: text(description) }] : [];
    });
    return [{ question, header: text(header), options: picks, multiSelect: multiSelect === true }];
  });
}

/**
 * Whether every question of a question-tool call could be read, so the board can answer the call: none was dropped,
 * each offers an option, and no two ask the same (Claude's `answers` are keyed by the question's text).
 */
function answerable(payload: Record<string, unknown>, questions: readonly PromptQuestion[]): boolean {
  const input = payload.tool_input as { questions?: unknown } | null | undefined;
  const raw = Array.isArray(input?.questions) ? input.questions : [];
  return (
    questions.length > 0 &&
    raw.length === questions.length &&
    questions.every((question) => question.options.length > 0) &&
    new Set(questions.map((question) => question.question)).size === questions.length
  );
}

/** Why `answer` can't answer `question`, in words, or undefined where it can. */
export function answerProblem(question: PromptQuestion, answer: PromptAnswer): string | undefined {
  const has = (option: number) => Number.isInteger(option) && option >= 0 && option < question.options.length;
  if ('text' in answer) return answer.text.trim() === '' ? 'An answer in your own words needs words.' : undefined;
  if ('option' in answer) return has(answer.option) ? undefined : `The question has no option ${answer.option}.`;
  if (!question.multiSelect) return 'The question takes one answer.';
  if (answer.options.length === 0) return 'Pick an option.';
  if (!answer.options.every(has) || new Set(answer.options).size !== answer.options.length) return 'Pick each option once, from those the question has.';
  return undefined;
}

/** `answer` as Claude's dialog would give it: the picked label, several labels joined by ", " in the question's order, or the user's own words. */
function answerWords(question: PromptQuestion, answer: PromptAnswer): string {
  if ('text' in answer) return answer.text.trim();
  const picked = 'option' in answer ? [answer.option] : [...answer.options].sort((a, b) => a - b);
  return picked.map((option) => question.options[option]!.label).join(', ');
}

/** The plan of a plan-tool call (`PLAN_TOOL`), its Markdown, or null for any other call or one with no plan. */
function planOf(payload: Record<string, unknown>): string | null {
  if (payload.tool_name !== PLAN_TOOL) return null;
  const input = payload.tool_input as { plan?: unknown } | null | undefined;
  return typeof input?.plan === 'string' && input.plan.trim() !== '' ? input.plan : null;
}

/**
 * The PermissionRequest hook reply that carries `decision`. Allowing for the session sends the harness's own
 * `suggestions` back as its `updatedPermissions`, each scoped to the session, which is how its TUI's "don't ask again"
 * is granted without writing to a settings file.
 */
export function permissionReply(decision: PermissionDecision, suggestions: readonly object[] = []): Record<string, unknown> {
  const { behavior, message } = decision;
  let answer: Record<string, unknown>;
  if (behavior === 'deny') answer = message !== undefined ? { behavior, message } : { behavior };
  else if (decision.scope === 'session' && suggestions.length > 0) {
    answer = { behavior, updatedPermissions: suggestions.map((suggestion) => ({ ...suggestion, destination: 'session' })) };
  } else answer = { behavior };
  return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: answer } };
}

/**
 * The reply to Claude's plan approval (`PLAN_TOOL`) that carries `decision`, whatever Claude suggested: its approval
 * always says the mode to go on in, as its own dialog's choices do, so the agent never stays in plan mode, where it
 * makes no edits. Allowing for the session is its "Yes, auto-accept edits" (`acceptEdits`); a plain allow is "Yes,
 * approve each edit" (`default`); a deny keeps it planning.
 */
function planReply(decision: PermissionDecision): Record<string, unknown> {
  if (decision.behavior === 'deny') return permissionReply(decision);
  const mode = decision.scope === 'session' ? 'acceptEdits' : 'default';
  return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', updatedPermissions: [{ type: 'setMode', mode, destination: 'session' }] } } };
}

/** What allowing a plan approval for the session grants: auto-accepting edits, which its reply sets itself (`planReply`). */
const PLAN_GRANT = 'all edits';

/** What the harness's rule for `suggestion` allows, in words for a button; undefined where it can't be worded. */
function grantOf(suggestion: Record<string, unknown>): string | undefined {
  if (suggestion.type === 'setMode') return suggestion.mode === 'acceptEdits' ? 'all edits' : undefined;
  if (suggestion.type === 'addDirectories') {
    const dirs = suggestion.directories;
    return Array.isArray(dirs) && dirs.length > 0 && dirs.every((dir) => typeof dir === 'string') ? dirs.join(', ') : undefined;
  }
  if (suggestion.type !== 'addRules' || (suggestion.behavior !== undefined && suggestion.behavior !== 'allow')) return undefined;
  const rules = suggestion.rules;
  if (!Array.isArray(rules) || rules.length === 0) return undefined;
  const words = rules.map((rule: { toolName?: unknown; ruleContent?: unknown } | null) => {
    if (typeof rule?.toolName !== 'string') return undefined;
    if (typeof rule.ruleContent !== 'string' || rule.ruleContent === '') return `all ${rule.toolName} calls`;
    return rule.toolName === 'Bash' ? rule.ruleContent : `${rule.toolName}(${rule.ruleContent})`;
  });
  return words.every((word) => word !== undefined) ? words.join(', ') : undefined;
}

/**
 * What allowing the request's suggestions for the session grants, in words ("npm run:*", "all edits"), or null where
 * there are none or one can't be worded: the button must say what it grants, so it isn't offered for what it can't.
 */
function sessionGrantOf(suggestions: readonly object[]): string | null {
  const grants = suggestions.map((suggestion) => grantOf(suggestion as Record<string, unknown>));
  return grants.length === 0 || grants.some((grant) => grant === undefined) ? null : grants.join(' and ');
}

/** The permission updates the harness suggested with a request (Claude's `permission_suggestions`), as objects. */
function suggestionsOf(payload: Record<string, unknown>): object[] {
  const suggestions = payload.permission_suggestions;
  return Array.isArray(suggestions) ? suggestions.filter((each): each is object => typeof each === 'object' && each !== null && !Array.isArray(each)) : [];
}

export function createPermissionHolds(options: PermissionHoldsOptions): PermissionHolds {
  /** Per session, its prompts oldest first. */
  const sessions = new Map<string, Held[]>();
  let closed = false;

  /** Answers the held hook, once; the prompt stays until the caller removes it. */
  const answer = (entry: Held, reply: HookReply) => {
    const send = entry.reply;
    entry.reply = undefined;
    entry.prompt = { ...entry.prompt, heldUntil: null };
    send?.(reply);
  };

  /** Releases and removes the session's prompts that `which` picks; returns whether any went. */
  const settle = (sessionId: string, which: (entry: Held) => boolean): boolean => {
    const entries = sessions.get(sessionId) ?? [];
    const settled = entries.filter(which);
    for (const entry of settled) {
      clearTimeout(entry.keptOpenTimer);
      answer(entry, undefined);
    }
    const kept = entries.filter((entry) => !settled.includes(entry));
    if (kept.length === 0) sessions.delete(sessionId);
    else sessions.set(sessionId, kept);
    return settled.length > 0;
  };

  /** The session's question prompt `requestId` while its answers can still be changed and sent. */
  const openDialog = (sessionId: string, requestId: string) => {
    const entry = sessions.get(sessionId)?.find((held) => held.prompt.id === requestId);
    const dialog = entry?.prompt.dialog;
    return entry?.reply !== undefined && entry.prompt.questions !== null && dialog != null && dialog.sentAt === null
      ? { entry, questions: entry.prompt.questions, dialog }
      : undefined;
  };

  return {
    hold(sessionId, payload, signal, asksInTerminal = false) {
      return new Promise<HookReply>((resolve) => {
        const now = Date.now();
        const holdMs = asksInTerminal ? options.askingHoldMs : options.holdMs;
        const subagent = subagentOf(payload);
        const questions = questionsOf(payload);
        // A question call is held, for the board's answers, only where Claude's own dialog asks too and every question
        // could be read. A subagent's terminal waits on its hook, and an unreadable question only its terminal can answer.
        const dialog = questions !== null && asksInTerminal && answerable(payload, questions) ? { answers: questions.map(() => null), sentAt: null, keptOpen: false } : null;
        const suggestions = questions === null ? suggestionsOf(payload) : [];
        const entry: Held = {
          suggestions,
          prompt: {
            id: randomUUID(),
            toolName: typeof payload.tool_name === 'string' ? payload.tool_name : 'tool',
            toolInput: payload.tool_input ?? null,
            subagent:
              subagent === null
                ? null
                : { id: subagent, type: typeof payload.agent_type === 'string' ? payload.agent_type : 'agent' },
            requestedAt: new Date(now).toISOString(),
            heldUntil: new Date(now + holdMs).toISOString(),
            asksInTerminal,
            sessionGrant: payload.tool_name === PLAN_TOOL ? PLAN_GRANT : sessionGrantOf(suggestions),
            questions,
            dialog,
            plan: planOf(payload),
          },
          reply: (reply) => {
            clearTimeout(timer);
            signal.removeEventListener('abort', lapse);
            resolve(reply);
          },
        };
        // The hold lapsing and the harness hanging up both leave the terminal to ask.
        const lapse = () => {
          if (entry.reply === undefined) return;
          answer(entry, undefined);
          if (!closed) options.onChange(sessionId);
        };
        const timer = setTimeout(lapse, holdMs);
        sessions.set(sessionId, [...(sessions.get(sessionId) ?? []), entry]);
        if (questions !== null && dialog === null) answer(entry, undefined);
        else if (signal.aborted) lapse();
        else signal.addEventListener('abort', lapse, { once: true });
      });
    },

    prompts: (sessionId) => (sessions.get(sessionId) ?? []).map((entry) => entry.prompt),

    decide(sessionId, requestId, decision) {
      const entry = sessions.get(sessionId)?.find((held) => held.prompt.id === requestId);
      if (entry?.reply === undefined || entry.prompt.questions !== null) return false;
      // Allowing for the session needs what the harness suggested; without it the request stays held.
      if (decision.behavior === 'allow' && decision.scope === 'session' && entry.prompt.sessionGrant === null) return false;
      answer(entry, entry.prompt.toolName === PLAN_TOOL ? planReply(decision) : permissionReply(decision, entry.suggestions));
      settle(sessionId, (held) => held === entry);
      return true;
    },

    answerQuestion(sessionId, requestId, index, value) {
      const open = openDialog(sessionId, requestId);
      const question = open?.questions[index];
      if (open === undefined || question === undefined || (value !== null && answerProblem(question, value) !== undefined)) return false;
      const answers = open.dialog.answers.map((each, at) => (at === index ? value : each));
      open.entry.prompt = { ...open.entry.prompt, dialog: { ...open.dialog, answers } };
      return true;
    },

    sendAnswers(sessionId, requestId) {
      const open = openDialog(sessionId, requestId);
      if (open === undefined) return false;
      const { entry, questions, dialog } = open;
      if (dialog.answers.some((each) => each === null)) return false;
      const answers = Object.fromEntries(questions.map((question, at) => [question.question, answerWords(question, dialog.answers[at]!)]));
      const input = typeof entry.prompt.toolInput === 'object' && entry.prompt.toolInput !== null ? entry.prompt.toolInput : {};
      answer(entry, { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', updatedInput: { ...input, answers } } } });
      entry.sent = answers;
      entry.prompt = { ...entry.prompt, dialog: { ...dialog, sentAt: new Date().toISOString() } };
      // It stays until its call runs. If Claude didn't take the answers, its dialog is still up: say so, once.
      entry.keptOpenTimer = setTimeout(() => {
        if (closed || !(sessions.get(sessionId) ?? []).includes(entry) || entry.prompt.dialog === null) return;
        entry.prompt = { ...entry.prompt, dialog: { ...entry.prompt.dialog, keptOpen: true } };
        options.onChange(sessionId);
      }, options.dialogTakeMs ?? DIALOG_TAKE_MS);
      return true;
    },

    release(sessionId, requestId) {
      const entry = sessions.get(sessionId)?.find((held) => held.prompt.id === requestId);
      if (entry?.reply === undefined) return false;
      answer(entry, undefined);
      return true;
    },

    afterHook(sessionId, payload) {
      const event = payload.hook_event_name;
      const from = subagentOf(payload);
      let dropped = false;
      const settled = settle(sessionId, (entry) => {
        const { prompt } = entry;
        if ((prompt.subagent?.id ?? null) !== from) return false;
        if (typeof event === 'string' && TURN_BOUNDARIES.has(event)) return true;
        // The call ran: it succeeded (`PostToolUse`) or failed (Claude's `PostToolUseFailure`). A question call's input
        // comes back with its answers added, and its asker has one dialog up at a time, so its tool alone tells it.
        if ((event !== 'PostToolUse' && event !== 'PostToolUseFailure') || payload.tool_name !== prompt.toolName) return false;
        if (prompt.questions === null) return isDeepStrictEqual(payload.tool_input, prompt.toolInput);
        // Answers sent from the board, and a call that ran with a question unanswered: Claude took the allow and not its
        // answers. Answers that differ are the user's own, typed in the terminal first, so only a missing one counts.
        if (event === 'PostToolUse' && entry.sent !== undefined && Object.keys(entry.sent).some((question) => !answeredIn(payload, question))) dropped = true;
        return true;
      });
      if (dropped && !closed) options.onAnswersDropped?.(sessionId);
      return settled;
    },

    drop: (sessionId) => void settle(sessionId, () => true),

    close() {
      closed = true;
      for (const sessionId of [...sessions.keys()]) settle(sessionId, () => true);
    },
  };
}

/** Whether a question call's `PostToolUse` carries an answer to `question`, in its input or its response. */
function answeredIn(payload: Record<string, unknown>, question: string): boolean {
  const answer = (from: unknown) => {
    const answers = typeof from === 'object' && from !== null && 'answers' in from ? from.answers : undefined;
    const each = typeof answers === 'object' && answers !== null ? (answers as Record<string, unknown>)[question] : undefined;
    return typeof each === 'string' && each.trim() !== '';
  };
  return answer(payload.tool_input) || answer(payload.tool_response);
}

/** The subagent a hook fired inside, or null for the agent itself. */
function subagentOf(payload: Record<string, unknown>): string | null {
  return typeof payload.agent_id === 'string' ? payload.agent_id : null;
}
