// Questions and plans an agent puts to the user through the board (ADR-0014): `board.ask` and
// `board.presentPlan` hold the agent's call open until the user answers in the needs-you inbox or the Plan tab, the wait
// times out, or the agent stops waiting. Nothing here answers for the user: a timeout tells the agent there was no answer.
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { boardCaller, isOwnLiveSession, type BoardCallerSources, type BoardConnection } from './board.ts';
import { systemClock, type Clock } from './clock.ts';
import { finiteNumberParam, invalidParams, oneOf, optionalBooleanParam, optionalCountParam, optionalStringParam, paramsObject, stringParam } from './params.ts';
import {
  DEFAULT_ASK_WAIT_MS,
  DEFAULT_PLAN_WAIT_MS,
  MAX_ASK_OPTIONS,
  MAX_ASK_WAIT_MS,
  MAX_OPTION_LENGTH,
  CREW_PLAN_PATH,
  CREW_QUESTION_PATH,
  MAX_FLAG_LENGTH,
  MAX_PLAN_LENGTH,
  MAX_PLAN_TITLE_LENGTH,
  MAX_QUESTION_LENGTH,
  MAX_REPLY_LENGTH,
  PLAN_FORMATS,
  PLAN_OUTCOMES,
  type Agent,
  type AgentAsk,
  type SentToOrchestrator,
  type AskAnswer,
  type AskResult,
  type DaemonMethods,
  type Plan,
  type PlanDecision,
  type PlanEdits,
  type PlanEnd,
  type PlanFormat,
  type PlanOutcome,
  type PlanResult,
  type PlanSummary,
} from './protocol.ts';
import type { RpcHandlers } from './rpc.ts';
import { oneLine } from './terminal-input.ts';
import { cutText } from './text-cut.ts';
import { lineDiff } from './text-diff.ts';
import { isInside, realPath, whyNotWritable, writeWhole } from './user-files.ts';
import type { AgentHost } from './agents.ts';

type AskMethods = Pick<DaemonMethods, 'board.ask' | 'board.presentPlan' | 'ask.answer' | 'ask.place' | 'plan.list' | 'plan.decide' | 'plan.edit'>;

/** A question as an agent asks it. */
export interface AskSpec {
  question: string;
  options?: string[];
  freeText?: boolean;
  /** Shows a question card on the board, beside the agent's tile, besides the inbox item. */
  onBoard?: boolean;
  timeoutMs?: number;
}

/** A plan as an agent presents it. */
export interface PlanSpec {
  title: string;
  body: string;
  format: PlanFormat;
  /** The real path of the file it was read from, absolute, if it was: the user's approved version is written there. */
  path?: string;
  timeoutMs?: number;
}

export interface AskHostOptions {
  db: DatabaseSync;
  /** The agent began (`began`) or stopped waiting on a question or plan: its tile and the inbox follow. */
  changed(sessionId: string, began: boolean): void;
  /**
   * The user moved the card of the agent's question, or saved their version of its plan: its tile and the inbox follow,
   * what it waits on no newer for it.
   */
  touched(sessionId: string): void;
  /** The agent's worktree, the only folder the user's approved version of a plan is written in. */
  worktree(sessionId: string): string | undefined;
  /** Puts the agent's plan card beside its tile, if it has none. */
  addCard?(sessionId: string): Promise<void>;
  /** The user's approved version of the agent's plan was written to its file at `path`. */
  wrote?(sessionId: string, path: string): void;
  log?(message: string): void;
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
  /** The user moves the card of the agent's question `askId` to `at`. Throws `invalidParams` as `answer` does, or for a question with no card. */
  place(sessionId: string, askId: string, at: { x: number; y: number }): void;
  /** The user decides the agent's plan `planId`. Throws `invalidParams` once it no longer waits on it. */
  decide(sessionId: string, planId: string, outcome: PlanOutcome, comments: string): PlanSummary;
  /**
   * The user saves `body` as their version of the Markdown plan `planId` the agent waits on: its next version, which the
   * agent then waits on instead. Throws `invalidParams` as `decide` does, for an HTML plan, and for a body it can't take.
   */
  edit(sessionId: string, planId: string, body: string): PlanSummary;
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
  author: PlanSummary['author'];
  path: string | null;
}

