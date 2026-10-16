# @agent-board/fake-harness

Fake `claude` and `codex` binaries for tests, plus the guard that keeps tests away from the real ones. Nothing here calls a model or spends tokens.

## Using the fakes

```ts
import { spawn } from 'node:child_process';
import { claudeHookSettings, fakeHarnessEnv, startHookRecorder } from '@agent-board/fake-harness';

const hooks = await startHookRecorder();
const child = spawn('claude', ['--settings', JSON.stringify(claudeHookSettings(hooks.url)), 'fix the tests'], {
  cwd: repoDir,
  env: fakeHarnessEnv({ scenario: 'permission', home: tempHome }),
});
// hooks.events now fills with SessionStart, UserPromptSubmit, PreToolUse, PermissionRequest, …
```

`fakeHarnessEnv` puts `bin/` first on PATH, sets `HOME` to a temp dir (so `~/.claude` and `~/.codex` are never the real ones), and picks the scenario. `stepDelayMs` slows the streamed output down for e2e tests. `idleNotifyMs` sets how long an idle Claude session waits before `idle_prompt`.

## Lifetime

Like the real CLIs:

- **Interactive** (the default): after the scenario's turn the session sits idle at the prompt. Each further stdin line runs as a plain turn (`UserPromptSubmit`, a canned reply, `Stop`), or replays the scenario with that line as its prompt when `FAKE_HARNESS_REPEAT=1` (`repeat` in `fakeHarnessEnv`). EOF ends the session: `SessionEnd` with reason `prompt_input_exit` (Codex always reports `other`).
- **One-shot** (`claude -p`, `codex exec`): exits with `SessionEnd` straight after the turn.

The first prompt comes from the command line, or from the first stdin line if none is given. Later prompts and y/n answers are also read from stdin, one line each, so the fakes work both piped and under a PTY. As in the real TUIs, ESC CR (`\x1b\r`, Alt+Enter, which the app sends for Shift+Enter) is a new line within a prompt, not its end.

## Scenarios

Set with `FAKE_HARNESS_SCENARIO` (default `output`).

| Scenario     | What happens                                                                                                                     |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `output`     | Streams text, runs one `Bash` tool call, stops.                                                                                  |
| `waiting`    | Asks a question and stops, then waits on stdin for the answer, runs one `Bash` tool call on it and replies.                      |
| `permission` | A `Bash` call needs permission. A `PermissionRequest` hook decision (`allow`/`deny`) settles it; otherwise prints `(y/n)` (Claude also fires `Notification` `permission_prompt`) and reads stdin. |
| `long-permission` | One `Bash` call whose command is the whole prompt, however long, needs permission as in `permission`: a tile's ask can then be as long as the prompt. |
| `two-permissions` | Two `Bash` calls (`rm -rf dist`, then `rm -rf build`) need permission one after the other, each as in `permission`. Ends with `Removed dist. Removed build.` (or `Left … alone.`). |
| `subagent`   | Spawns an `Explore` subagent (`Agent` tool for Claude, `spawn_agent` for Codex): `SubagentStart`, `SubagentStop`, its own transcript. |
| `subagent-permission` | Sends two `general-purpose` subagents at once. Each needs permission for a `Bash` call (`rm -rf dist`, `rm -rf build`), so two `PermissionRequest`s carrying their `agent_id` are in flight together. Each prints `Removed …` or `Left … alone.` |
| `subagent-ask` | Sends a scout (`Explore`, held for `FAKE_HARNESS_SUBAGENT_WORK_MS`, default 0) and a `general-purpose` cleaner that needs permission for `rm -rf build`: one request in flight, so what it asks never depends on timing. |
| `subagents-working` | Sends three subagents at once (`Explore`, two `general-purpose`) and holds them for `FAKE_HARNESS_SUBAGENT_WORK_MS` (default 0: they finish at once). Used by the README screenshots to show characters at work. |
| `review`     | A reviewer's prompt (`You are the reviewer for round N…`) reads the diff with one `Bash` call and ends on a review doc: round 1 asks for changes (a blocker, a major, a minor), later rounds approve with the blocker and major struck through. Any other prompt plays `output`. |
| `board`      | Finds its way round agent-board: reads the `agent-board` MCP server's instructions, calls `whoami` and `set_status` (the prompt's first line, 10%), then really runs `agent-board identify`, `agent-board status set --progress 20 -- '<that line>'` and `echo "hook env: ${AGENT_BOARD_HOOK_TOKEN:-none} ${AGENT_BOARD_HOOK_URL:-none}"` in its shell. |
| `orchestrate` | By prompt. `Orchestrate: <task>` leads a worker through the `agent-board` MCP tools and CLI: `new_agent` with the task, `wait`, `agent-board read <ref> .agent-board/handover.md`, `send` "Also add a test", `agent-board wait`, `read`, `agent-board close`, then says `The worker is done and closed.` `Lead two: <task>` starts `worker one` with `new_agent` and `worker two` with `agent-board new`, both with the task, says `Two workers started.` and leaves them running. `Print your board identity` echoes `identity:$AGENT_BOARD_IDENTITY:end`. `Gate in the background` ends two turns, each followed by its `idle_prompt` and the second taken up with no prompt (as a background command reporting back), then writes `.agent-board/handover.md` and runs `agent-board handoff`, ending on `Handed off.`. `Work slowly` runs `sleep 5` in its shell; `Ask permission` plays `permission`; `Hit the rate limit` plays `rate-limit`. Any other prompt is a worker's: it writes `.agent-board/handover.md` in its shell and ends on `Handover written.` / `STATUS: done`. |
| `crash`      | Dies mid-turn: stderr message, exit 1, no `Stop` or `SessionEnd`.                                                                |
| `rate-limit` | Claude: `StopFailure` with `error: "rate_limit"`. Codex has no such event and only prints the error.                             |
| `markdown`   | Runs four tool calls in a row (`Read` ×2, the shell tool, `Grep`) and replies with a line of Markdown; then waits on stdin and answers in Markdown: a heading, the message's lines as a list, and a `ts` code block. |

