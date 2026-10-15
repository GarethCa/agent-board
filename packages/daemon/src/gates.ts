// The merge gate: runs a zone's gate command in an agent's worktree when the user asks, follows its steps as
// it marks them (ADR-0013), and keeps its latest run per agent: in the database, with its logs as files under the data
// dir, per agent and commit, each capped. The app never runs it by itself, and agents can't (`BOARD_CALLER_METHODS`).
// The command is code from the agent's branch, so nothing it prints or does may bring the daemon down: every write and
// read for it is guarded, and a file it names is only ever read.
import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, createWriteStream, existsSync, mkdirSync, openSync, readSync, rmSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { stopGroup } from './flow-conditions.ts';
import { applyGateEvent, finishGateSteps, lineStep, parseGateLine } from './gate-output.ts';
import { failurePaste, gateCommandArgv, noGateCommand, shortCommit, type GateRun } from './gate-rules.ts';
import { runGit } from './git.ts';
import { invalidParams, optionalStringParam, paramsObject, stringParam } from './params.ts';
import { lineSplitter, type Agent, type DaemonEvent, type DaemonMethods, type GateLog, type GateStatus } from './protocol.ts';
import type { RpcHandlers } from './rpc.ts';
import { childEnv } from './sessions.ts';

export interface GateHostOptions {
  db: DatabaseSync;
  /** Where its logs go: `<dir>/<agent>/<commit>/`. */
  dir: string;
  agent(sessionId: string): Agent | undefined;
  /** The gate command for the agent, from the zone of its repo, and that zone's name; null for none. */
  command(sessionId: string): { command: string | null; zone: string | undefined };
  /**
   * Types `text` at the agent's prompt, refusing (by throwing) an agent that has ended or waits on a permission prompt,
   * as the composer does: checked as it writes.
   */
  paste(sessionId: string, text: string): void;
  /** The environment a gate starts from, less what only the daemon wants. */
  env: NodeJS.ProcessEnv;
  /** Reads the agent's worktree with git; tests stand in for it to hold a run between its process ending and its save. */
  readWorktree?(agent: Agent): Promise<WorktreeState>;
  broadcast(event: DaemonEvent): void;
  log(message: string): void;
}

type Methods = Pick<DaemonMethods, 'gate.list' | 'gate.status' | 'gate.run' | 'gate.stop' | 'gate.log' | 'gate.sendFailure'>;

/** The agent's worktree as it is now. */
export interface WorktreeState {
  /** The commit it is at; null when it has none, or is gone. */
  head: string | null;
  /** The branch it has checked out; null for a detached HEAD, or none. */
  branch: string | null;
  /** How many files are uncommitted, its `.agent-board/` notes aside. */
  uncommitted: number;
}

export interface GateHost {
  /** The agent's latest run, if it has one. */
  get(sessionId: string): GateRun | undefined;
  /** The agent's zone's gate command, or null for none. */
  command(sessionId: string): string | null;
  worktreeState(sessionId: string): Promise<WorktreeState>;
  /** Stops its gate, and forgets its runs and logs: the agent is going. */
  forget(sessionId: string): void;
  /** Stops every gate still running, as the daemon shuts down: from then on, nothing is saved. */
  stop(): void;
  handlers<Context>(): RpcHandlers<Methods, Context>;
}

/** The most `gate.log` gives at once. */
const MAX_LOG_PIECE = 256 * 1024;

/** The most any one of a run's logs keeps: past it, a line says so, and the rest is dropped. */
const MAX_LOG_BYTES = 10 * 1024 * 1024;

/** How often a step's own log file (`log=`) is read on while it runs. */
const FOLLOW_MS = 250;

/** The most read from a followed file at once. */
const FOLLOW_CHUNK = 1024 * 1024;

/** One of a run's logs: written in order through a stream, never blocking the daemon, and capped. */
interface RunLog {
  write(data: string | Buffer): void;
  /** Resolves once all it was given is written, or it failed. */
  close(): Promise<void>;
  /** Whether it took all it can. */
  readonly full: boolean;
}