const toSummary = (row: PlanRow): PlanSummary => ({
  id: row.id,
  version: row.version,
  title: row.title,
  format: row.format,
  presentedAt: row.presented_at,
  expiresAt: row.expires_at,
  decision: row.outcome === null || row.decided_at === null ? null : { outcome: row.outcome, comments: row.comments, decidedAt: row.decided_at },
  author: row.author,
  path: row.path,
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

/** A plan's body: not blank, at most `MAX_PLAN_LENGTH` characters. */
function planBody(body: string): string {
  if (body.trim() === '') throw invalidParams('the plan must not be empty');
  if (body.length > MAX_PLAN_LENGTH) throw invalidParams(`the plan must be at most ${MAX_PLAN_LENGTH} characters; it has ${body.length}`);
  return body;
}

/**
 * Why the plan's file can't take the user's version: it no longer holds `body`, the agent's version they edited, as
 * something wrote it while the plan waited. Undefined while it holds it: writing over it then loses nothing.
 */
function whyChanged(path: string, body: string): string | undefined {
  try {
    if (readFileSync(path, 'utf8') === body) return undefined;
  } catch (error) {
    return `can't read the file: ${(error as Error).message}`;
  }
  return 'the file changed since you showed it, so it is not written';
}

/** How long a wait lasts: as asked, else `fallback`, never longer than `MAX_ASK_WAIT_MS`. */
const waitMs = (asked: number | undefined, fallback: number) => Math.min(asked ?? fallback, MAX_ASK_WAIT_MS);

export function createAskHost(options: AskHostOptions): AskHost {
  const { db, changed, touched } = options;
  const clock = options.clock ?? systemClock;
  const insertPlan = db.prepare(
    'INSERT INTO plans (id, session_id, version, title, format, body, presented_at, expires_at, author, path) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const decidePlan = db.prepare('UPDATE plans SET outcome = ?, comments = ?, decided_at = ? WHERE id = ? AND outcome IS NULL');
  const selectPlans = db.prepare('SELECT * FROM plans WHERE session_id = ? ORDER BY version');
  const selectLatest = db.prepare('SELECT * FROM plans WHERE session_id = ? ORDER BY version DESC LIMIT 1');
  const selectPlan = db.prepare('SELECT * FROM plans WHERE id = ?');
  const selectAgentsBefore = db.prepare("SELECT * FROM plans WHERE session_id = ? AND author = 'agent' AND version < ? ORDER BY version DESC LIMIT 1");
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
   * ended, and the wait as it ended (its plan the user's latest version), into what the call resolves with, or throws
   * for a wait no one hears now.
   */
  function hold<T>(
    sessionId: string,
    entry: Omit<Waiting, 'settle'>,
    ms: number,
    signal: AbortSignal,
    finish: (how: Parameters<Waiting['settle']>[0], wait: Waiting) => T,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const done: Waiting = {
        ...entry,
        settle(how) {
          if (waiting.get(sessionId) !== done) return;
          waiting.delete(sessionId);
          cancelTimer();
          signal.removeEventListener('abort', abort);
          try {
            resolve(finish(how, done));
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

  /**
   * What the user changed in the agent's version to make `decided`, for the agent; null if `decided` is the agent's. An
   * approved version is written to the plan's file (`approved`), if the agent's worktree holds it.
   */
  const editsOf = (sessionId: string, decided: PlanRow, approved: boolean): PlanEdits | null => {
    if (decided.author !== 'user') return null;
    const agents = selectAgentsBefore.get(sessionId, decided.version) as unknown as PlanRow;
    const edits: PlanEdits = { from: agents.version, diff: lineDiff(agents.body, decided.body), written: false, problem: null };
    if (!approved || decided.path === null) return edits;
    const worktree = options.worktree(sessionId);
    const problem =
      worktree === undefined || !isInside(realPath(worktree), decided.path)
        ? 'the file is outside your worktree, so it is not written there'
        : (whyNotWritable(decided.path) ?? whyChanged(decided.path, agents.body));
    if (problem !== undefined) return { ...edits, problem };
    try {
      writeWhole(decided.path, decided.body, statSync(decided.path).mode);
      options.wrote?.(sessionId, decided.path);
      return { ...edits, written: true };
    } catch (error) {
      return { ...edits, problem: `could not write the file: ${(error as Error).message}` };
    }
  };

  /** The agent's wait on its plan `planId`, while it still waits on it. */
  const waitingOn = (sessionId: string, planId: string): Waiting => {
    const entry = waiting.get(sessionId);
    if (entry !== undefined && entry.planId === planId) return entry;
    const row = selectPlan.get(planId) as PlanRow | undefined;
    if (row?.outcome === 'edited') {
      const edit = selectLatest.get(sessionId) as unknown as PlanRow;
      throw invalidParams(`you edited it: decide v${edit.version}, your version`);
    }
    throw invalidParams(row?.outcome != null ? `that plan was decided already (${row.outcome})` : 'the agent no longer waits on that plan');
  };

  /** Records how the plan ended, and says so as its latest. */
  const recordDecision = (sessionId: string, planId: string, decision: PlanDecision) => {
    decidePlan.run(decision.outcome, decision.comments, decision.decidedAt, planId);
    latest.delete(sessionId);
  };

  const now = () => new Date(clock.now()).toISOString();

  /** The agent's wait on its question `askId`, while it still asks it. */
  const asking = (sessionId: string, askId: string): { entry: Waiting; ask: AgentAsk } => {
    const entry = waiting.get(sessionId);
    const ask = entry?.ask;
    if (entry === undefined || ask === null || ask === undefined || ask.id !== askId) throw invalidParams('the agent no longer asks that: it was answered, timed out or stopped waiting');
    return { entry, ask };
  };

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
        onBoard: spec.onBoard === true,
        at: null,
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
      const body = planBody(spec.body);
      const ms = waitMs(spec.timeoutMs, DEFAULT_PLAN_WAIT_MS);
      const id = randomUUID();
      const version = (latestPlan(sessionId)?.version ?? 0) + 1;
      insertPlan.run(id, sessionId, version, title, spec.format, body, now(), new Date(clock.now() + ms).toISOString(), 'agent', spec.path ?? null);
      latest.delete(sessionId);
      return hold(sessionId, { ask: null, planId: id }, ms, signal, (how, wait): PlanResult => {
        const decision: PlanEnd =
          how === null || how === 'timed-out'
            ? { outcome: how === null ? 'withdrawn' : 'timed-out', comments: '', decidedAt: now() }
            : 'decision' in how
              ? { outcome: how.decision, comments: how.comments, decidedAt: now() }
              : { outcome: 'withdrawn', comments: '', decidedAt: now() };
        // The user's edits made later versions: the decision is on the latest.
        const decided = selectPlan.get(wait.planId!) as unknown as PlanRow;
        recordDecision(sessionId, decided.id, decision);
        if (how === null) throw stoppedWaiting();
        return { version: decided.version, decision, edits: editsOf(sessionId, decided, decision.outcome === 'approved') };
      });
    },

    pendingAsk: (sessionId) => waiting.get(sessionId)?.ask ?? null,

    latestPlan,

    plans: (sessionId) => (selectPlans.all(sessionId) as unknown as PlanRow[]).map((row) => ({ ...toSummary(row), body: row.body })),

    answer(sessionId, askId, answer) {
      const { entry, ask } = asking(sessionId, askId);
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

    place(sessionId, askId, at) {
      const { entry, ask } = asking(sessionId, askId);
      if (!ask.onBoard) throw invalidParams('that question is not on the board: it is answered in the inbox');
      if (!Number.isFinite(at.x) || !Number.isFinite(at.y)) throw invalidParams('at must be a point: finite x and y');
      entry.ask = { ...ask, at: { x: at.x, y: at.y } };
      touched(sessionId);
    },

    decide(sessionId, planId, outcome, comments) {
      const entry = waitingOn(sessionId, planId);
      if (comments.length > MAX_REPLY_LENGTH) throw invalidParams(`comments must be at most ${MAX_REPLY_LENGTH} characters`);
      entry.settle({ decision: outcome, comments: comments.trim() });
      return latestPlan(sessionId)!;
    },

    edit(sessionId, planId, body) {
      const entry = waitingOn(sessionId, planId);
      const plan = selectPlan.get(planId) as unknown as PlanRow;
      if (plan.format !== 'markdown') throw invalidParams('an HTML plan is view-only: say what to change in your comments');
      if (planBody(body) === plan.body) throw invalidParams(`nothing changed: it is v${plan.version} as it was`);
      const id = randomUUID();
      insertPlan.run(id, sessionId, plan.version + 1, plan.title, plan.format, body, now(), plan.expires_at, 'user', plan.path);
      decidePlan.run('edited', '', now(), planId);
      entry.planId = id;
      latest.delete(sessionId);
      touched(sessionId);
      return latestPlan(sessionId)!;
    },

    drop: (sessionId) => waiting.get(sessionId)?.settle(null),

    forget(sessionId) {
      host.drop(sessionId);
      deletePlans.run(sessionId);
      latest.delete(sessionId);
    },

    handlers<Context extends BoardConnection>(sources: BoardCallerSources & { agents: Pick<AgentHost, 'get' | 'flag'> }): RpcHandlers<AskMethods, Context> {
      /** The live agent whose own session holds the call's board token: never a shell's, nor an ended agent's. */
      const asker = (p: Record<string, unknown>, connection: Context): string => {
        const who = boardCaller(sources, stringParam(p, 'token'), connection);
        const me = who.kind === 'agent' ? sources.agents.get(who.tileId) : undefined;
        if (me === undefined || !isOwnLiveSession(me, who.sessionId)) {
          throw invalidParams('only a live agent asks the user, from its own session: not a shell, nor an ended agent\'s shell');
        }
        return me.sessionId;
      };
      /**
       * The live orchestrator that started the agent, which its questions and plans go to instead of the user; else
       * undefined. Never the Captain (ADR-0019): what its leads ask or plan waits for the user, never for it to settle.
       */
      const leadOf = (sessionId: string): Agent | undefined => {
        const spawnedBy = sources.agents.get(sessionId)?.spawnedBy;
        const lead = spawnedBy === null || spawnedBy === undefined ? undefined : sources.agents.get(spawnedBy);
        return lead?.endedAt === null && !lead.master ? lead : undefined;
      };
      /**
       * Flags the crew member's orchestrator with `reason` in its place: nothing waits, and its answer is its next
       * message. `reason` fits a flag: what doesn't is written to a file the reason names, never cut.
       */
      const sendToLead = (sessionId: string, lead: Agent, reason: string): SentToOrchestrator => {
        sources.agents.flag(sessionId, reason, null);
        return { sentTo: 'orchestrator', name: lead.name };
      };
      /** Writes `text` to `path` in the crew member's worktree, beside its handover, for its orchestrator to `read`. */
      const writeForLead = (sessionId: string, path: string, text: string) => {
        const file = join(sources.agents.get(sessionId)!.worktree, path);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, text);
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
          const spec: AskSpec = {
            question: stringParam(p, 'question'),
            options: options as string[] | undefined,
            freeText: optionalBooleanParam(p, 'freeText'),
            onBoard: optionalBooleanParam(p, 'onBoard'),
            timeoutMs: timeout(p),
          };
          const lead = leadOf(sessionId);
          if (lead === undefined) return host.ask(sessionId, spec, closed(connection));
          const offered = (spec.options ?? []).map((option, index) => text(option, `option ${index + 1}`, MAX_OPTION_LENGTH));
          const question = text(spec.question, 'question', MAX_QUESTION_LENGTH);
          const line = oneLine(`asks: ${question}${offered.length === 0 ? '' : ` (${offered.join(' · ')})`}`);
          if (line.length <= MAX_FLAG_LENGTH) return sendToLead(sessionId, lead, line);
          // Too long for a flag: the question and every option go in full to a file, which the flag points to.
          if (!sources.agents.get(sessionId)!.ownsWorktree) return host.ask(sessionId, spec, closed(connection));
          writeForLead(sessionId, CREW_QUESTION_PATH, crewQuestionText(question, offered));
          const head = `asks (in full, with ${offered.length === 0 ? 'no options' : `its ${offered.length} options`}, in ${CREW_QUESTION_PATH}): `;
          return sendToLead(sessionId, lead, `${head}${cutText(oneLine(question), MAX_FLAG_LENGTH - head.length)}`);
        },
        'board.presentPlan': (params, connection) => {
          const p = paramsObject(params);
          const sessionId = asker(p, connection);
          const path = optionalStringParam(p, 'path');
          if (path !== undefined && !isAbsolute(path)) throw invalidParams('the path must be absolute');
          const spec: PlanSpec = {
            title: stringParam(p, 'title'),
            body: stringParam(p, 'body'),
            format: oneOf(p, 'format', PLAN_FORMATS),
            ...(path === undefined ? {} : { path: realPath(path) }),
            timeoutMs: timeout(p),
          };
          const lead = leadOf(sessionId);
          // Its plan is written where its orchestrator reads it: never into a folder of the user's it was resumed in.
          if (lead === undefined || !sources.agents.get(sessionId)!.ownsWorktree) {
            const waited = host.presentPlan(sessionId, spec, closed(connection));
            if (optionalBooleanParam(p, 'onBoard') === true && options.addCard !== undefined) {
              options.addCard(sessionId).catch((error: unknown) => options.log?.(`could not put the plan card on the board: ${(error as Error).message}`));
            }
            return waited;
          }
          const title = text(spec.title, 'title', MAX_PLAN_TITLE_LENGTH);
          planBody(spec.body);
          const crewPath = CREW_PLAN_PATH[spec.format];
          writeForLead(sessionId, crewPath, spec.body);
          return sendToLead(sessionId, lead, `plan to review, in ${crewPath}: ${title}`);
        },
        'ask.answer': (params) => {
          const p = paramsObject(params);
          const sessionId = sessionOf(p);
          host.answer(sessionId, stringParam(p, 'askId'), askAnswer(p.answer));
          return null;
        },
        'ask.place': (params) => {
          const p = paramsObject(params);
          const at = paramsObject(p.at);
          host.place(sessionOf(p), stringParam(p, 'askId'), { x: finiteNumberParam(at, 'x'), y: finiteNumberParam(at, 'y') });
          return null;
        },
        'plan.list': (params) => host.plans(sessionOf(paramsObject(params))),
        'plan.decide': (params) => {
          const p = paramsObject(params);
          const comments = p.comments === undefined ? '' : stringParam(p, 'comments');
          return host.decide(sessionOf(p), stringParam(p, 'planId'), oneOf(p, 'outcome', PLAN_OUTCOMES), comments);
        },
        'plan.edit': (params) => {
          const p = paramsObject(params);
          return host.edit(sessionOf(p), stringParam(p, 'planId'), stringParam(p, 'body'));
        },
      };
    },

    close() {
      for (const sessionId of [...waiting.keys()]) host.drop(sessionId);
    },
  };
  return host;
}

/** A crew member's question as its orchestrator reads it in full: the question, then each option, numbered. */
function crewQuestionText(question: string, options: readonly string[]): string {
  const offered = options.map((option, index) => `${index + 1}. ${option}`);
  return [question, ...(offered.length === 0 ? [] : ['', 'Options:', '', ...offered])].join('\n') + '\n';
}

/** An answer off the wire: an option's index, the user's words, or a skip. */
function askAnswer(raw: unknown): AskAnswer {
  const answer = paramsObject(raw);
  if (answer.skip === true) return { skip: true };
  if (typeof answer.option === 'number') return { option: answer.option };
  if (typeof answer.text === 'string') return { text: answer.text };
  throw invalidParams('answer must be {option}, {text} or {skip: true}');
}
