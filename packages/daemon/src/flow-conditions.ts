import { spawn, type ChildProcess } from 'node:child_process';
import type { PullRequest } from '@agent-board/tracker';
import type { FlowCommandPlan, FlowCondition, FlowConditionCheck } from './protocol.ts';
import { childEnv } from './sessions.ts';

/** How long a custom script may run before it counts as failed. */
const SCRIPT_TIMEOUT_MS = 60_000;
/** How long a gate may run: a whole check suite. */
const GATE_TIMEOUT_MS = 20 * 60_000;
/** How much of a command's output is kept: its end, which is all a condition's detail shows. */
export const OUTPUT_TAIL = 16 * 1024;
/** How long a command told to stop gets before it is killed. */
const KILL_GRACE_MS = 2_000;

/** The agent at an edge's start, whose conditions they are. */
export interface ConditionAgent {
  sessionId: string;
  worktree: string;
}

/** How a command ran: its exit code (null when it didn't exit by itself), whether it ran out of time, and its output's end. */
export interface RunResult {
  code: number | null;
  timedOut: boolean;
  output: string;
}

/** The commands an edge's owner approved: each command's fingerprint as it was approved (`commandPlan`). */
export type Approvals = Readonly<Record<string, string>>;

/** Where conditions look. */
export interface ConditionSources {
  /** The agent's pull requests, newest first, as last seen. */
  pullRequests(sessionId: string): PullRequest[];
  /** The labels of the agent's linked issue, or why there are none to read (no linked issue, no tracker). */
  issueLabels(sessionId: string): Promise<string[] | string>;
  /** What `command` runs in `cwd` now, to hold it to its approval (`commandPlan`). */
  plan(command: string, cwd: string): Promise<FlowCommandPlan>;
  /** Runs `command` in a shell in `cwd`. */
  run(command: string, cwd: string, timeoutMs: number): Promise<RunResult>;
  /** The worktree's head commit, if it has one. */
  headCommit(cwd: string): Promise<string | undefined>;
  now(): Date;
}

export interface ConditionChecker {
  /** Checks one condition. A gate or script runs only if `approvals` has what its command runs now. */
  one(condition: FlowCondition, agent: ConditionAgent, approvals: Approvals): Promise<FlowConditionCheck>;
  /**
   * Checks every condition, so each says how it did: the quick ones first, and a gate (a whole suite) only once they
   * have all passed.
   */
  all(conditions: readonly FlowCondition[], agent: ConditionAgent, approvals: Approvals): Promise<FlowConditionCheck[]>;
}

/** The last non-empty line of a command's output, as short as a condition's detail should be. */
const lastLine = (output: string) =>
  output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1)
    ?.slice(0, 200);

/** What a command that didn't pass says: how it ended, and its last line. */
function failure({ code, timedOut, output }: RunResult): string {
  const said = lastLine(output);
  const how = timedOut ? 'timed out' : code === null ? 'was stopped' : `exited ${code}`;
  return said === undefined ? how : `${how}: ${said}`;
}

type Verdict = Omit<FlowConditionCheck, 'at'>;

/**
 * Checks an edge's conditions. A gate or script runs only what its edge's owner approved: if what its command
 * runs has changed since (the package.json script it names was edited), it isn't run, and waits for approval again. A
 * gate runs once per head commit of a worktree and what its command runs, its run shared by every edge that asks
 * meanwhile: a red gate goes green only once the agent commits a fix, and two edges out of one agent never run the
 * same suite side by side in its worktree.
 */
