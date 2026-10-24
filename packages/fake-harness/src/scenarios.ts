import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FakeSession } from './session.ts';

/** The scripted runs every fake harness can replay. Pick one with FAKE_HARNESS_SCENARIO. */
export const SCENARIOS = ['output', 'waiting', 'permission', 'two-permissions', 'long-permission', 'subagent', 'subagent-permission', 'subagent-ask', 'subagents-working', 'review', 'board', 'ask-plan', 'orchestrate', 'crash', 'rate-limit', 'markdown', 'ask-selection', 'background'] as const;
export type FakeScenario = (typeof SCENARIOS)[number];

export function isScenario(name: string): name is FakeScenario {
  return (SCENARIOS as readonly string[]).includes(name);
}

type Script = (session: FakeSession, prompt: string) => Promise<void>;

/** `text` single-quoted for the shell, a quote in it closed, escaped and opened again. */
const shellQuoted = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;

/** A shell command writing `text` to `path`, making its folder: printf's %b turns each \n back into a line break. */
const writeFileCommand = (path: string, text: string) =>
  `mkdir -p "$(dirname ${shellQuoted(path)})" && printf '%b' ${shellQuoted(text.replaceAll('\\', '\\\\').replaceAll('\n', '\\n'))} > ${shellQuoted(path)}`;

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

/**
 * An HTML plan that tries everything a plan's page must not: reach `url` by fetch, an image, a form post and a
 * navigation, open a window and the print dialog, and find the app's API or Node. It writes what it could into its title, once past `print()`, and its heading
 * says it ran: `fetch:blocked image:blocked app:none node:none`. The navigation and `window.open` come last.
 */