function runLog(path: string, log: (message: string) => void): RunLog {
  const stream = createWriteStream(path, { flags: 'a' });
  let written = 0;
  let full = false;
  let failed = false;
  stream.on('error', (error) => {
    if (!failed) log(`gate: could not write ${path}: ${error.message}`);
    failed = true;
  });
  return {
    get full() {
      return full || failed;
    },
    write(data) {
      if (full || failed) return;
      const bytes = typeof data === 'string' ? Buffer.byteLength(data) : data.length;
      if (written + bytes > MAX_LOG_BYTES) {
        full = true;
        stream.write(`… truncated: this log stops at ${MAX_LOG_BYTES / 1024 / 1024} MB\n`);
        return;
      }
      written += bytes;
      stream.write(data);
    },
    close: () =>
      new Promise((done) => {
        if (stream.closed) return done();
        stream.once('close', () => done());
        stream.end();
      }),
  };
}

/** One run in flight. */
interface Running {
  child: ChildProcess;
  stopped: boolean;
  /** Set once its agent has gone: nothing more is written, and its logs go as it ends. */
  forgotten: boolean;
  output: RunLog;
  /** Each step's own log, by its place in the run, made as it is first written. */
  stepLogs: Map<number, RunLog>;
  /** The steps whose files are being followed, by index, and how far each has been read. */
  following: Map<number, { path: string; read: number }>;
  timer: NodeJS.Timeout;
}

