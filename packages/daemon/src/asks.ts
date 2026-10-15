// Questions and plans an agent puts to the user through the board (ADR-0014): `board.ask` and
// `board.presentPlan` hold the agent's call open until the user answers in the needs-you inbox or the Plan tab, the wait
// times out, or the agent stops waiting. Nothing here answers for the user: a timeout tells the agent there was no answer.
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { boardCaller, isOwnLiveSession, type BoardCallerSources, type BoardConnection } from './board.ts';
import { systemClock, type Clock } from './clock.ts';
import { invalidParams, oneOf, optionalBooleanParam, optionalCountParam, paramsObject, stringParam } from './params.ts';
import {
  DEFAULT_ASK_WAIT_MS,
  DEFAULT_PLAN_WAIT_MS,
  MAX_ASK_OPTIONS,
  MAX_ASK_WAIT_MS,
  MAX_OPTION_LENGTH,
  MAX_PLAN_LENGTH,
  MAX_PLAN_TITLE_LENGTH,
  MAX_QUESTION_LENGTH,
  MAX_REPLY_LENGTH,
  PLAN_FORMATS,
  PLAN_OUTCOMES,
  type AgentAsk,
  type AskAnswer,
  type AskResult,
  type DaemonMethods,
  type Plan,
  type PlanDecision,
  type PlanFormat,
  type PlanOutcome,
  type PlanResult,
  type PlanSummary,
} from './protocol.ts';
import type { RpcHandlers } from './rpc.ts';
import type { AgentHost } from './agents.ts';

type AskMethods = Pick<DaemonMethods, 'board.ask' | 'board.presentPlan' | 'ask.answer' | 'plan.list' | 'plan.decide'>;

/** A question as an agent asks it. */
export interface AskSpec {
  question: string;
  options?: string[];
  freeText?: boolean;
  timeoutMs?: number;
}

/** A plan as an agent presents it. */
export interface PlanSpec {
  title: string;
  body: string;
  format: PlanFormat;
  timeoutMs?: number;
}

export interface AskHostOptions {
  db: DatabaseSync;
  /** The agent began (`began`) or stopped waiting on a question or plan: its tile and the inbox follow. */
  changed(sessionId: string, began: boolean): void;
  clock?: Clock;
}

export interface AskHost {
  /** Asks the user `spec` for the agent, until they answer or skip it, or it times out. Rejects once `signal` aborts or `drop`. */
  ask(sessionId: string, spec: AskSpec, signal: AbortSignal): Promise<AskResult>;
  /** Presents the agent's next plan version, until the user decides it or it times out. Rejects, withdrawn, as `ask` does. */
  presentPlan(sessionId: string, spec: PlanSpec, signal: AbortSignal): Promise<PlanResult>;
  /** The question the agent asks now, or null. */
  pendingAsk(sessionId: string): AgentAsk | null;
  /** The agent's latest plan, or null before its first. */
  latestPlan(sessionId: string): PlanSummary | null;
  /** The agent's plans, oldest first, with their bodies. */
  plans(sessionId: string): Plan[];
  /** The user answers the agent's question `askId`. Throws `invalidParams` once it no longer asks it, or for an answer it can't take. */
  answer(sessionId: string, askId: string, answer: AskAnswer): void;
  /** The user decides the agent's plan `planId`. Throws `invalidParams` once it no longer waits on it. */
  decide(sessionId: string, planId: string, outcome: PlanOutcome, comments: string): PlanSummary;
  /** The agent stopped waiting (its turn ended, or its session): its question goes, its plan is withdrawn. */
  drop(sessionId: string): void;
  /** The agent is being deleted: drops what it waits on and forgets its plans. */
  forget(sessionId: string): void;
  handlers<Context extends BoardConnection>(sources: BoardCallerSources & { agents: Pick<AgentHost, 'get'> }): RpcHandlers<AskMethods, Context>;
  /** Withdraws everything still waiting, as the daemon goes. */
  close(): void;
}

interface PlanRow {
  id: string;
  session_id: string;
  version: number;
  title: string;
  format: PlanFormat;
  body: string;
  presented_at: string;
  expires_at: string;
  outcome: PlanDecision['outcome'] | null;
  comments: string;
  decided_at: string | null;
}

