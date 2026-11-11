// Steps cards: an ordered list of questions and to-dos on the board, a board item of their own kind. An agent puts one
// up (`board.newSteps`) and isn't held: the user answers its questions and presses Send, and the answers are typed at
// its prompt, led by `[agent-board]`, as a left plan's decision is (ADR-0014). An agent waiting on a to-do (`steps
// wait`) is told once someone else ticks it, or the card closes. Nothing else is typed: naming an agent on a step sends
// it nothing. What a change tells is typed only once the change is saved.
import { createHash, randomUUID } from 'node:crypto';
import { boardCaller, connectionAgent, isOwnLiveSession, type BoardCallerSources, type BoardConnection } from './board.ts';
import { readsItem, type ReachesZone } from './item-scope.ts';
import { isObject } from './json.ts';
import { keyedQueue } from './keyed-queue.ts';
import type { DaemonCall } from './orchestrator-layout.ts';
import { invalidParams, optionalBooleanParam, optionalStringParam, paramsObject, stringParam } from './params.ts';
import {
  BOARD_ERROR,
  MAX_FLAG_LENGTH,
  MAX_ITEM_DATA_BYTES,
  MAX_PLAN_TITLE_LENGTH,
  MAX_STEP_ANSWER,
  MAX_STEP_TEXT,
  STEP_KINDS,
  STEPS_ASK_ENDS,
  STEPS_CARD_SIZE,
  type Agent,
  type AgentAsk,
  type AgentStepsWait,
  type AskAnswer,
  type BoardItem,
  type BoardPlace,
  type DaemonMethods,
  type Step,
  type StepAnswer,
  type StepDraft,
  type StepsAskEnd,
  type StepsChange,
  type StepsData,
  type StepsWho,
} from './protocol.ts';
import { RpcMethodError, type RpcHandlers } from './rpc.ts';
import { answerWords, stepsProblem } from './steps-format.ts';
import { oneLine } from './terminal-input.ts';
import { cutText } from './text-cut.ts';
import type { AgentHost } from './agents.ts';

type StepsMethods = Pick<DaemonMethods, 'board.newSteps' | 'board.readSteps' | 'board.updateSteps' | 'steps.answer' | 'steps.tick' | 'steps.send'>;

export interface StepsHostOptions extends BoardCallerSources {
  agents: Pick<AgentHost, 'get' | 'fallbackOwner' | 'flag' | 'clearFlag'>;
  shells: BoardCallerSources['shells'];
  /** The daemon's own methods: a steps card is a board item, made and changed through them. */
  call: DaemonCall;
  /** Where a new card of the agent's goes: beside its tile. */
  place(sessionId: string, size: { width: number; height: number }): Promise<BoardPlace | undefined>;
  reachesZone: ReachesZone;
  /** Types `text` at the agent's prompt once it is ready for its next message. */
  tell(sessionId: string, text: string): void;
  /**
   * Answers the agent's ask `askId` with the answers of its card `cardId`, one per question: true if it still waited on
   * that card, false if not (the answers are then typed instead).
   */
  answerAsk?(sessionId: string, askId: string, cardId: string, answers: (AskAnswer | null)[]): boolean;
  /** Whether the agent's ask `askId` still waits, on the card `cardId`. */
  askWaits?(sessionId: string, askId: string, cardId: string): boolean;
  /**
   * What the agent waits on the user for on a steps card changed (`waitOf`): `began` when it is a new wait, a step it
   * didn't wait on before, so the user hasn't seen it yet; else only what its row says.
   */
  waitChanged?(sessionId: string, began: boolean): void;
  now?: () => Date;
}

/**
 * A change's new data, and what it tells once saved: each agent's message, the maker whose flag it answers, and the ask
 * whose waiting call its answers go to (`told` instead, if that call stopped waiting).
 */
interface Changed {
  data: StepsData;
  told?: { sessionId: string; text: string }[];
  answersFlagOf?: string;
  answersAsk?: { sessionId: string; askId: string; answers: (AskAnswer | null)[] };
}

const outOfScope = (message: string) => new RpcMethodError(BOARD_ERROR.outOfScope, message);

const USER: StepsWho = { kind: 'user' };

const sameWho = (a: StepsWho | null, b: StepsWho) => a !== null && a.kind === b.kind && (a.kind === 'user' || (b.kind === 'agent' && a.sessionId === b.sessionId));

const agentWho = (agent: Pick<Agent, 'sessionId' | 'name'>): StepsWho => ({ kind: 'agent', sessionId: agent.sessionId, name: agent.name });

/** Who in words, for a message: "the user", or the agent's name; `Whoname` to start a sentence with. */
const whoName = (who: StepsWho) => (who.kind === 'user' ? 'the user' : who.name);
const whoToStart = (who: StepsWho) => (who.kind === 'user' ? 'The user' : who.name);