export function createConditionChecker(sources: ConditionSources): ConditionChecker {
  /** The gate's verdict, or its run in flight, per worktree and what its command runs, and the head commit it is for. */
  const gates = new Map<string, { head: string; verdict: Promise<Verdict> }>();

  /** Why `command` may not run now, or undefined when it is approved as it is. */
  const unapproved = async (command: string, agent: ConditionAgent, approvals: Approvals) => {
    const approved = Object.hasOwn(approvals, command) ? approvals[command] : undefined;
    if (approved === undefined) return { fingerprint: undefined, why: 'waiting for your approval' };
    const { fingerprint } = await sources.plan(command, agent.worktree);
    return { fingerprint, why: approved === fingerprint ? undefined : 'changed since you approved it: waiting for your approval' };
  };

  const gate = async (command: string, fingerprint: string, agent: ConditionAgent): Promise<Verdict> => {
    const head = await sources.headCommit(agent.worktree);
    const run = async () => {
      const result = await sources.run(command, agent.worktree, GATE_TIMEOUT_MS);
      const at = head === undefined ? '' : ` at ${head.slice(0, 7)}`;
      return result.code === 0 ? { passed: true, detail: `green${at}` } : { passed: false, detail: `red${at}: ${failure(result)}` };
    };
    if (head === undefined) return run();
    const key = `${agent.worktree}\0${command}\0${fingerprint}`;
    const known = gates.get(key);
    if (known !== undefined && known.head === head) return known.verdict;
    const verdict = run();
    gates.set(key, { head, verdict });
    return verdict;
  };

  const verdict = async (condition: FlowCondition, agent: ConditionAgent, approvals: Approvals): Promise<Verdict> => {
    if (condition.kind === 'script' || condition.kind === 'gate-green') {
      const { fingerprint, why } = await unapproved(condition.command, agent, approvals);
      if (why !== undefined) return { passed: false, detail: why, needsApproval: true };
      if (condition.kind === 'gate-green') return gate(condition.command, fingerprint!, agent);
      const result = await sources.run(condition.command, agent.worktree, SCRIPT_TIMEOUT_MS);
      return result.code === 0 ? { passed: true, detail: 'exited 0' } : { passed: false, detail: failure(result) };
    }
    switch (condition.kind) {
      case 'pr-checks': {
        const newest = sources.pullRequests(agent.sessionId)[0];
        if (newest === undefined) return { passed: false, detail: 'no pull request yet' };
        if (newest.checks === 'none') return { passed: false, detail: `PR #${newest.number} has no checks yet` };
        return { passed: newest.checks === 'passing', detail: `PR #${newest.number} checks ${newest.checks}` };
      }
      case 'issue-label': {
        let labels: string[] | string;
        try {
          labels = await sources.issueLabels(agent.sessionId);
        } catch (error) {
          return { passed: false, detail: `could not read the labels: ${(error as Error).message}` };
        }
        if (typeof labels === 'string') return { passed: false, detail: labels };
        const wanted = condition.label.toLowerCase();
        return labels.some((label) => label.toLowerCase() === wanted)
          ? { passed: true, detail: `has ${condition.label}` }
          : { passed: false, detail: `no ${condition.label} label` };
      }
    }
  };

  const one = async (condition: FlowCondition, agent: ConditionAgent, approvals: Approvals): Promise<FlowConditionCheck> => {
    const { passed, detail, needsApproval } = await verdict(condition, agent, approvals);
    return { passed, at: sources.now().toISOString(), detail, ...(needsApproval && { needsApproval }) };
  };
  return {
    one,
    async all(conditions, agent, approvals) {
      const quick = await Promise.all(
        conditions.map((condition) => (condition.kind === 'gate-green' ? undefined : one(condition, agent, approvals))),
      );
      const failed = quick.some((check) => check?.passed === false);
      /** A gate not run while another condition fails, unless it waits for approval anyway. */
      const waiting = async (command: string): Promise<FlowConditionCheck> => {
        const { why } = await unapproved(command, agent, approvals);
        const at = sources.now().toISOString();
        return why === undefined
          ? { passed: false, at, detail: 'not run until the other conditions pass' }
          : { passed: false, at, detail: why, needsApproval: true };
      };
      return Promise.all(
        quick.map((check, index) => {
          if (check !== undefined) return check;
          const gate = conditions[index] as Extract<FlowCondition, { kind: 'gate-green' }>;
          return failed ? waiting(gate.command) : one(gate, agent, approvals);
        }),
      );
    },
  };
}

export interface ShellRunner {
  /**
   * Runs `command` with `sh -c` in `cwd`, as a condition's gate or script, in a process group of its own: past
   * `timeoutMs` the whole group is stopped, not just the shell. Its environment is the daemon's, less what only the
   * daemon wants (`childEnv`) and any GIT_DIR/GIT_WORK_TREE, so git in it works on `cwd`. Only the end of its output is
   * kept, however much it writes.
   */
  run(command: string, cwd: string, timeoutMs: number): Promise<RunResult>;
  /** Stops every command still running, as the daemon shuts down. */
  stop(): void;
}

/** Stops the process group led by `child`: asks, then after a grace kills. */
function stopGroup(child: ChildProcess): void {
  const signal = (name: NodeJS.Signals) => {
    try {
      // A negative pid is the whole group, on POSIX; Windows has no groups, so only the shell.
      if (process.platform === 'win32') child.kill(name);
      else process.kill(-child.pid!, name);
    } catch {
      // Gone already.
    }
  };
  signal('SIGTERM');
  setTimeout(() => signal('SIGKILL'), KILL_GRACE_MS).unref();
}

export function createShellRunner(base: NodeJS.ProcessEnv = process.env): ShellRunner {
  const running = new Set<ChildProcess>();
  return {
    run(command, cwd, timeoutMs) {
      const env = childEnv(base);
      delete env.GIT_DIR;
      delete env.GIT_WORK_TREE;
      return new Promise((resolve) => {
        let output = '';
        let timedOut = false;
        const child = spawn('sh', ['-c', command], { cwd, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
        running.add(child);
        const keep = (chunk: Buffer) => {
          output = (output + chunk.toString('utf8')).slice(-OUTPUT_TAIL);
        };
        child.stdout!.on('data', keep);
        child.stderr!.on('data', keep);
        const timer = setTimeout(() => {
          timedOut = true;
          stopGroup(child);
        }, timeoutMs);
        const done = (result: RunResult) => {
          clearTimeout(timer);
          running.delete(child);
          resolve(result);
        };
        child.once('error', (error) => done({ code: null, timedOut, output: `${output}\ncould not run it: ${error.message}` }));
        child.once('close', (code) => done({ code: timedOut ? null : code, timedOut, output }));
      });
    },
    stop() {
      for (const child of running) stopGroup(child);
    },
  };
}