const toSummary = (row: PlanRow): PlanSummary => ({
  id: row.id,
  version: row.version,
  title: row.title,
  format: row.format,
  presentedAt: row.presented_at,
  expiresAt: row.expires_at,
  decision: row.outcome === null || row.decided_at === null ? null : { outcome: row.outcome, comments: row.comments, decidedAt: row.decided_at },
});

/** What waits for the user: the agent's question or plan, and how to end the wait. */
interface Waiting {
  ask: AgentAsk | null;
  planId: string | null;
  /** Ends the wait with what the user did, or with nothing (null) once the agent stopped waiting. */
  settle(outcome: { answer: AskAnswer } | { decision: PlanOutcome; comments: string } | 'timed-out' | null): void;
}

/** Why a wait ended with no answer to give. */
const stoppedWaiting = () => new Error('the agent stopped waiting');

/** A trimmed text field, not blank, at most `max` characters. */
function text(value: string, name: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed === '') throw invalidParams(`${name} must not be empty`);
  if (trimmed.length > max) throw invalidParams(`${name} must be at most ${max} characters; it has ${trimmed.length}`);
  return trimmed;
}

/** How long a wait lasts: as asked, else `fallback`, never longer than `MAX_ASK_WAIT_MS`. */
const waitMs = (asked: number | undefined, fallback: number) => Math.min(asked ?? fallback, MAX_ASK_WAIT_MS);