/** Throws `invalidParams` if `data` is past an item's size cap: `what` is the change that took it there. */
function checkSize(data: StepsData, what: string): void {
  const bytes = Buffer.byteLength(JSON.stringify(data));
  if (bytes > MAX_ITEM_DATA_BYTES) {
    throw invalidParams(`${what} would make “${data.title}” too big to keep (${bytes} bytes, at most ${MAX_ITEM_DATA_BYTES}): shorten its longest answers or steps`);
  }
}

/** A short fingerprint of an answer in words: what a later Send compares, so the card keeps no second copy. */
const fingerprint = (words: string) => createHash('sha256').update(words).digest('hex').slice(0, 16);

const isIndex = (value: unknown, length: number): value is number => Number.isInteger(value) && (value as number) >= 0 && (value as number) < length;

/** `value` as an answer `step` takes; throws `invalidParams` saying why not. */
function checkedAnswer(step: Pick<Step, 'kind' | 'choices'>, value: unknown): StepAnswer {
  if (!isObject(value)) throw invalidParams('an answer is { one } | { any } | { yes } | { order } | { words }');
  const choices = step.choices.length;
  switch (step.kind) {
    case 'one':
      if (!isIndex(value.one, choices)) throw invalidParams(`pick one of its ${choices} choices: { one: 0 to ${choices - 1} }`);
      return { one: value.one };
    case 'any': {
      const any = value.any;
      if (!Array.isArray(any) || !any.every((index) => isIndex(index, choices)) || new Set(any).size !== any.length) {
        throw invalidParams(`pick any of its ${choices} choices, each once: { any: [indexes] }`);
      }
      return { any: [...(any as number[])].sort((a, b) => a - b) };
    }
    case 'yes-no':
      if (typeof value.yes !== 'boolean') throw invalidParams('answer yes or no: { yes: true | false }');
      return { yes: value.yes };
    case 'order': {
      const order = value.order;
      if (!Array.isArray(order) || order.length !== choices || !order.every((index) => isIndex(index, choices)) || new Set(order).size !== choices) {
        throw invalidParams(`put all ${choices} rows in order, each once: { order: [indexes] }`);
      }
      return { order: [...(order as number[])] };
    }
    case 'words': {
      const words = typeof value.words === 'string' ? value.words.trim() : '';
      if (words === '' || words.length > MAX_STEP_ANSWER) throw invalidParams(`answer in words, 1 to ${MAX_STEP_ANSWER} characters: { words }`);
      return { words };
    }
    case 'todo':
      throw invalidParams('a to-do is ticked, not answered');
  }
}

/** Whether `who` is a `StepsWho` (with its name, when `named`), or null where `nullable`. */
const isWho = (who: unknown, named: boolean) => isObject(who) && (who.kind === 'user' || (who.kind === 'agent' && typeof who.sessionId === 'string' && (!named || typeof who.name === 'string')));

/** Whether `step` has the fields a draft and a stored step share, of their types. */
const isStepShape = (step: unknown): step is Record<string, unknown> =>
  isObject(step) &&
  (STEP_KINDS as readonly unknown[]).includes(step.kind) &&
  typeof step.text === 'string' &&
  (step.section === null || typeof step.section === 'string') &&
  typeof step.required === 'boolean' &&
  Array.isArray(step.choices) &&
  step.choices.every((choice) => typeof choice === 'string') &&
  (step.link === null || typeof step.link === 'string');

/** Whether `value` is a tick or an answer's stamp: who and when. */
const isStamp = (value: unknown): value is Record<string, unknown> => isObject(value) && isWho(value.by, true) && typeof value.at === 'string';

/** The step drafts `value` holds, checked as a set after `before`; throws `invalidParams` saying what is wrong. */
function checkedDrafts(value: unknown, before: readonly Step[] = []): StepDraft[] {
  if (!Array.isArray(value) || value.length === 0) throw invalidParams('steps must be a list of at least one step');
  const drafts = value.map((each, at) => {
    if (!isStepShape(each) || !(each.who === null || isWho(each.who, false)) || typeof each.done !== 'boolean') {
      throw invalidParams(`step ${before.length + at + 1} must be { kind, text, section, required, choices, who, link, done }`);
    }
    const draft = each as unknown as StepDraft;
    if (draft.done && draft.kind !== 'todo') throw invalidParams(`step ${before.length + at + 1}: only a to-do is done; a question is answered`);
    return { ...draft, text: draft.text.trim(), section: draft.section?.trim() ?? null, choices: draft.choices.map((choice) => choice.trim()), link: draft.link?.trim() ?? null };
  });
  const problem = stepsProblem([...before, ...drafts]);
  if (problem !== undefined) throw invalidParams(problem);
  return drafts;
}