export function createGateHost(options: GateHostOptions): GateHost {
  const { db } = options;
  const upsert = db.prepare('INSERT INTO gate_runs (session_id, run) VALUES (?, ?) ON CONFLICT (session_id) DO UPDATE SET run = excluded.run');
  const runs = new Map<string, GateRun>();
  for (const row of db.prepare('SELECT session_id, run FROM gate_runs').all() as { session_id: string; run: string }[]) {
    const run = JSON.parse(row.run) as GateRun;
    // Its process went with the daemon that ran it.
    if (run.status === 'running') {
      const endedAt = new Date().toISOString();
      const ended: GateRun = { ...run, status: 'stopped', endedAt, steps: finishGateSteps(run.steps, { ...run, outcome: 'stopped', endedAt }) };
      upsert.run(row.session_id, JSON.stringify(ended));
      runs.set(row.session_id, ended);
    } else {
      runs.set(row.session_id, run);
    }
  }
  const running = new Map<string, Running>();
  /** Set as the daemon shuts down: its database closes, and the next daemon finds the runs it cut short (see above). */
  let closing = false;

  const save = (run: GateRun) => {
    if (closing) return;
    runs.set(run.sessionId, run);
    upsert.run(run.sessionId, JSON.stringify(run));
    options.broadcast({ type: 'gate.updated', run });
  };

  const agentDir = (sessionId: string) => join(options.dir, sessionId);
  const runDir = (run: Pick<GateRun, 'sessionId' | 'commit'>) => join(agentDir(run.sessionId), run.commit);
  /** A step's log, by its place in the run: its name may be anything a step's name may be, `..` too. */
  const stepLog = (run: GateRun, index: number) => join(runDir(run), 'steps', `${index}.log`);
  const outputLog = (run: GateRun) => join(runDir(run), 'output.log');
  /** Whether a run's command marked no steps, so its one step's log is all its output. */
  const unmarked = (run: GateRun) => run.steps.length === 1 && run.steps[0]!.name === run.command;

  const requireAgent = (sessionId: string): Agent => {
    const agent = options.agent(sessionId);
    if (agent === undefined) throw invalidParams(`no agent ${sessionId}`);
    return agent;
  };

  async function worktreeState(sessionId: string): Promise<WorktreeState> {
    const agent = requireAgent(sessionId);
    return (options.readWorktree ?? readWorktree)(agent);
  }

  async function readWorktree(agent: Agent): Promise<WorktreeState> {
    if (!existsSync(agent.worktree)) return { head: null, branch: null, uncommitted: 0 };
    const [head, branch, status] = await Promise.all([
      runGit(agent.worktree, ['rev-parse', '--verify', '--quiet', 'HEAD']),
      runGit(agent.worktree, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
      // Not the agent's own notes, such as its handover, which are the user's to commit or not.
      runGit(agent.worktree, ['status', '--porcelain', '--', '.', ':(exclude).agent-board']),
    ]);
    return {
      head: head.ok ? head.stdout : null,
      branch: branch.ok ? branch.stdout : null,
      uncommitted: status.stdout === '' ? 0 : status.stdout.split('\n').length,
    };
  }

  /** A file a `log=` may name: anywhere but the gate's own logs, which it would copy into themselves. */
  const followable = (path: string) => !resolve(path).startsWith(resolve(options.dir) + sep);

  /**
   * Reads on in each followed step file, into its step's own log, a chunk at a time (until it is caught up, with
   * `all`). A file that can't be read, or isn't a regular file, is no longer followed: its step says so in its log.
   */
  const follow = (flight: Running, stepLogOf: (index: number) => RunLog, only?: number, all = false) => {
    for (const [index, followed] of flight.following) {
      if (only !== undefined && index !== only) continue;
      const into = stepLogOf(index);
      try {
        const stat = statSync(followed.path, { throwIfNoEntry: false });
        // Not there yet: it may be made later.
        if (stat === undefined) continue;
        if (!stat.isFile()) throw new Error('not a regular file');
        if (stat.size < followed.read) followed.read = 0;
        while (followed.read < stat.size && !into.full) {
          const fd = openSync(followed.path, 'r');
          try {
            const buffer = Buffer.alloc(Math.min(FOLLOW_CHUNK, stat.size - followed.read));
            const got = readSync(fd, buffer, 0, buffer.length, followed.read);
            if (got === 0) break;
            followed.read += got;
            into.write(buffer.subarray(0, got));
          } finally {
            closeSync(fd);
          }
          if (!all) break;
        }
      } catch (error) {
        into.write(`could not read ${followed.path}: ${(error as Error).message}\n`);
        flight.following.delete(index);
      }
    }
  };

  async function start(sessionId: string): Promise<GateRun> {
    const agent = requireAgent(sessionId);
    if (running.has(sessionId)) throw invalidParams(`The gate is already running for ${agent.name}.`);
    const { command, zone } = options.command(sessionId);
    if (command === null) throw invalidParams(noGateCommand(zone));
    let argv: string[];
    try {
      argv = gateCommandArgv(command);
    } catch (error) {
      throw invalidParams((error as Error).message);
    }
    if (!existsSync(agent.worktree)) throw invalidParams(`${agent.name}'s worktree is gone.`);
    const { head, uncommitted } = await worktreeState(sessionId);
    if (head === null) throw invalidParams(`${agent.name}'s worktree has no commit to run the gate on.`);
    // Checked again: another call may have started one while git answered.
    if (running.has(sessionId)) throw invalidParams(`The gate is already running for ${agent.name}.`);
    let run: GateRun = { sessionId, command, commit: head, dirty: uncommitted > 0, startedAt: new Date().toISOString(), endedAt: null, status: 'running', exitCode: null, steps: [] };
    // A run on the same commit replaces the one before it, logs and all.
    rmSync(runDir(run), { recursive: true, force: true });
    mkdirSync(join(runDir(run), 'steps'), { recursive: true });
    const env: Record<string, string> = { ...childEnv(options.env), AGENT_BOARD_GATE: '1' };
    delete env.GIT_DIR;
    delete env.GIT_WORK_TREE;
    const child = spawn(argv[0]!, argv.slice(1), { cwd: agent.cwd, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    const stepLogOf = (index: number): RunLog => {
      let log = flight.stepLogs.get(index);
      if (log === undefined) {
        log = runLog(stepLog(run, index), options.log);
        flight.stepLogs.set(index, log);
      }
      return log;
    };
    const flight: Running = {
      child,
      stopped: false,
      forgotten: false,
      output: runLog(outputLog(run), options.log),
      stepLogs: new Map(),
      following: new Map(),
      timer: setInterval(() => !flight.forgotten && follow(flight, stepLogOf), FOLLOW_MS),
    };
    running.set(sessionId, flight);
    save(run);
    options.log(`gate: running ${command} for ${sessionId} on ${shortCommit(head)}`);

    const onLine = (line: string) => {
      if (flight.forgotten) return;
      flight.output.write(`${line}\n`);
      const event = parseGateLine(line);
      if (event.type === 'line') {
        const step = lineStep(run.steps);
        if (step !== undefined) stepLogOf(run.steps.findIndex((each) => each.name === step)).write(`${line}\n`);
        return;
      }
      const steps = applyGateEvent(run.steps, event, new Date().toISOString());
      if (event.type === 'start' && event.log !== undefined) {
        const index = steps.findIndex((step) => step.name === event.name);
        if (followable(event.log)) flight.following.set(index, { path: event.log, read: 0 });
        else stepLogOf(index).write(`not following ${event.log}: it is in the gate's own logs\n`);
      }
      if (event.type === 'end') {
        const index = steps.findIndex((step) => step.name === event.name);
        // What it wrote up to its end, then no more.
        follow(flight, stepLogOf, index, true);
        flight.following.delete(index);
      }
      run = { ...run, steps };
      save(run);
    };
    // Each stream split into lines of its own, so a line is never two halves.
    for (const stream of [child.stdout!, child.stderr!]) {
      stream.setEncoding('utf8');
      const split = lineSplitter(onLine);
      let last = '\n';
      stream.on('data', (chunk: string) => {
        if (chunk !== '') last = chunk.at(-1)!;
        split(chunk);
      });
      // Its last line, if it ended without a line break.
      stream.on('end', () => last !== '\n' && split('\n'));
    }
    let ended = false;
    // Once: a command that can't be spawned is heard of twice, as an error, then as closing. The run stays running until
    // it is saved, so its agent going meanwhile marks it forgotten, and Run gate again waits for it.
    const end = async (exitCode: number | null, problem?: string) => {
      if (ended) return;
      ended = true;
      clearInterval(flight.timer);
      if (!flight.forgotten) follow(flight, stepLogOf, undefined, true);
      if (problem !== undefined) flight.output.write(`${problem}\n`);
      // All of it on disk before the run is said to have ended, so its logs read whole.
      await Promise.all([flight.output.close(), ...[...flight.stepLogs.values()].map((log) => log.close())]);
      // Its agent went while it ran: its logs go now that nothing writes them.
      if (flight.forgotten) return void rmSync(agentDir(sessionId), { recursive: true, force: true });
      const endedAt = new Date().toISOString();
      const outcome = flight.stopped ? 'stopped' : exitCode === 0 && !run.steps.some((step) => step.status === 'failed') ? 'passed' : 'failed';
      // The agent may have moved on while it ran: a pass speaks for its commit only if the worktree is still just that.
      const after = await worktreeState(sessionId).catch(() => undefined);
      // Its agent went while git answered: nothing to save, and its logs go.
      if (flight.forgotten) return void rmSync(agentDir(sessionId), { recursive: true, force: true });
      const changed = after === undefined || after.head !== run.commit || after.uncommitted > 0;
      run = { ...run, status: outcome, dirty: run.dirty || changed, exitCode: flight.stopped ? null : exitCode, endedAt, steps: finishGateSteps(run.steps, { ...run, outcome, endedAt }) };
      save(run);
      options.log(`gate: ${command} for ${sessionId} ${outcome}${changed ? ', the worktree having changed meanwhile' : ''}`);
    };
    const ending = (exitCode: number | null, problem?: string) =>
      void end(exitCode, problem)
        .catch((error: Error) => options.log(`gate: could not end the run for ${sessionId}: ${error.message}`))
        .finally(() => {
          if (running.get(sessionId) === flight) running.delete(sessionId);
        });
    child.once('error', (error) => ending(null, `could not run ${argv[0]}: ${error.message}`));
    child.once('close', (code) => ending(code));
    return run;
  }

  function stopRun(sessionId: string): void {
    const flight = running.get(sessionId);
    if (flight === undefined) return;
    flight.stopped = true;
    stopGroup(flight.child);
  }

  function readLog(sessionId: string, step: string | undefined, since: number | undefined): GateLog {
    const run = runs.get(sessionId);
    if (run === undefined) throw invalidParams(`${requireAgent(sessionId).name} has no gate run`);
    let path = outputLog(run);
    if (step !== undefined) {
      const index = run.steps.findIndex((each) => each.name === step);
      if (index === -1) throw invalidParams(`the gate run has no step ${step}`);
      // A command that marked no steps is one step, whose log is all its output; a marked step that wrote nothing has none.
      if (existsSync(stepLog(run, index))) path = stepLog(run, index);
      else if (!unmarked(run)) return { text: '', next: 0, ...(since !== undefined && since > 0 ? { reset: true as const } : {}) };
    }
    let size = 0;
    try {
      size = statSync(path).size;
    } catch {
      // Nothing written yet.
    }
    const reset = since !== undefined && since > size;
    let from = since === undefined || reset ? Math.max(0, size - MAX_LOG_PIECE) : since;
    if (from >= size) return { text: '', next: size, ...(reset ? { reset } : {}) };
    const fd = openSync(path, 'r');
    try {
      const buffer = Buffer.alloc(Math.min(MAX_LOG_PIECE, size - from));
      const got = readSync(fd, buffer, 0, buffer.length, from);
      let piece = buffer.subarray(0, got);
      // Never half a line, and so never half a character: the rest comes next time.
      const lastLine = piece.lastIndexOf(0x0a);
      if (from + got < size && lastLine !== -1) piece = piece.subarray(0, lastLine + 1);
      // Read from the middle of the log: from its next line on.
      if (since === undefined && from > 0) {
        const firstLine = piece.indexOf(0x0a);
        from += firstLine + 1;
        piece = piece.subarray(firstLine + 1);
      }
      return { text: piece.toString('utf8'), next: from + piece.length, ...(reset ? { reset } : {}) };
    } finally {
      closeSync(fd);
    }
  }

  /** Pastes the failing step's last lines at the agent's prompt, sending nothing. */
  function sendFailure(sessionId: string, step: string): void {
    const run = runs.get(sessionId);
    if (run?.status !== 'failed' || !run.steps.some((each) => each.name === step && each.status === 'failed')) throw invalidParams(`the gate's last run for ${requireAgent(sessionId).name} didn't fail at ${step}`);
    const { text } = readLog(sessionId, step, undefined);
    try {
      options.paste(sessionId, failurePaste(run, step, text));
    } catch (error) {
      throw invalidParams((error as Error).message);
    }
  }

  return {
    get: (sessionId) => runs.get(sessionId),
    command: (sessionId) => options.command(sessionId).command,
    worktreeState,
    forget(sessionId) {
      const flight = running.get(sessionId);
      runs.delete(sessionId);
      if (flight === undefined) return void rmSync(agentDir(sessionId), { recursive: true, force: true });
      // Its logs go as it ends: output may still be on its way to them.
      flight.forgotten = true;
      stopRun(sessionId);
    },
    stop() {
      closing = true;
      for (const sessionId of running.keys()) stopRun(sessionId);
    },
    handlers<Context>(): RpcHandlers<Methods, Context> {
      return {
        'gate.list': () => [...runs.values()],
        'gate.status': async (params): Promise<GateStatus> => {
          const sessionId = stringParam(paramsObject(params), 'sessionId');
          const state = await worktreeState(sessionId);
          return { run: runs.get(sessionId) ?? null, command: options.command(sessionId).command, ...state };
        },
        'gate.run': (params) => start(stringParam(paramsObject(params), 'sessionId')),
        'gate.stop': (params) => {
          const sessionId = stringParam(paramsObject(params), 'sessionId');
          requireAgent(sessionId);
          stopRun(sessionId);
          return null;
        },
        'gate.log': (params) => {
          const fields = paramsObject(params);
          const since = fields.since;
          if (since !== undefined && (typeof since !== 'number' || !Number.isSafeInteger(since) || since < 0)) throw invalidParams('since must be a whole number of bytes');
          return readLog(stringParam(fields, 'sessionId'), optionalStringParam(fields, 'step'), since);
        },
        'gate.sendFailure': (params) => {
          const fields = paramsObject(params);
          sendFailure(stringParam(fields, 'sessionId'), stringParam(fields, 'step'));
          return null;
        },
      };
    },
  };
}