export function createAskHost(options: AskHostOptions): AskHost {
  const { db, changed } = options;
  const clock = options.clock ?? systemClock;
  const insertPlan = db.prepare(
    'INSERT INTO plans (id, session_id, version, title, format, body, presented_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const decidePlan = db.prepare('UPDATE plans SET outcome = ?, comments = ?, decided_at = ? WHERE id = ? AND outcome IS NULL');
  const selectPlans = db.prepare('SELECT * FROM plans WHERE session_id = ? ORDER BY version');
  const selectLatest = db.prepare('SELECT * FROM plans WHERE session_id = ? ORDER BY version DESC LIMIT 1');
  const selectPlan = db.prepare('SELECT * FROM plans WHERE id = ?');
  const deletePlans = db.prepare('DELETE FROM plans WHERE session_id = ?');

  // No call waits on a plan the daemon held as it went: it is withdrawn.
  db.prepare('UPDATE plans SET outcome = ?, decided_at = ? WHERE outcome IS NULL').run('withdrawn', new Date(clock.now()).toISOString());

  const waiting = new Map<string, Waiting>();
  /** Each agent's latest plan, once read: the tile reads it at every update. Null for an agent with none. */
  const latest = new Map<string, PlanSummary | null>();

  const latestPlan = (sessionId: string): PlanSummary | null => {
    if (!latest.has(sessionId)) {
      const row = selectLatest.get(sessionId) as PlanRow | undefined;
      latest.set(sessionId, row === undefined ? null : toSummary(row));
    }
    return latest.get(sessionId)!;
  };

  const checkFree = (sessionId: string) => {
    const busy = waiting.get(sessionId);
    if (busy === undefined) return;
    throw invalidParams(busy.ask !== null ? 'you already ask the user something: wait for that answer first' : 'you already wait on your plan: wait for that decision first');
  };

  /**
   * Holds a wait for the agent until `settle` ends it: the user, the timer, the signal or `drop`. `finish` turns how it
   * ended into what the call resolves with, or throws for a wait no one hears now.
   */
  function hold<T>(sessionId: string, entry: Omit<Waiting, 'settle'>, ms: number, signal: AbortSignal, finish: (how: Parameters<Waiting['settle']>[0]) => T): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const done: Waiting = {
        ...entry,
        settle(how) {
          if (waiting.get(sessionId) !== done) return;
          waiting.delete(sessionId);
          cancelTimer();
          signal.removeEventListener('abort', abort);
          try {
            resolve(finish(how));
          } catch (error) {
            reject(error);
          } finally {
            changed(sessionId, false);
          }
        },
      };
      const abort = () => done.settle(null);
      const cancelTimer = clock.setTimer(() => done.settle('timed-out'), ms);
      waiting.set(sessionId, done);
      changed(sessionId, true);
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    });
  }

  /** Records how the plan ended, and says so as its latest. */
  const recordDecision = (sessionId: string, planId: string, decision: PlanDecision) => {
    decidePlan.run(decision.outcome, decision.comments, decision.decidedAt, planId);
    latest.delete(sessionId);
  };

  const now = () => new Date(clock.now()).toISOString();

  const host: AskHost = {
    ask(sessionId, spec, signal) {
      checkFree(sessionId);
      const question = text(spec.question, 'question', MAX_QUESTION_LENGTH);
      const choices = spec.options ?? [];
      if (choices.length > MAX_ASK_OPTIONS) throw invalidParams(`a question has at most ${MAX_ASK_OPTIONS} options`);
      const offered = choices.map((option, index) => text(option, `option ${index + 1}`, MAX_OPTION_LENGTH));
      const ms = waitMs(spec.timeoutMs, DEFAULT_ASK_WAIT_MS);
      const ask: AgentAsk = {
        id: randomUUID(),
        question,
        options: offered,
        freeText: offered.length === 0 || spec.freeText === true,
        askedAt: now(),
        expiresAt: new Date(clock.now() + ms).toISOString(),
      };
      return hold(sessionId, { ask, planId: null }, ms, signal, (how): AskResult => {
        if (how === null) throw stoppedWaiting();
        if (how === 'timed-out') return { outcome: 'timed-out', answer: null };
        if (!('answer' in how)) throw new Error('a plan decision answered a question');
        const { answer } = how;
        if ('skip' in answer) return { outcome: 'skipped', answer: null };
        return { outcome: 'answered', answer: 'option' in answer ? offered[answer.option]! : answer.text.trim() };
      });
    },

    presentPlan(sessionId, spec, signal) {
      checkFree(sessionId);
      const title = text(spec.title, 'title', MAX_PLAN_TITLE_LENGTH);
      if (spec.body.trim() === '') throw invalidParams('the plan must not be empty');
      if (spec.body.length > MAX_PLAN_LENGTH) throw invalidParams(`the plan must be at most ${MAX_PLAN_LENGTH} characters; it has ${spec.body.length}`);
      const ms = waitMs(spec.timeoutMs, DEFAULT_PLAN_WAIT_MS);
      const id = randomUUID();
      const version = (latestPlan(sessionId)?.version ?? 0) + 1;
      insertPlan.run(id, sessionId, version, title, spec.format, spec.body, now(), new Date(clock.now() + ms).toISOString());
      latest.delete(sessionId);
      return hold(sessionId, { ask: null, planId: id }, ms, signal, (how): PlanResult => {
        const decision: PlanDecision =
          how === null || how === 'timed-out'
            ? { outcome: how === null ? 'withdrawn' : 'timed-out', comments: '', decidedAt: now() }
            : 'decision' in how
              ? { outcome: how.decision, comments: how.comments, decidedAt: now() }
              : { outcome: 'withdrawn', comments: '', decidedAt: now() };
        recordDecision(sessionId, id, decision);
        if (how === null) throw stoppedWaiting();
        return { version, decision };
      });
    },

    pendingAsk: (sessionId) => waiting.get(sessionId)?.ask ?? null,

    latestPlan,

    plans: (sessionId) => (selectPlans.all(sessionId) as unknown as PlanRow[]).map((row) => ({ ...toSummary(row), body: row.body })),

    answer(sessionId, askId, answer) {
      const entry = waiting.get(sessionId);
      const ask = entry?.ask;
      if (entry === undefined || ask === null || ask === undefined || ask.id !== askId) throw invalidParams('the agent no longer asks that: it was answered, timed out or stopped waiting');
      if ('option' in answer) {
        if (!Number.isInteger(answer.option) || answer.option < 0 || answer.option >= ask.options.length) {
          throw invalidParams(`the question has no option ${Number(answer.option) + 1}`);
        }
      } else if ('text' in answer) {
        if (!ask.freeText) throw invalidParams('the question takes only its options');
        text(answer.text, 'the answer', MAX_REPLY_LENGTH);
      }
      entry.settle({ answer });
    },

    decide(sessionId, planId, outcome, comments) {
      const entry = waiting.get(sessionId);
      if (entry === undefined || entry.planId !== planId) {
        const row = selectPlan.get(planId) as PlanRow | undefined;
        throw invalidParams(row?.outcome != null ? `that plan was decided already (${row.outcome})` : 'the agent no longer waits on that plan');
      }
      if (comments.length > MAX_REPLY_LENGTH) throw invalidParams(`comments must be at most ${MAX_REPLY_LENGTH} characters`);
      entry.settle({ decision: outcome, comments: comments.trim() });
      return latestPlan(sessionId)!;
    },

    drop: (sessionId) => waiting.get(sessionId)?.settle(null),

    forget(sessionId) {
      host.drop(sessionId);
      deletePlans.run(sessionId);
      latest.delete(sessionId);
    },

    handlers<Context extends BoardConnection>(sources: BoardCallerSources & { agents: Pick<AgentHost, 'get'> }): RpcHandlers<AskMethods, Context> {
      /** The live agent whose own session holds the call's board token: never a shell's, nor an ended agent's. */
      const asker = (p: Record<string, unknown>, connection: Context): string => {
        const who = boardCaller(sources, stringParam(p, 'token'), connection);
        const me = who.kind === 'agent' ? sources.agents.get(who.tileId) : undefined;
        if (me === undefined || !isOwnLiveSession(me, who.sessionId)) {
          throw invalidParams('only a live agent asks the user, from its own session: not a shell, nor an ended agent\'s shell');
        }
        return me.sessionId;
      };
      /** Stops a wait once the call's connection goes: the harness cancelled the call, or went. */
      const closed = (connection: Context) => connection.closed ?? new AbortController().signal;
      const timeout = (p: Record<string, unknown>) => optionalCountParam(p, 'timeoutMs');
      const sessionOf = (p: Record<string, unknown>) => {
        const sessionId = stringParam(p, 'sessionId');
        if (sources.agents.get(sessionId) === undefined) throw invalidParams(`no agent ${sessionId}`);
        return sessionId;
      };
      return {
        'board.ask': (params, connection) => {
          const p = paramsObject(params);
          const sessionId = asker(p, connection);
          const options = p.options;
          if (options !== undefined && (!Array.isArray(options) || !options.every((option) => typeof option === 'string'))) {
            throw invalidParams('options must be a list of strings');
          }
          const spec: AskSpec = { question: stringParam(p, 'question'), options: options as string[] | undefined, freeText: optionalBooleanParam(p, 'freeText'), timeoutMs: timeout(p) };
          return host.ask(sessionId, spec, closed(connection));
        },
        'board.presentPlan': (params, connection) => {
          const p = paramsObject(params);
          const sessionId = asker(p, connection);
          const spec: PlanSpec = { title: stringParam(p, 'title'), body: stringParam(p, 'body'), format: oneOf(p, 'format', PLAN_FORMATS), timeoutMs: timeout(p) };
          return host.presentPlan(sessionId, spec, closed(connection));
        },
        'ask.answer': (params) => {
          const p = paramsObject(params);
          const sessionId = sessionOf(p);
          host.answer(sessionId, stringParam(p, 'askId'), askAnswer(p.answer));
          return null;
        },
        'plan.list': (params) => host.plans(sessionOf(paramsObject(params))),
        'plan.decide': (params) => {
          const p = paramsObject(params);
          const comments = p.comments === undefined ? '' : stringParam(p, 'comments');
          return host.decide(sessionOf(p), stringParam(p, 'planId'), oneOf(p, 'outcome', PLAN_OUTCOMES), comments);
        },
      };
    },

    close() {
      for (const sessionId of [...waiting.keys()]) host.drop(sessionId);
    },
  };
  return host;
}

/** An answer off the wire: an option's index, the user's words, or a skip. */
function askAnswer(raw: unknown): AskAnswer {
  const answer = paramsObject(raw);
  if (answer.skip === true) return { skip: true };
  if (typeof answer.option === 'number') return { option: answer.option };
  if (typeof answer.text === 'string') return { text: answer.text };
  throw invalidParams('answer must be {option}, {text} or {skip: true}');
}