/** A steps card's data as stored, checked: throws `invalidParams` for one a steps card can't hold. */
export function checkStepsData(data: Record<string, unknown>): void {
  const fail = (what: string) => invalidParams(`a steps card's ${what}`);
  if (typeof data.title !== 'string' || data.title.trim() === '' || data.title.length > MAX_PLAN_TITLE_LENGTH) throw fail(`title must be 1 to ${MAX_PLAN_TITLE_LENGTH} characters`);
  if (!isWho(data.madeBy, true) || !isWho(data.answeredBy, true)) throw fail("madeBy and answeredBy must be { kind: 'user' } or { kind: 'agent', sessionId, name }");
  const steps = data.steps;
  if (!Array.isArray(steps)) throw fail('steps must be a list');
  for (const [at, step] of steps.entries()) {
    const ok =
      isStepShape(step) &&
      typeof step.id === 'string' &&
      (step.who === null || isWho(step.who, true)) &&
      (step.done === null || isStamp(step.done)) &&
      (step.answer === null || isStamp(step.answer));
    if (!ok) throw fail(`step ${at + 1} must be { id, kind, text, section, required, choices, who, link, done, answer }`);
    if (step.answer !== null) {
      try {
        checkedAnswer(step as unknown as Step, (step.answer as Record<string, unknown>).value);
      } catch (error) {
        throw fail(`step ${at + 1}'s answer: ${(error as Error).message}`);
      }
    }
  }
  if (new Set(steps.map((step) => (step as Step).id)).size !== steps.length) throw fail('steps must each have an id of their own');
  const problem = stepsProblem(steps as Step[]);
  if (problem !== undefined) throw fail(problem);
  const waits = data.waits;
  if (!Array.isArray(waits) || !waits.every((wait) => isObject(wait) && typeof wait.sessionId === 'string' && typeof wait.stepId === 'string')) {
    throw fail('waits must be a list of { sessionId, stepId }');
  }
  const sent = data.sent;
  const sentOk = sent === null || (isObject(sent) && typeof sent.at === 'string' && isObject(sent.answers) && Object.values(sent.answers).every((each) => typeof each === 'string'));
  if (!sentOk) throw fail('sent must be null or { at, answers }');
  if (!(data.closedAt === null || typeof data.closedAt === 'string')) throw fail('closedAt must be null or a time');
  if (data.collapsed !== undefined && typeof data.collapsed !== 'boolean') throw fail('collapsed must be true or false');
  const fromAsk = data.fromAsk;
  const endedOk = (ended: unknown) => ended === null || (isObject(ended) && typeof ended.at === 'string' && (STEPS_ASK_ENDS as readonly unknown[]).includes(ended.how));
  if (fromAsk !== undefined && !(isObject(fromAsk) && typeof fromAsk.askId === 'string' && endedOk(fromAsk.ended))) {
    throw fail(`fromAsk must be { askId, ended: null | { at, how: ${STEPS_ASK_ENDS.join(' | ')} } }`);
  }
}