Whenever a Claude session sits at the prompt after `Stop`, it fires `Notification` `idle_prompt` after `FAKE_HARNESS_IDLE_NOTIFY_MS`. The default is 0, so the notification follows `Stop` immediately; real Claude waits about 60 s. Tests of the state machine should set a delay, so they also see the stretch where `Stop` means idle.

A **bracketed paste** at the prompt (`ESC [200~` … `ESC [201~`, as a terminal or the app's composer sends text of several lines) is read as one message, its line breaks kept.

**Ctrl-C** (SIGINT, including `\x03` written to a PTY) works as in the real TUIs. During a turn it interrupts it: no `Stop`, the fake prints `Interrupted · …` and goes back to the prompt, and Codex fires `Interrupt`. A turn waiting on a hook or a y/n answer is interrupted too. At the prompt, the first Ctrl-C prints `Press Ctrl-C again to exit`, and a second within 2 s ends the session (`SessionEnd`, reason `prompt_input_exit`). Print and exec modes die on SIGINT. SIGTERM and SIGHUP kill a fake outright, with no `SessionEnd`.

## Exit codes

| Code | Meaning                                                                                       |
| ---- | --------------------------------------------------------------------------------------------- |
| 0    | Session ended normally.                                                                       |
| 1    | The `crash` scenario.                                                                         |
| 2    | Bad input: an unknown flag, malformed or missing `--settings`, an invalid matcher, or an unknown scenario. One line on stderr. |

The fakes reject flags they don't know, so a test that starts passing a new real flag notices. Add the flag to `FLAGS` in `src/claude.ts` or `src/codex.ts`. `--version` prints a version and exits 0. `claude auth status` (JSON) and `codex login status` (on stderr) say signed in, or signed out with exit 1 when `FAKE_HARNESS_LOGGED_OUT=1`. Both fakes follow symlinks to themselves, as an installed CLI often is one.

## What each fake reads and writes

**claude** reads `--settings <json or path>`, `--mcp-config <json or path>` (stdio servers, started with Claude's env plus their `env`; `http` servers, posted to with their `headers`, `${VAR}` filled in from Claude's env) and `$CLAUDE_CONFIG_DIR` or `~/.claude/settings.json`, plus `-p`, `--session-id`, `--resume`, `--model`, `--permission-mode`. A scenario's MCP tool calls go only to the tools a server lists (`tools/list`, asked once as it starts); any other is an error, as a harness offers the model only listed tools. Interrupting a turn mid-call cancels that call (`notifications/cancelled`), unless `FAKE_HARNESS_MCP_CANCEL=0` (`mcpCancel: false` in `fakeHarnessEnv`), which plays a harness that drops it. It runs `command` hooks (event JSON on stdin, `CLAUDE_PROJECT_DIR` set) and `http` hooks (POST, `$VAR` header interpolation limited to `allowedEnvVars`), with Claude's matcher rules. Hook inputs carry `session_id`, `transcript_path`, `cwd`, `permission_mode`, `hook_event_name` and each event's documented fields. The transcript goes to `~/.claude/projects/<cwd with non-alphanumerics as ->/<session-id>.jsonl`, and subagent transcripts go to `<session-id>/subagents/agent-<id>.jsonl` beside it.

**codex** reads `hooks.json` from `$CODEX_HOME` (default `~/.codex`) and from `.codex/` at the git root (so a session started in a sub-folder still loads the repo's hooks), and `-c` overrides, each value parsed as TOML as Codex does: `hooks.<Event>=[…]`, `mcp_servers.<name>.{command,args,env,env_vars}` (a server gets only Codex's few default env vars plus those `env_vars` names) or `mcp_servers.<name>.{url,bearer_token_env_var,http_headers}` (a Streamable HTTP server, its bearer token read from Codex's env) and `shell_environment_policy.{exclude,ignore_default_excludes}` (the model's shell commands lose vars named with KEY, SECRET or TOKEN unless `ignore_default_excludes=true`, then those the `exclude` globs match); other keys are accepted and ignored. It also reads `-m`, `-C` and the `exec` and `resume <id>` subcommands. As with real Codex, untrusted hooks are skipped. The fake has no `/hooks` review, so hooks run only with `--dangerously-bypass-hook-trust`. It runs `command` hooks only, with regex matchers. Inputs add `model`, plus `turn_id` on turn-scoped events, and carry `permission_mode` only where Codex documents it (not on `SessionEnd`). `SessionEnd` reason is always `other`. `SessionEnd` and `Interrupt` hooks time out after 1 s by default (3 s at most). The rollout goes to `~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<session-id>.jsonl` as `{timestamp, type, payload}` lines. `config.toml` hooks are not read.

Command hooks run in their own process group, so a timeout kills everything the hook started. A hook's exit code 2 (blocking a tool, prompt or stop) is not modelled yet.

Field names follow the Claude Code hooks reference (code.claude.com/docs/en/hooks) and the Codex hooks docs as of 2026-10. Transcript formats are internal to each CLI. The fakes write the shape those files have today, and the board's transcript adapters must still tolerate drift.

## The guard

- **Run level** (`harnessGuardGlobalSetup`, the Vitest and Playwright `globalSetup`): puts tripwire `claude`/`codex` scripts first on PATH. A hit logs itself and exits 127, and teardown fails the run if anything was logged. The Electron app under e2e inherits this PATH.
- **Worker level** (`guardChildProcess`, wired into Vitest `setupFiles`): every `node:child_process` launcher:
  - throws if it would start a `claude`/`codex` outside this package's `bin/`, whether by name on PATH, by absolute path, through the spawn's own `env.PATH`, through `env [PATH=…]`, or in command position in a `sh -c` script, a `shell: true` command or an `exec` string. Words that only mention a harness (`echo claude`, `grep codex`, `command -v claude`) are allowed;
  - puts the tripwire back into any `env.PATH` the caller built, right after the fakes if they are on it and first otherwise, so whatever that child runs later still hits it. An env with no PATH gets the tripwire plus the system default (`/usr/bin:/bin:/usr/sbin:/sbin`).

Limits:

- The guard can't read script files or expand variables (`sh -c '"$H"'` with `H=/real/bin/claude`). The run-level tripwire catches those only when the harness is found through PATH.
- `node-pty` spawns are not patched. Pass them an env built by `fakeHarnessEnv()`, and if the daemon ever hard-codes a harness path, check it with `realHarnessFor(command, env, cwd)` in its tests.
- **Login shells reorder PATH.** macOS `zsh -l`/`bash -l` run `path_helper`, which moves `/usr/local/bin` and friends ahead of inherited entries, tripwire and fakes included. Daemon tests must not start harnesses through a `-l` shell. Spawn the harness directly, or as a non-login shell with `fakeHarnessEnv()`.