function hostilePlan(url: string): string {
  const target = JSON.stringify(url);
  return `<!doctype html>
<html><head><title>untried</title></head>
<body>
<h1 id="plan">A plan in HTML</h1>
<form id="post" method="post" action=${target}><input name="x" value="1"></form>
<script>
const results = [];
const report = () => { document.title = results.join(' '); };
const tryFetch = fetch(${target}).then(() => 'fetch:reached', () => 'fetch:blocked');
const tryImage = new Promise((done) => { const img = new Image(); img.onload = () => done('image:reached'); img.onerror = () => done('image:blocked'); img.src = ${target} + 'pixel.png'; });
results.push('app:' + (typeof window.agentBoard === 'undefined' ? 'none' : 'reachable'));
results.push('node:' + (typeof require === 'undefined' && typeof process === 'undefined' ? 'none' : 'reachable'));
document.getElementById('plan').textContent = 'The script ran';
Promise.all([tryFetch, tryImage]).then((tried) => {
  results.unshift(...tried);
  // The OS print dialog would hold the script here, and could be opened again and again: the title says it got past.
  window.print();
  report();
  window.open(${target});
  document.getElementById('post').submit();
  setTimeout(() => { location.href = ${target}; }, 50);
});
</script>
</body></html>`;
}

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

  /** Needs permission for a shell command that is the whole prompt, however long: a tile's ask can be as long as that. */
  async 'long-permission'(session, prompt) {
    await session.submit(prompt);
    await session.say('I need to run a long command.');
    await session.runTool(session.shellTool, { command: prompt, description: 'Run it' }, { stdout: '', stderr: '', interrupted: false }, true);
    await session.stop();
  },

  /**
   * Leaves the prompt, a shell command, running in the background and ends its turn, with its idle prompt after
   * `FAKE_HARNESS_IDLE_NOTIFY_MS`. Claude takes
   * up a turn of its own when the command ends, as a background command reporting back, firing no hook for its first
   * second, and ends on `The command finished.`; Codex stays at its prompt.
   */
  async background(session, prompt) {
    await session.submit(prompt);
    const { ended } = await session.runInBackground(prompt);
    await session.say('The command is running in the background.');
    await session.stop();
    await new Promise((resolve) => setTimeout(resolve, session.idleNotifyMs));
    await session.idlePrompt();
    await ended;
    if (!session.takesUpBackgroundResults) return;
    session.resume();
    // A moment to read the result before its first hook, as the model takes.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await session.say('The command finished.');
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

  /**
   * Finds its way round agent-board as a model told once would (ADR-0010): reads the board MCP server's instructions,
   * calls its `whoami` tool and sets its status to the prompt's first line at 10% with `set_status`. Then, for real in
   * its shell, runs `agent-board identify`, sets the same status at 20% with `agent-board status set`, and looks for
   * the hook env. Without the server it only runs the shell commands.
   */
  async board(session, prompt) {
    await session.submit(prompt);
    const summary = prompt.split('\n', 1)[0]!;
    const instructions = await session.mcpInstructions('agent-board');
    await session.say(instructions === undefined ? 'There is no agent-board MCP server here.' : `The board says: ${instructions}`, true);
    await session.callMcpTool('agent-board', 'whoami', {});
    await session.callMcpTool('agent-board', 'set_status', { summary, progress: 10 });
    await session.runShell('agent-board identify');
    await session.runShell(`agent-board status set --progress 20 -- '${summary.replaceAll("'", `'\\''`)}'`);
    await session.runShell('echo "hook env: ${AGENT_BOARD_HOOK_TOKEN:-none} ${AGENT_BOARD_HOOK_URL:-none}"');
    await session.say('I know where I am.');
    await session.stop();
  },

  /**
   * Asks the user and presents plans through the board MCP, by prompt, then ends its turn on what it was told.
   * `Ask: <question> | <option> | …` asks with those options and a reply field (`Ask only: …` without the field);
   * `Ask in words: <question>` asks with no options; `Ask briefly: <question>` waits a minute at most; `Ask on the board:
   * …` asks for a question card too; `Identify, then ask: …` prints its board token first; `Ask and give up: <question>` asks and, as a harness whose own tool timeout
   * passes first, drops the call after half a second with no cancel and ends its turn. `Plan: <title>`
   * presents a Markdown plan and, if changes are asked for, a v2 with the comments in it, until a decision other than
   * changes. `Plan HTML: <url>` presents an HTML plan that tries to reach `<url>` (fetch, an image, a form, a navigation,
   * `window.open`) and the app, and says in its title what it could. `Plan file: <path>` presents the file at `<path>`.
   * `Flag: <reason>` asks for a look with `needs_you` and ends its turn, nothing waiting. `Doc: <path>` writes a short
   * release plan in Markdown to `<path>` (an `.html` path, a page) and shows it with `show_doc`; `Doc on the board:
   * <path>` shows it as a card on the board too. Nothing waits on either. `Plan doc on the board: <path>` writes a
   * migration plan in Markdown to `<path>` and shows it with `show_doc` as a plan with its card on the board, waiting
   * for the decision. `Pins: <path>` writes and shows that Markdown file, then pins it as `Report`, a `shot.png` beside
   * it, a link to `http://localhost:9/preview` and a note labelled `Test logins`.
   */
  async 'ask-plan'(session, prompt) {
    await session.submit(prompt);
    const say = async (result: { text: string } | undefined) => {
      await session.say(result?.text ?? 'There is no agent-board MCP server here.');
      await session.stop();
    };
    // Its board token on its screen first, for a test to act as the agent with.
    if (prompt.startsWith('Identify, then ask')) await session.runShell('echo "identity:$AGENT_BOARD_IDENTITY:end"');
    const givenUp = /^Ask and give up: (.*)/.exec(prompt)?.[1];
    if (givenUp !== undefined) {
      return say(await session.callMcpTool('agent-board', 'ask', { question: givenUp }, { giveUpMs: 500 }));
    }
    const ask = /^(?:Identify, then )?[Aa]sk( only| in words| briefly| on the board)?: (.*)/.exec(prompt);
    if (ask !== null) {
      const [question, ...options] = ask[2]!.split(' | ');
      const args = ask[1] === ' in words' ? { question } : { question, options, free_text: ask[1] !== ' only' };
      const how = ask[1] === ' briefly' ? { timeout_minutes: 1 } : ask[1] === ' on the board' ? { on_board: true } : {};
      return say(await session.callMcpTool('agent-board', 'ask', { ...args, ...how }));
    }
    const flag = /^Flag: (.*)/.exec(prompt)?.[1];
    if (flag !== undefined) return say(await session.callMcpTool('agent-board', 'needs_you', { reason: flag }));
    const doc = /^(?:Doc|(Pins))( on the board)?: (.*)/.exec(prompt);
    if (doc !== null) {
      const [pins, onBoard, path] = [doc[1], doc[2], doc[3]!];
      const text = /\.html?$/.test(path)
        ? '<html><head><title>Cache benchmark</title></head><body><h1>Cache benchmark</h1><p>SQLite 41 ms.</p></body></html>\n'
        : '# Release 1.4 plan\n\n## Order\nMerge the flake fix first, then the pin bump.\n' +
          // A long page, for a card that is dragged tall enough to show more of it.
          (/long/.test(path) ? Array.from({ length: 14 }, (_, at) => `- Step ${at + 1}: check the release gate\n`).join('') : '');
      await session.runShell(writeFileCommand(path, text));
      const shown = await session.callMcpTool('agent-board', 'show_doc', { path, ...(onBoard === undefined ? {} : { on_board: true }) });
      if (pins === undefined) return say(shown);
      await session.runShell(`printf 'png' > "$(dirname '${path}')/shot.png"`);
      await session.callMcpTool('agent-board', 'pin', { path, label: 'Report' });
      await session.callMcpTool('agent-board', 'pin', { path: path.replace(/[^/]*$/, 'shot.png') });
      await session.callMcpTool('agent-board', 'pin', { url: 'http://localhost:9/preview' });
      return say(await session.callMcpTool('agent-board', 'pin', { note: 'Seeded 3 users: ann, bob, cy', label: 'Test logins' }));
    }
    const planDoc = /^Plan doc on the board: (.*)/.exec(prompt)?.[1];
    if (planDoc !== undefined) {
      const text = '# Zone id migration\n\n## Steps\n\n- Add zone_id, nullable\n- Backfill from the board file\n- Make it NOT NULL\n';
      await session.runShell(writeFileCommand(planDoc, text));
      return say(await session.callMcpTool('agent-board', 'show_doc', { path: planDoc, plan: true, on_board: true }));
    }
    const plan = /^Plan: (.*)/.exec(prompt)?.[1];
    if (plan !== undefined) {
      let markdown = `# ${plan}\n\n## Steps\n\n1. Wrap \`getProduct()\` in a Redis cache, 5-minute TTL.\n2. Bust the key on \`product.updated\`.\n\n<script>document.title = 'ran'</script>`;
      for (;;) {
        const result = await session.callMcpTool('agent-board', 'present_plan', { title: plan, markdown });
        if (!/asked for changes/.test(result?.text ?? '')) return say(result);
        await session.say(result!.text);
        markdown += `\n3. ${/Their comments:\n([\s\S]*?)\n\nRevise/.exec(result!.text)?.[1] ?? 'As asked.'}`;
      }
    }
    const html = /^Plan HTML: (.*)/.exec(prompt)?.[1];
    if (html !== undefined) return say(await session.callMcpTool('agent-board', 'present_plan', { title: 'A hostile plan', html: hostilePlan(html) }));
    const file = /^Plan file: (.*)/.exec(prompt)?.[1];
    if (file !== undefined) return say(await session.callMcpTool('agent-board', 'present_plan', { title: 'Plan from a file', path: file }));
    return scripts.output(session, prompt);
  },

  /**
   * Orchestrators and their workers, by prompt. `Orchestrate: <task>` runs one through the agent-board MCP
   * tools and CLI: starts a worker with the task, waits for it, reads its handover, sends it a follow-up, waits again,
   * reads its reply and closes it. `Lead two: <task>` starts two workers with the task, one through the MCP tool and one
   * through the CLI, and leaves them running. `Hand off: <text>` writes `<text>` into `.agent-board/handover.md` and hands
   * it over its edges with the MCP `handoff` tool, `Hand off to <name>: <text>` over its edge to that agent
   * alone, and `Hand off by CLI: <text>` the same with `agent-board handoff`, each then ending its turn on `Handed off.`. `Wire a worker: <message>` starts a worker, waits for
   * its first turn, joins itself to it with an edge carrying a message (`add_edge`) and hands it `<message>` along it,
   * ending on `Wired.`. `Arrange a messy crew` starts workers `impl` and `review` with the CLI, scatters itself and them
   * about its zone (`agent-board move`), joins them with an edge and runs `agent-board arrange`, ending on `Arranged.`.
   * `Arrange by itself, then start three` turns auto-arrange on and ends its turn; its next prompt starts workers `one`,
   * `two` and `three` with the CLI, ending on `Started three.`.
   * `Lead a crowded crew: <task>` starts a worker with a long name, a role and a model, sets its status line, and starts a reviewer of it, leaving both running.
   * `Print your board identity` echoes the board token. `Gate in the background` ends two turns, each followed by its
   * idle prompt, as a gate runs in its background, then writes its handover and runs `agent-board handoff`.
   * `Work slowly` runs `sleep 5`; `Work slowly, then fail` and `Work slowly, then hit the rate limit` run it, then
   * fail the turn (Claude's StopFailure: `server_error`, `rate_limit`);
   * `Ask permission` plays `permission`; `Ask: …`, `Plan: …`, `Flag: …`, `Doc: …` and `Pins: …` play `ask-plan`; `Hit the rate limit` plays `rate-limit`. Any other prompt is a worker's:
   * it writes `.agent-board/handover.md` in its shell and ends on `STATUS: done`.
   */
  async orchestrate(session, prompt) {
    await session.submit(prompt);
    const task = /^Orchestrate: (.*)/.exec(prompt)?.[1];
    if (task !== undefined) {
      const started = await session.callMcpTool('agent-board', 'new_agent', { prompt: task, name: 'worker' });
      const ref = /agent:[0-9a-f]+/.exec(started?.text ?? '')?.[0];
      if (ref === undefined) {
        await session.say('I could not start a worker.');
        return session.stop();
      }
      await session.callMcpTool('agent-board', 'wait', { agents: [ref] });
      await session.runShell(`agent-board read ${ref} .agent-board/handover.md`);
      await session.callMcpTool('agent-board', 'send', { agent: ref, text: 'Also add a test' });
      await session.runShell(`agent-board wait ${ref}`);
      await session.callMcpTool('agent-board', 'read', { agent: ref });
      await session.runShell(`agent-board close ${ref}`);
      await session.say('The worker is done and closed.');
      return session.stop();
    }
    const lead = /^Lead two: (.*)/.exec(prompt)?.[1];
    if (lead !== undefined) {
      await session.callMcpTool('agent-board', 'new_agent', { prompt: lead, name: 'worker one' });
      await session.runShell(`agent-board new --name 'worker two' -- '${lead.replaceAll("'", `'\\''`)}'`);
      await session.say('Two workers started.');
      return session.stop();
    }
    const crowded = /^Lead a crowded crew: (.*)/.exec(prompt)?.[1];
    if (crowded !== undefined) {
      // An implementer with a long name and a role, its orchestrator's line on its tile and a reviewer of it, all while they start.
      const name = 'Rework the movable sessions follow-up so the dock keeps up';
      const started = await session.callMcpTool('agent-board', 'new_agent', { prompt: crowded, name, role: 'implementer', model: 'claude-opus-5-5' });
      const ref = /agent:[0-9a-f]+/.exec(started?.text ?? '')?.[0];
      if (ref === undefined) {
        await session.say('I could not start a worker.');
        return session.stop();
      }
      await session.callMcpTool('agent-board', 'set_status', { agent: ref, summary: 'Starting up' });
      await session.callMcpTool('agent-board', 'new_agent', { prompt: crowded, name: `${name} · review r1`, role: 'reviewer', base: ref });
      await session.say('A worker and its reviewer started.');
      return session.stop();
    }
    const handoff = /^Hand off(?: to (\S+))?( by CLI)?: (.*)/.exec(prompt);
    if (handoff !== null) {
      const [, to, cli, text] = handoff as unknown as [string, string | undefined, string | undefined, string];
      const path = '.agent-board/handover.md';
      await session.runShell(`mkdir -p .agent-board && printf '# Handover\\n\\n%s\\n' '${text.replaceAll("'", `'\\''`)}' > ${path}`);
      if (cli === undefined) await session.callMcpTool('agent-board', 'handoff', { handover_path: path, ...(to === undefined ? {} : { to }) });
      else await session.runShell(`agent-board handoff --handover ${path}${to === undefined ? '' : ` --to ${to}`}`);
      await session.say('Handed off.');
      return session.stop();
    }
    const wire = /^Wire a worker: (.*)/.exec(prompt)?.[1];
    if (wire !== undefined) {
      await session.callMcpTool('agent-board', 'new_agent', { prompt: 'Stand by', name: 'worker' });
      await session.callMcpTool('agent-board', 'wait', { agents: ['worker'] });
      await session.callMcpTool('agent-board', 'add_edge', { from: 'me', to: 'worker', carries: 'message' });
      await session.callMcpTool('agent-board', 'handoff', { to: 'worker', message: wire });
      await session.say('Wired.');
      return session.stop();
    }
    if (prompt === 'Arrange a messy crew') {
      await session.runShell("agent-board new --name impl -- 'Stand by' && agent-board new --name review -- 'Stand by'");
      await session.runShell('agent-board move impl --at 620,420 && agent-board move review --at 40,420 && agent-board move me --at 900,60');
      await session.runShell('agent-board edge add impl review --carries message && agent-board arrange');
      await session.say('Arranged.');
      return session.stop();
    }
    if (prompt === 'Arrange by itself, then start three') {
      await session.runShell('agent-board arrange --auto on');
      await session.say('Arranging by itself.');
      await session.stop();
      const next = await session.waitForInput();
      if (next === undefined) return;
      await session.submit(next);
      await session.runShell(['one', 'two', 'three'].map((name) => `agent-board new --name ${name} -- 'Stand by'`).join(' && '));
      await session.say('Started three.');
      return session.stop();
    }
    if (prompt === 'Print your board identity') {
      await session.runShell('echo "identity:$AGENT_BOARD_IDENTITY:end"');
      return session.stop();
    }
    if (prompt === 'Gate in the background') {
      // Ends two turns while its gate runs, each followed by its idle prompt, then hands off: finished once.
      await session.say('The gate is running in the background.');
      await session.stop();
      await session.idlePrompt();
      session.resume();
      await session.runShell('true');
      await session.say('Still running.');
      await session.stop();
      await session.idlePrompt();
      session.resume();
      await session.runShell("mkdir -p .agent-board && printf '# Handover\\n\\nThe gate is green.\\n' > .agent-board/handover.md");
      await session.runShell('agent-board handoff --handover .agent-board/handover.md');
      await session.say('Handed off.');
      return session.stop();
    }
    if (prompt === 'Work slowly') {
      await session.runShell('sleep 5');
      await session.say('Slow work done.');
      return session.stop();
    }
    if (prompt === 'Work slowly, then fail' || prompt === 'Work slowly, then hit the rate limit') {
      await session.runShell('sleep 5');
      return prompt.endsWith('fail') ? session.failTurn('server_error', '500 Internal Server Error') : session.failTurn('rate_limit', '429 Too Many Requests');
    }
    if (prompt === 'Ask permission') return scripts.permission(session, prompt);
    if (/^(Ask( only| in words| briefly| on the board)?|Plan( doc on the board)?|Flag|Doc( on the board)?|Pins): /.test(prompt)) return scripts['ask-plan'](session, prompt);
    if (prompt === 'Hit the rate limit') return session.failTurn('rate_limit', '429 Too Many Requests');
    await session.runShell("mkdir -p .agent-board && printf '# Handover\\n\\nThe work is done.\\n' > .agent-board/handover.md");
    await session.say('Handover written.\nSTATUS: done');
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

  /**
   * Answers an Ask Claude about a selection: reads the picture and the diagram its prompt names, and says what it was
   * given (the picture's size, the nodes' text, the arrows), so a test can check what was sent. With the prompt asking
   * for suggestions, it suggests one: an outbox beside the last node, joined to it. Follow-ups get a plain answer.
   */
  async 'ask-selection'(session, prompt) {
    await session.submit(prompt);
    await session.say(selectionAnswer(prompt, session.permissionMode));
    await session.stop();
    for (;;) {
      const reply = await session.waitForInput();
      if (reply === undefined) await session.end('prompt_input_exit');
      await session.submit(reply!);
      await session.say(`On "${reply!.trim()}": keep the outbox.`);
      await session.stop();
    }
  },

  /** The turn fails on a rate limit (Claude's StopFailure; Codex prints the error only). */
  async 'rate-limit'(session, prompt) {
    await session.submit(prompt);
    await session.failTurn('rate_limit', '429 Too Many Requests');
  },
};

/** What the `ask-selection` scenario says of the picture and the diagram its prompt names. */
function selectionAnswer(prompt: string, mode: string): string {
  const picture = /The picture: `([^`]+\.png)`/.exec(prompt)?.[1];
  const bytes = picture === undefined ? undefined : readFileSync(picture);
  // A PNG's width and height are the first two numbers of its IHDR chunk, after its 8-byte signature.
  const png = bytes !== undefined && bytes.subarray(1, 4).toString('latin1') === 'PNG';
  const size = png ? `${bytes!.readUInt32BE(16)}×${bytes!.readUInt32BE(20)}` : 'unreadable';
  const json = /```json\n([\s\S]*?)\n```/.exec(prompt)?.[1];
  const diagram = JSON.parse(json ?? '{"nodes":[],"edges":[]}') as { nodes: { id: string; kind: string; text?: string; x: number; y: number; width: number; height: number }[]; edges: { from: string; to: string }[] };
  const shapes = diagram.nodes.filter((node) => node.kind === 'shape');
  const lines = [
    `**Saw ${shapes.length} shapes and ${diagram.edges.length} arrows**`,
    '',
    `1. The picture is a ${png ? 'PNG' : 'file'}, ${size} px.`,
    `2. Its nodes: ${diagram.nodes.map((node) => node.text || node.kind).join(', ')}.`,
    '3. Orders writes Postgres, then the queue: one can fail. Use an *outbox*.',
    `4. Ran in ${process.cwd()}, ${existsSync(join(process.cwd(), '.git')) ? 'a git checkout' : 'outside git'}, in ${mode} mode.`,
  ];
  const last = diagram.nodes.at(-1);
  if (prompt.includes('agent-board-suggestions') && last !== undefined) {
    const outbox = { id: 's1', shape: 'database', text: 'outbox', x: last.x, y: last.y + last.height + 60, width: 90, height: 70 };
    lines.push('', '```agent-board-suggestions', JSON.stringify([{ title: 'Outbox', shapes: [outbox], arrows: [{ from: last.id, to: 's1', label: 'writes' }] }]), '```');
  }
  return lines.join('\n');
}

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
    const firstPrompt = prompt ?? (await session.readPrompt());
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
