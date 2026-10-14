import type { FakeSession } from './session.ts';

/** The scripted runs every fake harness can replay. Pick one with FAKE_HARNESS_SCENARIO. */
export const SCENARIOS = ['output', 'waiting', 'permission', 'two-permissions', 'subagent', 'subagent-permission', 'subagent-ask', 'subagents-working', 'review', 'crash', 'rate-limit', 'markdown'] as const;
export type FakeScenario = (typeof SCENARIOS)[number];

export function isScenario(name: string): name is FakeScenario {
  return (SCENARIOS as readonly string[]).includes(name);
}

type Script = (session: FakeSession, prompt: string) => Promise<void>;

/** The `review` scenario's doc for round 1, in the format a reviewer's prompt asks for. */
const FIRST_REVIEW = [
  '# Review of the work so far',
  '',
  'Verdict: Changes requested',
  '',
  '## Blocker',
  '- **The worktree moves while the PTY still holds its cwd** `src/sessions/move.ts:88`: the next command fails.',
  '',
  '## Major',
  '- **The migration has no down step** `src/migrations/0009_zone_id.sql:1`',
  '',
  '## Minor',
  '- **The e2e waits with sleep(500)** `e2e/move-session.spec.ts:57`: use the fake clock.',
].join('\n');

/** The `review` scenario's doc for every later round: the blocker and major fixed, the minor left. */
const LATER_REVIEW = [
  '# Review of the fixes',
  '',
  'Verdict: Approve',
  '',
  '## Blocker',
  '- ~~**The worktree moves while the PTY still holds its cwd**~~ `src/sessions/move.ts:88`',
  '',
  '## Major',
  '- ~~**The migration has no down step**~~ `src/migrations/0009_zone_id.sql:1`',
  '',
  '## Minor',
  '- **The e2e waits with sleep(500)** `e2e/move-session.spec.ts:57`: use the fake clock.',
].join('\n');