/** `text` on one line and at most `max` characters, cut with an ellipsis. */
const fitted = (text: string, max: number) => {
  const line = oneLine(text);
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/**
 * The steps of a card made from `ask`, with its answers so far: a pick-one question for one whose options a card can
 * offer, else one answered in words, its options in its text, as is one the user answered in their own words, so
 * nothing they wrote is lost.
 */
function askSteps(ask: AgentAsk): Step[] {
  return ask.questions.map((question, at) => {
    const answer = ask.answers[at] ?? null;
    const choices = question.options.map((option) => fitted(option, MAX_STEP_TEXT));
    const picks = { kind: 'one' as const, text: fitted(question.question, MAX_STEP_TEXT), choices, section: null, link: null, who: null };
    const words = (answer !== null && 'text' in answer) || stepsProblem([picks]) !== undefined;
    const value: StepAnswer | null =
      answer === null || 'skip' in answer
        ? null
        : 'text' in answer
          ? { words: answer.text.trim().slice(0, MAX_STEP_ANSWER) }
          : words
            ? { words: question.options[answer.option]! }
            : { one: answer.option };
    return {
      id: randomUUID().slice(0, 8),
      kind: words ? 'words' : 'one',
      text: words && choices.length > 0 ? fitted(`${question.question} (${question.options.join(' · ')})`, MAX_STEP_TEXT) : picks.text,
      section: null,
      required: false,
      choices: words ? [] : choices,
      who: null,
      link: null,
      done: null,
      answer: value === null ? null : { value, by: USER, at: ask.askedAt },
    };
  });
}

/** A card's answers as its ask takes them, one per question: a pick by its option, words as words, null unanswered. */
const askAnswers = (data: StepsData): (AskAnswer | null)[] =>
  data.steps
    .filter((step) => step.kind !== 'todo')
    .map((step): AskAnswer | null => {
      const value = step.answer?.value;
      if (value === undefined) return null;
      if ('one' in value) return { option: value.one };
      if ('words' in value) return { text: value.words };
      return null;
    });

/** A steps card's data, as stored. */
const stepsOf = (item: BoardItem) => item.data as unknown as StepsData;

/** Whether `me` made the set, answers it, or is named on one of its steps. */
const involved = (me: StepsWho, data: StepsData) => sameWho(data.madeBy, me) || sameWho(data.answeredBy, me) || data.steps.some((step) => sameWho(step.who, me));

export interface StepsHost {
  /** `items` as the connection may see them: a board-token agent sees only the steps cards in its scope. */
  visible(items: BoardItem[], connection: BoardConnection): BoardItem[];
  /**
   * Puts the agent's ask on the board as a steps card beside its tile, holding the answers so far: while `ended` is null
   * its call still waits, and the card's Send answers it.
   */
  fromAsk(sessionId: string, ask: AgentAsk, ended: { at: string; how: StepsAskEnd } | null): Promise<BoardItem>;
  /** The ask the card `id` was made from stopped waiting: the card says so, and a later Send is typed instead. */
  askEnded(id: string, ended: { at: string; how: StepsAskEnd }): Promise<void>;
  /** Stamps every card still marked as waited on: as the daemon starts, no ask's call waits on any. */
  endStaleAsks(): Promise<void>;
  /** What the live agent `sessionId` waits on the user for on a steps card, if anything (Needs you). */
  waitOf(sessionId: string): AgentStepsWait | null;
  /** The board's steps cards as they are now, read once as the daemon starts; the waits they make are told. */
  load(): Promise<void>;
  /** The board item `item` changed, or (`removed`) went: the waits it makes are worked out again and told. */
  itemChanged(item: BoardItem | { id: string; removed: true }): void;
  /**
   * The agent `sessionId` is live (`live`) or not: on a change either way, every wait is worked out again. Ended or gone,
   * its waits go, and a set it answered for its crew is the user's; resumed, its waits come back, and its crew's sets are
   * its own again.
   */
  agentChanged(sessionId: string, live: boolean): void;
  /** The agent `sessionId` went: as it ending, and it is forgotten. */
  agentGone(sessionId: string): void;
  handlers<Context extends BoardConnection>(): RpcHandlers<StepsMethods, Context>;
}

export function createStepsHost(options: StepsHostOptions): StepsHost {
  const now = () => (options.now?.() ?? new Date()).toISOString();
  // One change to a card at a time: each reads the card, then writes it whole.
  const queue = keyedQueue();

  /** The board's steps cards, by id, as they were last saved: what agents wait on is worked out from them. */
  const known = new Map<string, { data: StepsData; since: string }>();
  /** What each live agent waits on the user for now, by session. */
  const waits = new Map<string, AgentStepsWait>();
  /** Whether each agent was last heard of as live: one coming back, or ending, changes what waits on whom. */
  const lives = new Map<string, boolean>();

  /** What `sessionId` waits on the user for, worked out from the cards: its own set to answer first, then a to-do. */
  const workOut = (sessionId: string): AgentStepsWait | null => {
    if (options.agents.get(sessionId)?.endedAt !== null) return null;
    let todo: AgentStepsWait | null = null;
    for (const [itemId, { data, since }] of known) {
      if (data.closedAt !== null || data.madeBy.kind !== 'agent') continue;
      // A set it made, which the user answers (not its orchestrator), not yet sent; one its held ask waits on is an ask.
      const questions = data.steps.filter((step) => step.kind !== 'todo');
      const asks = data.fromAsk !== undefined && data.fromAsk.ended === null;
      if (data.madeBy.sessionId === sessionId && questions.length > 0 && data.sent === null && !asks && sameWho(answerer(data), USER)) {
        const first = questions.find((step) => step.answer === null) ?? questions[0]!;
        return { kind: 'steps', itemId, title: data.title, stepId: first.id, text: first.text, open: questions.filter((step) => step.answer === null).length, since };
      }
      if (todo !== null) continue;
      const step = data.waits
        .filter((wait) => wait.sessionId === sessionId)
        .map((wait) => data.steps.find((each) => each.id === wait.stepId))
        .find((each) => each !== undefined && each.kind === 'todo' && each.done === null && sameWho(each.who, USER));
      if (step !== undefined) todo = { kind: 'todo', itemId, title: data.title, stepId: step.id, text: step.text, open: 0, since };
    }
    return todo;
  };

  /** Works every agent's wait out again, and tells of those that changed: a new card or to-do waited on is news. */
  const rework = () => {
    const sessions = new Set<string>(waits.keys());
    for (const { data } of known.values()) {
      if (data.madeBy.kind === 'agent') sessions.add(data.madeBy.sessionId);
      for (const wait of data.waits) sessions.add(wait.sessionId);
    }
    for (const sessionId of sessions) {
      const before = waits.get(sessionId);
      const after = workOut(sessionId);
      if (after === null) waits.delete(sessionId);
      else waits.set(sessionId, after);
      if (JSON.stringify(before ?? null) === JSON.stringify(after)) continue;
      // News is another card, or another to-do waited on; the user's own answers moving a set on are not.
      const began = after !== null && (before === undefined || before.itemId !== after.itemId || before.kind !== after.kind || (after.kind === 'todo' && before.stepId !== after.stepId));
      options.waitChanged?.(sessionId, began);
    }
  };

  const cards = async () => (await options.call('item.list', undefined)).filter((item) => item.kind === 'steps');
  const card = async (id: string) => {
    const found = (await cards()).find((item) => item.id === id);
    if (found === undefined) throw invalidParams(`no steps card ${id}`);
    return found;
  };

  /** Saves the change, refusing one that would make the card too big to store, then tells what it tells. */
  const save = async (item: BoardItem, { data, told = [], answersFlagOf, answersAsk }: Changed, what: string): Promise<BoardItem> => {
    checkSize(data, what);
    const saved = await options.call('item.update', { id: item.id, data: { ...data } });
    const ask = answersAsk === undefined || options.answerAsk === undefined ? false : options.answerAsk(answersAsk.sessionId, answersAsk.askId, item.id, answersAsk.answers);
    for (const each of told) if (!ask || each.sessionId !== answersAsk?.sessionId) options.tell(each.sessionId, each.text);
    // A crew member's flag pointed its orchestrator at this card: once its answers go, it is answered.
    if (answersFlagOf !== undefined && options.agents.get(answersFlagOf)?.flag?.reason.includes(`item:${item.id}`) === true) options.agents.clearFlag(answersFlagOf);
    return saved;
  };

  /** Whether the agent is live: an agent that ended, or went, answers nothing. */
  const live = (who: StepsWho) => who.kind === 'agent' && options.agents.get(who.sessionId)?.endedAt === null;
  /** Who answers the set now: its orchestrator while it is live, else the user. */
  const answerer = (data: StepsData): StepsWho => (data.answeredBy.kind === 'agent' && !live(data.answeredBy) ? USER : data.answeredBy);

  const reads = (agent: Agent, item: BoardItem) => readsItem(agent, item, involved(agentWho(agent), stepsOf(item)), options.reachesZone);

  /** The live agent whose own session holds the call's board token: never a shell's, nor an ended agent's. */
  const caller = (p: Record<string, unknown>, connection: BoardConnection): Agent => {
    const who = boardCaller(options, stringParam(p, 'token'), connection);
    const me = who.kind === 'agent' ? options.agents.get(who.tileId) : undefined;
    if (me === undefined || !isOwnLiveSession(me, who.sessionId)) throw invalidParams("only a live agent uses steps cards, from its own session: not a shell, nor an ended agent's");
    return me;
  };

  /** The live orchestrator that started the agent, which answers its questions instead of the user; never the Captain. */
  const leadOf = (agent: Agent): Agent | undefined => {
    const lead = agent.spawnedBy === null ? undefined : options.agents.get(agent.spawnedBy);
    return lead?.endedAt === null && !lead.master ? lead : undefined;
  };

  /** The step at place `place` (from 1). */
  const stepAt = (data: StepsData, place: unknown): Step => {
    if (!Number.isInteger(place) || (place as number) < 1 || (place as number) > data.steps.length) {
      throw invalidParams(`there is no step ${String(place)}: the card has ${data.steps.length}`);
    }
    return data.steps[(place as number) - 1]!;
  };
  const stepById = (data: StepsData, stepId: string): Step => {
    const step = data.steps.find((each) => each.id === stepId);
    if (step === undefined) throw invalidParams(`the card has no step ${stepId}`);
    return step;
  };
  const placeOf = (data: StepsData, step: Step) => data.steps.indexOf(step) + 1;
  const open = (data: StepsData) => {
    if (data.closedAt !== null) throw invalidParams(`“${data.title}” is closed: nothing on it changes now`);
  };

  /** Steps from drafts, `maker` doing those it doesn't name anyone for. */
  const fromDrafts = (drafts: StepDraft[], maker: StepsWho): Step[] =>
    drafts.map((draft) => {
      let who: StepsWho | null = null;
      if (draft.kind === 'todo') {
        if (draft.who === null) who = maker;
        else if (draft.who.kind === 'user') who = USER;
        else {
          const named = options.agents.get(draft.who.sessionId);
          if (named === undefined) throw invalidParams(`no agent ${draft.who.sessionId} to do “${draft.text}”`);
          who = agentWho(named);
        }
      }
      return { id: randomUUID().slice(0, 8), kind: draft.kind, text: draft.text, section: draft.section, required: draft.required, choices: draft.choices, who, link: draft.link, done: draft.done ? { by: maker, at: now() } : null, answer: null };
    });

  /** `step` ticked (or unticked) by `by`; a tick tells the agents waiting on it, but `by` itself. */
  const ticked = (item: BoardItem, data: StepsData, step: Step, by: StepsWho, done: boolean): Changed => {
    const steps = data.steps.map((each) => (each === step ? { ...each, done: done ? { by, at: now() } : null } : each));
    if (!done) return { data: { ...data, steps } };
    const told = data.waits
      .filter((wait) => wait.stepId === step.id && !(by.kind === 'agent' && wait.sessionId === by.sessionId))
      .map((wait) => ({ sessionId: wait.sessionId, text: `[agent-board] Step ${placeOf(data, step)} of “${data.title}” (item:${item.id}) is done, ticked by ${whoName(by)}: ${step.text}` }));
    return { data: { ...data, steps, waits: data.waits.filter((wait) => wait.stepId !== step.id) }, told };
  };

  /** The set's answers sent to its maker by `by`: every one the first time, then those new or changed. */
  const sent = (item: BoardItem, data: StepsData, by: StepsWho): Changed => {
    if (data.madeBy.kind !== 'agent') throw invalidParams('the user made this list: there is no one to send it to');
    const questions = data.steps.filter((step) => step.kind !== 'todo');
    if (questions.length === 0) throw invalidParams(`“${data.title}” asks nothing: there are no answers to send`);
    const missing = questions.find((step) => step.required && step.answer === null);
    if (missing !== undefined) throw invalidParams(`step ${placeOf(data, missing)} is required: answer it before sending`);
    const words = new Map(questions.map((step) => [step.id, step.answer === null ? '(skipped)' : answerWords(step, step.answer.value)]));
    const answers = Object.fromEntries(questions.map((step) => [step.id, fingerprint(words.get(step.id)!)]));
    const before = data.sent?.answers;
    // After a Send, a question added since is told once it is answered; one changed since, either way.
    const telling = before === undefined ? questions : questions.filter((step) => (before[step.id] === undefined ? step.answer !== null : before[step.id] !== answers[step.id]));
    if (telling.length === 0) throw invalidParams('nothing changed since the answers were sent');
    const lines = telling.map((step) => `${placeOf(data, step)}. ${oneLine(step.text)}\n   ${words.get(step.id)!.replace(/\n/g, '\n   ')}`);
    const what = before === undefined ? 'answered' : `updated ${telling.length === 1 ? 'an answer' : `${telling.length} answers`} on`;
    const text = `[agent-board] ${whoToStart(by)} ${what} your steps “${data.title}” (item:${item.id}):\n\n${lines.join('\n')}`;
    const told = [{ sessionId: data.madeBy.sessionId, text }];
    const stamp = { at: now(), answers };
    // Made from an ask whose call still waits on this card: the answers go there, and are typed only if it stopped in
    // the moment before the save. One no longer waited on says so, and its answers are typed.
    if (data.fromAsk !== undefined && data.fromAsk.ended === null) {
      const { askId } = data.fromAsk;
      const sessionId = data.madeBy.sessionId;
      if (options.askWaits?.(sessionId, askId, item.id) === true) {
        const fromAsk = { askId, ended: { at: stamp.at, how: 'sent' as const } };
        return { data: { ...data, sent: stamp, fromAsk }, told, answersAsk: { sessionId, askId, answers: askAnswers(data) } };
      }
      return { data: { ...data, sent: stamp, fromAsk: { askId, ended: { at: stamp.at, how: 'stopped' } } }, told, answersFlagOf: sessionId };
    }
    return { data: { ...data, sent: stamp }, told, answersFlagOf: data.madeBy.sessionId };
  };

  /** `step` answered `answer` by `by`, or its answer taken back with null. */
  const answered = (data: StepsData, step: Step, answer: unknown, by: StepsWho): Changed => {
    if (step.kind === 'todo') throw invalidParams(`step ${placeOf(data, step)} is a to-do: tick it instead`);
    const value = answer === null ? null : checkedAnswer(step, answer);
    return { data: { ...data, steps: data.steps.map((each) => (each === step ? { ...each, answer: value === null ? null : { value, by, at: now() } } : each)) } };
  };

  /** The card closed by `by`: those waiting on a to-do are told it won't be ticked. */
  const closed = (item: BoardItem, data: StepsData, by: StepsWho): Changed => {
    const told = data.waits
      .filter((wait) => !(by.kind === 'agent' && wait.sessionId === by.sessionId))
      .map((wait) => {
        const step = data.steps.find((each) => each.id === wait.stepId);
        const which = step === undefined ? 'the step you waited on' : `step ${placeOf(data, step)} (${step.text})`;
        return { sessionId: wait.sessionId, text: `[agent-board] ${whoToStart(by)} closed “${data.title}” (item:${item.id}): ${which} won't be ticked there now.` };
      });
    return { data: { ...data, closedAt: now(), waits: [] }, told, answersFlagOf: data.madeBy.kind === 'agent' ? data.madeBy.sessionId : undefined };
  };

  /** An agent's change to the card, as `board.updateSteps` makes it. */
  const changed = (item: BoardItem, data: StepsData, me: Agent, change: StepsChange): Changed => {
    const self = agentWho(me);
    const madeIt = sameWho(data.madeBy, self);
    const answersIt = () => {
      const by = answerer(data);
      if (!sameWho(by, self)) throw outOfScope(`${whoName(by)} answers “${data.title}”, not you`);
    };
    open(data);
    switch (change.action) {
      case 'done': {
        const step = stepAt(data, change.step);
        if (step.kind !== 'todo') throw invalidParams(`step ${change.step} is a question: it is answered, not ticked`);
        if (!sameWho(step.who, self)) throw outOfScope(`step ${change.step} is ${whoName(step.who!)}'s to tick, not yours`);
        return ticked(item, data, step, self, change.undo !== true);
      }
      case 'wait': {
        const step = stepAt(data, change.step);
        if (step.kind !== 'todo') throw invalidParams(`step ${change.step} is a question: its answer comes to the card's maker when it is sent`);
        if (step.done !== null) throw invalidParams(`step ${change.step} is already done`);
        if (data.waits.some((wait) => wait.sessionId === me.sessionId && wait.stepId === step.id)) return { data };
        return { data: { ...data, waits: [...data.waits, { sessionId: me.sessionId, stepId: step.id }] } };
      }
      case 'add': {
        if (!madeIt) throw outOfScope(`only ${whoName(data.madeBy)}, who made “${data.title}”, adds steps to it`);
        return { data: { ...data, steps: [...data.steps, ...fromDrafts(checkedDrafts(change.steps, data.steps), self)] } };
      }
      case 'answer':
        answersIt();
        return answered(data, stepAt(data, change.step), change.answer, self);
      case 'send':
        answersIt();
        return sent(item, data, self);
      case 'close':
        if (!madeIt) throw outOfScope(`only ${whoName(data.madeBy)}, who made “${data.title}”, closes it`);
        return closed(item, data, self);
    }
  };

  /** The change `value` is; throws `invalidParams` for one that isn't. */
  const checkedChange = (value: unknown): StepsChange => {
    if (!isObject(value) || typeof value.action !== 'string') throw invalidParams('change must be { action, … }');
    const known = ['done', 'wait', 'add', 'answer', 'send', 'close'];
    if (!known.includes(value.action)) throw invalidParams(`change.action must be one of ${known.join(', ')}`);
    return value as unknown as StepsChange;
  };

  /** The user's change, as a `steps.*` method makes it. */
  const forUser = (p: Record<string, unknown>, what: string, change: (item: BoardItem, data: StepsData) => Changed) => {
    const id = stringParam(p, 'id');
    return queue(id, async () => {
      const item = await card(id);
      const data = stepsOf(item);
      open(data);
      return save(item, change(item, data), what);
    });
  };
  /** Refuses a set the user doesn't answer now: a crew member's, while its orchestrator is live. */
  const userAnswers = (data: StepsData) => {
    const by = answerer(data);
    if (!sameWho(by, USER)) throw invalidParams(`${whoName(by)} answers “${data.title}”`);
  };

  const host: StepsHost = {
    visible(items, connection) {
      const me = connectionAgent(options, connection);
      if (me === undefined) return items;
      if (me === null) return items.filter((item) => item.kind !== 'steps');
      return items.filter((item) => item.kind !== 'steps' || reads(me, item));
    },

    async fromAsk(sessionId, ask, ended) {
      const agent = options.agents.get(sessionId);
      if (agent === undefined) throw invalidParams(`no agent ${sessionId}`);
      const title = ask.questions.length === 1 ? fitted(ask.question, MAX_PLAN_TITLE_LENGTH) : `${agent.name} asks ${ask.questions.length} questions`;
      const data: StepsData = { title, madeBy: agentWho(agent), answeredBy: USER, steps: askSteps(ask), sent: null, waits: [], closedAt: null, fromAsk: { askId: ask.id, ended } };
      checkSize(data, 'that ask');
      const spot = (await options.place(sessionId, STEPS_CARD_SIZE)) ?? { zoneId: agent.zoneId, x: 0, y: 0 };
      return options.call('item.create', { kind: 'steps', ...spot, ...STEPS_CARD_SIZE, data: { ...data } });
    },

    askEnded: (id, ended) =>
      queue(id, async () => {
        const item = (await cards()).find((each) => each.id === id);
        const data = item === undefined ? undefined : stepsOf(item);
        if (data?.fromAsk === undefined || data.fromAsk.ended !== null) return;
        await options.call('item.update', { id, data: { ...data, fromAsk: { ...data.fromAsk, ended } } });
      }),

    waitOf: (sessionId) => waits.get(sessionId) ?? null,

    async load() {
      for (const item of await cards()) known.set(item.id, { data: stepsOf(item), since: item.createdAt });
      rework();
    },

    itemChanged(item) {
      if ('removed' in item) {
        if (!known.delete(item.id)) return;
      } else if (item.kind === 'steps') known.set(item.id, { data: stepsOf(item), since: item.createdAt });
      else return;
      rework();
    },

    agentChanged(sessionId, live) {
      // Only a change of liveness reworks: an ended agent's later updates don't.
      if (lives.get(sessionId) === live) return;
      lives.set(sessionId, live);
      rework();
    },

    agentGone(sessionId) {
      lives.delete(sessionId);
      rework();
    },

    async endStaleAsks() {
      const ended = { at: now(), how: 'stopped' as const };
      for (const item of await cards()) {
        if (stepsOf(item).fromAsk?.ended === null) await host.askEnded(item.id, ended);
      }
    },

    handlers<Context extends BoardConnection>(): RpcHandlers<StepsMethods, Context> {
      return {
        'board.newSteps': async (params, connection) => {
          const p = paramsObject(params);
          const me = caller(p, connection);
          const title = stringParam(p, 'title').trim();
          if (title === '' || title.length > MAX_PLAN_TITLE_LENGTH) throw invalidParams(`title must be 1 to ${MAX_PLAN_TITLE_LENGTH} characters`);
          const self = agentWho(me);
          const steps = fromDrafts(checkedDrafts(p.steps), self);
          const lead = leadOf(me);
          const data: StepsData = { title, madeBy: self, answeredBy: lead === undefined ? USER : agentWho(lead), steps, sent: null, waits: [], closedAt: null };
          checkSize(data, 'those steps');
          const spot = (await options.place(me.sessionId, STEPS_CARD_SIZE)) ?? { zoneId: me.zoneId, x: 0, y: 0 };
          const item = await options.call('item.create', { kind: 'steps', ...spot, ...STEPS_CARD_SIZE, data: { ...data } });
          // A crew member's questions are its orchestrator's to answer: its flag goes there, as its `ask` would.
          const asks = steps.filter((step) => step.kind !== 'todo').length;
          if (lead !== undefined && asks > 0) {
            const head = `${asks === 1 ? 'a question' : `${asks} questions`} to answer (agent-board steps read item:${item.id}): `;
            options.agents.flag(me.sessionId, `${head}${cutText(oneLine(title), MAX_FLAG_LENGTH - head.length)}`, null);
          }
          return item;
        },
        'board.readSteps': async (params, connection) => {
          const p = paramsObject(params);
          const who = boardCaller(options, stringParam(p, 'token'), connection);
          const me = who.kind === 'agent' ? options.agents.get(who.tileId) : undefined;
          if (me === undefined) throw invalidParams('only an agent reads steps cards');
          const id = optionalStringParam(p, 'id');
          const mine = optionalBooleanParam(p, 'mine') === true;
          const all = id === undefined ? await cards() : [await card(id)];
          if (id !== undefined && !reads(me, all[0]!)) throw outOfScope('that steps card is outside your scope: in a zone you are not in, nor reach');
          const self = agentWho(me);
          return all.filter((item) => reads(me, item) && (!mine || stepsOf(item).steps.some((step) => step.done === null && sameWho(step.who, self))));
        },
        'board.updateSteps': async (params, connection) => {
          const p = paramsObject(params);
          const me = caller(p, connection);
          const id = stringParam(p, 'id');
          const change = checkedChange(p.change);
          return queue(id, async () => {
            const item = await card(id);
            if (!reads(me, item)) throw outOfScope('that steps card is outside your scope: in a zone you are not in, nor reach');
            return save(item, changed(item, stepsOf(item), me, change), change.action === 'add' ? 'those steps' : 'that change');
          });
        },
        'steps.answer': (params) => {
          const p = paramsObject(params);
          return forUser(p, 'that answer', (_item, data) => {
            userAnswers(data);
            return answered(data, stepById(data, stringParam(p, 'stepId')), p.answer ?? null, USER);
          });
        },
        'steps.tick': (params) => {
          const p = paramsObject(params);
          const done = p.done;
          if (typeof done !== 'boolean') throw invalidParams('done must be true or false');
          return forUser(p, 'that tick', (item, data) => {
            const step = stepById(data, stringParam(p, 'stepId'));
            if (step.kind !== 'todo') throw invalidParams('a question is answered, not ticked');
            if (!sameWho(step.who, USER)) throw invalidParams(`that to-do is ${whoName(step.who!)}'s to tick`);
            return ticked(item, data, step, USER, done);
          });
        },
        'steps.send': (params) =>
          forUser(paramsObject(params), 'sending', (item, data) => {
            userAnswers(data);
            return sent(item, data, USER);
          }),
      };
    },
  };
  return host;
}