const scripts: Record<FakeScenario, Script> = {
  /** Streams output, runs one tool, finishes the turn and exits. */
  async output(session, prompt) {
    await session.submit(prompt);
    await session.say("I'll run the test suite first.");
    await session.runTool(session.shellTool, { command: 'npm test', description: 'Run test suite' }, { stdout: '12 passed', stderr: '', interrupted: false });
    await session.say('All tests pass.');
    await session.stop();
  },

  /** Asks a question, sits waiting for input, then acts on the reply with one tool call. */
  async waiting(session, prompt) {
    await session.submit(prompt);
    await session.say('Which database should I use, Postgres or SQLite?');
    await session.stop();
    const reply = await session.waitForInput();
    if (reply === undefined) await session.end('prompt_input_exit');
    const choice = reply!.trim();
    await session.submit(reply!);
    await session.runTool(
      session.shellTool,
      { command: `echo ${JSON.stringify(choice)} > db.txt && echo saved`, description: 'Record the choice' },
      { stdout: 'saved', stderr: '', interrupted: false },
    );
    await session.say(`Going with ${choice}.`);
    await session.stop();
  },

  /** Needs permission for a shell command; allowed by a hook decision or a typed y/n. */
  async permission(session, prompt) {
    await session.submit(prompt);
    await session.say('I need to delete the build folder.');
    const ran = await session.runTool(
      session.shellTool,
      { command: 'rm -rf dist', description: 'Remove build output' },
      { stdout: '', stderr: '', interrupted: false },
      true,
    );
    await session.say(ran ? 'Removed dist.' : 'Okay, I left dist alone.');
    await session.stop();
  },

  /** Needs permission for two shell commands one after the other, each allowed by a hook decision or a typed y/n. */
  async 'two-permissions'(session, prompt) {
    await session.submit(prompt);
    await session.say('I need to delete two folders.');
    const clean = (target: string) =>
      session.runTool(
        session.shellTool,
        { command: `rm -rf ${target}`, description: `Remove ${target}` },
        { stdout: '', stderr: '', interrupted: false },
        true,
      );
    const dist = await clean('dist');
    const build = await clean('build');
    await session.say(`${dist ? 'Removed dist.' : 'Left dist alone.'} ${build ? 'Removed build.' : 'Left build alone.'}`);
    await session.stop();
  },

  /** Hands part of the work to a subagent and reports its result. */
  async subagent(session, prompt) {
    await session.submit(prompt);
    await session.say("I'll send an explorer to map the codebase.");
    await session.spawnSubagent('Explore', 'Find where sessions are created', 'Sessions are created in src/daemon/sessions.ts.');
    await session.say('The explorer found where sessions are created.');
    await session.stop();
  },

  /**
   * Sends two subagents at once, each needing permission for a shell command, so two permission requests are in
   * flight together. Each reports whether its command ran.
   */
  async 'subagent-permission'(session, prompt) {
    await session.submit(prompt);
    await session.say("I'll send two workers to clean up.");
    const clean = (target: string, report: [string, string]) =>
      session.spawnSubagent('general-purpose', `Remove ${target}`, async (inside) => {
        const ran = await session.runTool(
          session.shellTool,
          { command: `rm -rf ${target}`, description: `Remove ${target}` },
          { stdout: '', stderr: '', interrupted: false },
          true,
          inside,
        );
        return ran ? report[0] : report[1];
      });
    await Promise.all([clean('dist', ['Removed dist.', 'Left dist alone.']), clean('build', ['Removed build.', 'Left build alone.'])]);
    await session.say('Both workers are done.');
    await session.stop();
  },

  /**
   * Sends a scout and a cleaner at once. The scout works for `FAKE_HARNESS_SUBAGENT_WORK_MS` (0 by default); the cleaner
   * needs permission for one fixed command, so exactly one request is in flight and which one it is never depends on timing.
   */
  async 'subagent-ask'(session, prompt) {
    await session.submit(prompt);
    await session.say("I'll send a scout and a cleaner.");
    const workMs = Number(process.env.FAKE_HARNESS_SUBAGENT_WORK_MS ?? 0);
    await Promise.all([
      session.spawnSubagent('Explore', 'Map the build folder', async () => {
        await new Promise((resolve) => setTimeout(resolve, workMs));
        return 'Mapped the build folder.';
      }),
      session.spawnSubagent('general-purpose', 'Remove build', async (inside) => {
        const ran = await session.runTool(
          session.shellTool,
          { command: 'rm -rf build', description: 'Remove build' },
          { stdout: '', stderr: '', interrupted: false },
          true,
          inside,
        );
        return ran ? 'Removed build.' : 'Left build alone.';
      }),
    ]);
    await session.say('Both workers are done.');
    await session.stop();
  },

  /**
   * Sends three subagents of different kinds at once, and keeps them running for `FAKE_HARNESS_SUBAGENT_WORK_MS` (0 by
   * default: they finish at once). With a long time the tile shows its characters at work, for screenshots.
   */
  async 'subagents-working'(session, prompt) {
    await session.submit(prompt);
    await session.say("I'll split this across three workers.");
    const workMs = Number(process.env.FAKE_HARNESS_SUBAGENT_WORK_MS ?? 0);
    const work = (result: string) => async () => {
      await new Promise((resolve) => setTimeout(resolve, workMs));
      return result;
    };
    await Promise.all([
      session.spawnSubagent('Explore', 'Map the module', work('Mapped the module.')),
      session.spawnSubagent('general-purpose', 'Update the callers', work('Updated the callers.')),
      session.spawnSubagent('general-purpose', 'Write the tests', work('Wrote the tests.')),
    ]);
    await session.say('All three workers are done.');
    await session.stop();
  },

  /**
   * A reviewer: a prompt for round 1 of a review ends on a review doc asking for changes, a later round's on
   * one approving them. Any other prompt plays `output`.
   */
  async review(session, prompt) {
    const round = /reviewer for round (\d+)/.exec(prompt);
    if (round === null) return scripts.output(session, prompt);
    await session.submit(prompt);
    await session.runTool(session.shellTool, { command: 'git diff main...HEAD', description: 'Read the diff' }, { stdout: '', stderr: '', interrupted: false });
    await session.say(round[1] === '1' ? FIRST_REVIEW : LATER_REVIEW);
    await session.stop();
  },

  /** Dies mid-turn with a non-zero exit and no Stop or SessionEnd. */
  async crash(session, prompt) {
    await session.submit(prompt);
    await session.say('Starting work on');
    session.crash('fatal: simulated crash');
  },

  /**
   * Works through a run of tool calls, then answers in Markdown; and answers the next message in Markdown too, its
   * lines quoted back.
   */
  async markdown(session, prompt) {
    await session.submit(prompt);
    await session.say('Looking at the code.');
    await session.runTool('Read', { file_path: 'src/cli.ts' }, 'one\ntwo');
    await session.runTool('Read', { file_path: 'src/daemon.ts' }, 'three');
    await session.runTool(session.shellTool, { command: 'pnpm test', description: 'Run the tests' }, { stdout: '12 passed', stderr: '', interrupted: false });
    await session.runTool('Grep', { pattern: 'TODO' }, 'src/cli.ts:3: TODO');
    await session.say('Found **one** TODO, in `src/cli.ts`.');
    await session.stop();
    const reply = await session.waitForInput();
    if (reply === undefined) await session.end('prompt_input_exit');
    await session.submit(reply!);
    await session.say(
      ['## The plan', '', ...reply!.split('\n').map((line) => `- ${line.trim()}`), '', '```ts', 'const answer: number = 42;', '```'].join('\n'),
    );
    await session.stop();
  },

  /** The turn fails on a rate limit (Claude's StopFailure; Codex prints the error only). */
  async 'rate-limit'(session, prompt) {
    await session.submit(prompt);
    await session.failTurn('rate_limit', '429 Too Many Requests');
  },
};

/**
 * Starts the session and runs the scenario's script (not for a conversation resumed without a prompt). Then, like the real CLIs: print/exec mode exits; an
 * interactive session sits idle at the prompt, runs each further stdin line as a plain turn (or, with `repeat`, as
 * the scenario again), and exits on EOF. Ctrl-C interrupts any turn, the script's included.
 */
export async function play(
  session: FakeSession,
  scenario: FakeScenario,
  prompt: string | undefined,
  repeat = false,
): Promise<void> {
  await session.start();
  // A conversation resumed with no new prompt carries on at the prompt: its scripted turn has been played already.
  if (!(session.resumed && prompt === undefined)) {
    const firstPrompt = prompt ?? (await session.readLine());
    if (firstPrompt === undefined) await session.end('prompt_input_exit');
    await session.interruptible(() => scripts[scenario](session, firstPrompt!));
    if (!session.interactive) await session.end('other');
  }
  for (;;) {
    const line = await session.waitForInput();
    if (line === undefined) await session.end('prompt_input_exit');
    if (repeat) {
      await session.interruptible(() => scripts[scenario](session, line!));
      continue;
    }
    await session.interruptible(async () => {
      await session.submit(line!);
      await session.say(`Done: ${line!.trim()}.`);
      await session.stop();
    });
  }
}
