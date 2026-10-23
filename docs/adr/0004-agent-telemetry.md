---
status: accepted
---
# Agent telemetry: harness hooks first, transcripts for chat, screen-scraping never

Agent state comes from each harness's **hook system**, posted to the daemon; the chat view comes from the harness's **transcript file**; we never infer state by reading terminal output.

## Claude Code (verified against code.claude.com/docs, Claude Code 2.1.x)

- **Injection.** For sessions the app spawns, hooks are passed per session with `claude --settings <json>`, so we never edit the user's settings. Hooks are `type: "http"` hooks to the daemon carrying the session token.
- **State mapping.** `SessionStart` → running · `UserPromptSubmit`/`PreToolUse`/`PostToolUse` → running/thinking · `Notification` with `permission_prompt` → needs-permission, `idle_prompt` / `agent_needs_input` → waiting · `PermissionRequest` → needs-permission (and can be **answered** from the inbox by returning `decision.behavior` allow/deny) · `Stop` → idle/done, with `last_assistant_message` as the edge payload · `StopFailure` → rate-limited or failed by error type · `SubagentStart`/`SubagentStop` (with `agent_id`, `agent_type`) → characters appear and fade · `SessionEnd` → exited.
- **Chat view.** Tail the JSONL at `transcript_path` (`~/.claude/projects/<project>/<session-id>.jsonl`). Its format is documented as internal and unstable, so parsing lives behind a versioned adapter with recorded fixtures and degrades to "TUI only" on unknown entries.
- **External sessions.** Optional, opt-in: install a global `command` hook in `~/.claude/settings.json` that forwards events to the daemon if it is running and silently no-ops otherwise. `claude agents --json` lists Claude's own background sessions.

## Codex (verified by the spike against codex-cli 0.162.0-alpha.2, an alpha build)

- **Injection.** For sessions the app spawns, hooks are passed per session with `-c` overrides (one per event), so we never edit `~/.codex`:
  - `-c 'hooks.<Event>=[{hooks=[{type="command",command="\"<HOME>/.agent-board/bin/agent-board-hook\" codex",timeout=<T>}]}]'` for each of the 12 events (`SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `SubagentStart`, `SubagentStop`, `Stop`, `Interrupt`, `PreCompact`, `PostCompact`), plus `-c 'shell_environment_policy.exclude=["AGENT_BOARD_HOOK_*"]'` (`AGENT_BOARD_*` until ADR-0010 let the board env through to the model).
  - **Forwarder.** Codex has no `http` hook type, so the hook is a forwarder that reads the payload on stdin and POSTs it to the daemon.
  - **Stable launcher.** The command is a shim the daemon (re)writes at `~/.agent-board/bin/agent-board-hook`, which execs whatever app binary is current. The command string never changes across app moves and updates. That matters because Codex's hook trust hash covers the command string (see Trust).
  - **Tile identity.** The tile id and daemon token travel in `AGENT_BOARD_*` env vars on the `codex` process. Hooks inherit them; the `exclude` policy hides the hook URL and token (`AGENT_BOARD_HOOK_*`) from the model's shell commands (both verified). The board env, a separate board token among it, is meant for the model (ADR-0010). Treat the token as readable by the agent anyway (e.g. via the parent process's env): per ADR-0002 it can only forge events for its own tile.
  - **Timeouts.** `T` = 600 for `PermissionRequest` (the forwarder may hold it open for an inbox answer; see State mapping), 3 for `SessionEnd`/`Interrupt` (Codex's cap), and 5 for the rest. The forwarder never blocks on any other event, and exits at once with no output if the daemon is unreachable. The `T` values are part of the trusted hook definition, so changing them means re-trusting.
- **Trust (decided by the maintainer).** Codex runs non-managed hooks only once they're trusted.
  - **Default: bypass flag.** The app launches every Codex agent it spawns with `--dangerously-bypass-hook-trust`. Accepted trade-off: for that session the flag also skips review for every *other* enabled hook (user, plugin, project). The first time a Codex agent is spawned, the app shows a one-time notice explaining the flag and the opt-out.
  - **Opt-out: trust once.** A per-zone setting drops the flag. Codex then shows its "Hooks need review" modal in the tile's terminal on the first launch; after "Trust all" our hooks run in every later session with no prompt (verified). That relies on the stable command string above.
  - **Worktree risk.** Hooks run outside the Codex sandbox. Worktrees inherit their repo's trust, and agents and fetched PRs write to branches, so a branch that adds or edits `.codex/hooks.json` or `[hooks]` in `.codex/config.toml` would otherwise run unprompted in the next flagged session in that worktree. Codex has no `-c` switch to turn off project-layer hooks alone.
  - **Mitigation (proposed; the maintainer's sign-off came before this risk was raised and should be re-confirmed).** Before each spawn, the daemon looks for project hook config (`.codex/hooks.json`, or a `hooks` table in `.codex/config.toml`) from the session cwd up to the worktree root. If any exists, it launches *without* the flag for that session, so Codex's own review modal gates those hooks.
  - **Rejected candidates.** A per-session `CODEX_HOME` overlay still needs trust, needs a copy of `auth.json` (refresh-token rotation can log one copy out), drops the user's config, and moves rollouts out of `~/.codex`. Managed hooks need root or MDM and apply machine-wide. Precomputing trust hashes means forging Codex's internal trust records.
  - **Last resort:** the legacy `notify` program (turn-complete only; no permission, subagent or interrupt states; also fires for Codex's hidden title thread), so tiles would only show running/idle.
- **Folder trust is separate.** The first TUI session in a git repo the user has never trusted in Codex shows a blocking "Trust this folder?" screen in the tile's terminal. `-c projects.…trust_level` can't suppress it. Worktrees (ADR-0007) inherit their main repo's trust, so the user answers at most once per repo, and Codex writes the answer to its own config.
- **State mapping** (matching the Claude mapping above):
  - `SessionStart`/`UserPromptSubmit`/`PreToolUse`/`PostToolUse` → running/thinking.
  - `PermissionRequest` → needs-permission. Verified: a hook that blocks (15s tested, `timeout=600`) and then returns `hookSpecificOutput.decision.behavior` allow or deny is honoured, and the TUI shows "Running hook" instead of its own prompt. So the inbox *can* answer, by holding the request open, but then the user can't answer in the terminal. A later decision settles whether to hold, or to return no decision at once so the TUI prompts. Not verified: the maximum timeout and what happens on timeout. The state leaves needs-permission on the next `PostToolUse`, `Stop` or `Interrupt` (a denied call gets no `PostToolUse`).
  - `Stop` → idle/done, with `last_assistant_message` as the edge payload.
  - `Interrupt` → idle (no `Stop` follows).
  - `PreCompact` → running; `PostCompact` → idle when `trigger` is `manual` (no `Stop` follows `/compact`), and stays running when `auto` (mid-turn).
  - `SubagentStart`/`SubagentStop` (`agent_id`, `agent_type`; the child's `turn_id`; `SubagentStop.agent_transcript_path`) → characters.
  - `SessionEnd` → exited.
  - **No waiting state.** Codex has no `idle_prompt`-style notification, so Codex agents never enter `waiting`; they reach the needs-you inbox only via needs-permission.
  - **Before the first prompt.** In the TUI, `SessionStart` fires with the first prompt, not at launch, so a freshly spawned tile is `idle` until then (or the app passes the first prompt as an argument).
  - **Rate limits and failures.** No hook reports them; they come from the transcript adapter.
- **Chat view.** Tail the rollout JSONL at `transcript_path`, which is always present: `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<local-timestamp>-<session_id>.jsonl`. It goes behind the same versioned-adapter pattern. Rollouts hold account IDs and full system prompts, so any rollout fixture must be scrubbed; none is committed yet. `codex app-server` (JSON-RPC) is the richer structured option but would replace the native TUI, so it is not v1.
- **External sessions.** Rollouts under `$CODEX_HOME/sessions/`, with titles in `$CODEX_HOME/session_index.jsonl`, can be discovered without hooks.
- **Alpha build.** Payload fields, trust keys and TUI screens are undocumented and may change. Re-capture with `scripts/codex-capture/` when Codex is upgraded.

## Consequences

- Fake `claude`/`codex` binaries in the test suite must emit the same hook calls and transcript lines as the real CLIs, driven by scripted scenarios. Real Codex payloads and ordered scenarios live in `fixtures/codex/` (its README lists per-event field sets and what is not covered).
- "Thinking" vs "running" is a heuristic (between a prompt/tool result and the next tool call); it is cosmetic and allowed to be wrong.

## Amendments

**Update**: the Claude mapping as built (`packages/daemon/src/claude-state.ts`):

- A spawned agent is idle until its `SessionStart`.
- `SessionStart` and `PreToolUse` → running. `UserPromptSubmit` and `PostToolUse` → thinking.
- `Stop` → idle, never done. An agent is `done` once its session ends: on `SessionEnd`, or on a clean exit (code 0).
  The `exited` above is not a separate agent state.
- A crash, a non-zero exit or a kill → failed. So is an agent whose session a restarted daemon finds lost.
- `StopFailure` → rate-limited when `error` is `rate_limit`, otherwise failed. Claude is still running then, and its
  next prompt moves it on, so `failed` doesn't always mean the process has ended. A rate-limited agent stays so
  through its `idle_prompt`: Claude still shows its rate-limit menu, or `continue` at its prompt, until a turn starts.
- Hooks that land after the process exited (in flight when it was killed) are ignored.
- `Notification`s other than `permission_prompt`, `idle_prompt` and `agent_needs_input` leave the state alone, as do
  `SubagentStart`/`SubagentStop` and any event the mapping doesn't know.
- `PermissionRequest` is answered at once with no decision, so Claude's TUI prompts as usual. Answering from the
  inbox is a later amendment.

**Update**: Claude subagents as built (`packages/daemon/src/subagents.ts`):

- `SubagentStart` adds a running subagent (`agent_id`, `agent_type`) to its agent; `SubagentStop` marks it `done` with
  `last_assistant_message` as its result. A finished subagent stays on the agent for 10 s so its tile can show it
  leave. After that the daemon no longer reports it. There is no timer: it is pruned whenever the agent is next read
  or hooked, so no broadcast says it went (the tile has long stopped drawing it).
- Hooks fired inside a subagent carry its `agent_id` and move it through the agent mapping above. They still move the
  parent agent as before.
- The parent's `Stop` makes still-running subagents `idle` (background subagents outlive the turn); its `StopFailure`
  makes them rate-limited or failed. When the parent's process exits, its live subagents end with it: `failed` if the
  agent failed, otherwise `done`.
- Subagents live in the daemon's memory only, on the `Agent` it sends clients. They can't outlive the daemon, as their
  agent's session can't.

**Update**: external sessions as built (`packages/daemon/src/external-hooks.ts`, `external-sessions.ts`):

- **One opt-in for both harnesses.** The global `command` hook goes into `~/.claude/settings.json` and also
  `~/.codex/hooks.json` (the rollout scan above is not used). Codex treats it as any user hook: it asks for review
  the first time, then runs it.
- **Same forwarder, same shim.** The hook runs `"<HOME>/.agent-board/bin/agent-board-hook" external <harness>`. The
  daemon's address and a daemon-wide token live in `~/.agent-board/external-hook.json` (0600), written at start and
  removed at shutdown. With no file, the shim exits before starting the app; with a stale one, the post fails fast.
  The hook never prints, so it can't answer a `PermissionRequest` or block anything.
- **Not twice.** Agents agent-board spawns also run the global hooks; the forwarder skips any session with
  `AGENT_BOARD_HOOK_TOKEN` set.
- **Mapping.** External sessions go through the same Claude and Codex mappings and subagent tracking as agents. There
  is no process to watch, so `done` comes only from `SessionEnd`, and a session killed without one stays in its last
  state until dismissed (or dropped after a week of silence).
- **Status file.** A session whose worktree has `.agent-board/status.json` shows its state, summary and doc paths;
  if the file names a `session_id`, only that session does.
- **Hook files are the user's.** Install and uninstall edit through symlinks (dotfile managers), keep the file's
  layout, and leave every other hook alone. The daemon-wide token is an exception to ADR-0002's per-session tokens.
- **Residual:** several daemons (dev, e2e without `AGENT_BOARD_EXTERNAL_HOOK_FILE`) share the one file; the last to
  start gets the reports until it stops.

**Update**: Codex as built (`packages/daemon/src/agents.ts` `codexLaunch`, `codex-state.ts`,
`codex-config-guard.ts`, `hook-forwarder.ts`). Checked against the real `codex-cli 0.162.0-alpha.2`, run on a local fake
Responses API so no tokens were spent: a throwaway `CODEX_HOME` with a custom `model_provider`, and the TUI driven in a
PTY.

- **Forwarder.**
  - The shim runs the app's own executable as Node: `agent-board hook codex`.
  - It posts stdin to `$AGENT_BOARD_HOOK_URL` with `$AGENT_BOARD_HOOK_TOKEN` and prints the answer.
  - It gives up half a second before Codex's timeout. Both come from one table, `CODEX_HOOK_TIMEOUTS`; the `T` values
    are as recorded above.
- **Mapping.** As the State mapping above, plus the rules:
  - Idle until `SessionStart`.
  - `PreToolUse`/`PreCompact` → running; `UserPromptSubmit`/`PostToolUse` → thinking.
  - `PostCompact` with `trigger: auto` leaves the state alone.
  - `SessionEnd` → done. Exit and crash handling are shared with Claude (`stateAfterExit`).
- **Subagents.** Codex's `SubagentStart`/`SubagentStop` go through the subagent tracking too, so Codex tiles
  show characters as Claude's do.
- **PermissionRequest is not held.** The daemon answers at once with no decision, so Codex prompts in its terminal, as
  for Claude. Holding it for an inbox answer is a later amendment.
- **Mitigation, widened and fail-closed.**
  - The flag is left out when *any* entry named `.codex` exists from the session's start folder up to the worktree
    root, not only hook config. That is where Codex loads project config from, and any config there can add hooks.
  - It is checked with `lstat`: a dangling symlink counts, since its target could appear later.
  - A path that can't be checked counts as present.
  - Deeper `.codex` folders are ignored: Codex doesn't load them for that session.
  - The check runs on every launch through `codexLaunch`. There is no resume yet, and it must go through the same
    function.
- **Asked before spawn.**
  - When the check finds config, `agent.spawn` fails with `AGENT_ERROR.projectCodexConfig`. The new worktree is
    removed again.
  - The agent's starting tile keeps the failure (`AgentStart.confirm`). Its Retry shows why and offers "Start anyway"
    (`agent.retryStart` with `allowProjectCodexConfig`), which starts Codex without the flag.
- **"Trust all" bundles hooks (verified).** Codex's review lists the project's hooks with ours, each with its source
  (project config path, or session flags) and command. `t` in the review list trusts *all* of them; that was verified
  by accident, as it wrote 9 trust records. Trusting one hook at a time was not verified. So the warning tells the user
  that trusting all trusts both, and to read the repo's hooks first. It does not promise a per-hook path.
- **Session starts inside a running TUI (verified).**
  - Codex reads hook config when a session starts.
  - Later in the same turn, the next turn, a subagent (`spawn_agent`) and `/compact`: config the agent wrote
    mid-session did not run.
  - `/new` and `/fork`: it **did** run, unreviewed, under the still-active flag.
  - `/resume`: inconclusive. The picker reopened the current chat. Assume it reloads too.
  - So, while a flagged Codex agent runs, the daemon guards it (`guardCodexConfig`):
    - It watches every folder from the start folder up to the worktree root, and checks again on each of the agent's
      hooks.
    - It polls once a second, because macOS drops watch events (seen in tests, just after a watch starts).
    - A folder it can't watch counts as found.
    - Once a `.codex` appears, the daemon kills the session and records why in `agents.notice`, which the tile shows.
      The agent ends `failed`, and its work stays on its branch. Verified against the real codex: an agent with
      `danger-full-access` that wrote `.codex/hooks.json` was stopped before its tool call finished.
  - This holds whatever the sandbox. Under `workspace-write` (`codex sandbox -P :workspace`), `<cwd>/.codex` can't be
    written at all, but users may run `danger-full-access` or approve escalations.
  - **Residual:** `/new` also offers "New worktree", a managed checkout outside the guarded folders. A `.codex`
    committed on the agent's branch would load there. That is reachable only with write access to `.git`, which
    `workspace-write` denies.
- **Shim.**
  - Checked before each Codex spawn and rewritten if it differs (another daemon may point it at its own app).
  - The folder and the shim are `0700`.
  - A shim that can't be written only refuses Codex spawns; the daemon still starts.
  - **Residual:** a second daemon (dev or e2e without `AGENT_BOARD_HOOK_SHIM`) can repoint the shared shim while
    agents run. Their hooks then run the other app until the next Codex spawn or daemon start rewrites it.
- **Env exclude.** `-c shell_environment_policy.exclude=["AGENT_BOARD_*"]` *replaces* any `exclude` list in the user's
  Codex config for agent sessions. Merging would mean reading Codex's layered config (profiles, project layers), so it
  is left as a known gap.
- **Opt-out (verified).** Without the flag, Codex lists agent-board's 12 hooks for review. If the user continues
  without trusting, the turn runs without them and the tile stays idle. The dialog says so when the setting is off.
- **One-time notice.** The renderer explains the flag and the per-zone opt-out ("Skip Codex's hook review in this
  zone") before the first Codex agent that would use it. The setting is saved when the agent starts. The notice counts
  as seen once that spawn succeeds, and is remembered per app profile.

**Update**: the needs-you inbox as built (`packages/daemon/src/permissions.ts`):

- **Holding.** `PermissionRequest` is no longer answered at once. The daemon holds the hook's HTTP response open for
  up to 20 s. Claude's hook `timeout` for that event is the hold plus 10 s, so the daemon always answers first. The
  inbox answers with `hookSpecificOutput.decision.behavior` `allow` or `deny` (plus `message` for a deny).
  Unanswered, the hold lapses with an empty reply and Claude prompts in its terminal. That is the TUI fallback.
- **Several prompts at once.** Every request is held as its own permission prompt, keyed by request and tagged with
  the asking subagent's `agent_id`/`agent_type`, so parallel subagents can ask at once.
  - While any prompt is pending (held, or lapsed and asking in the terminal), the agent is `needs-permission`,
    whatever a sibling's or a parallel call's hook says.
  - Only a hook from the agent or subagent that asked settles its prompt:
    - a `PostToolUse` of the same tool and input (it ran);
    - `Stop`, `StopFailure`, Codex's `Interrupt` or `UserPromptSubmit` (for the agent);
    - `SubagentStop` (for a subagent).
  - `PreToolUse` and other calls settle nothing, since they may run beside it. A prompt denied in the terminal
    therefore stays listed until the asker's turn ends.
  - Once a hook settles the last prompt, an agent left at `needs-permission` is `running`. So is an agent straight
    after an inbox decision, unless prompts remain.
- **Unverified (the maintainer to check once by hand).** Does real Claude show its own permission dialog while the hook is
  held? The docs say hooks and a `--permission-prompt-tool` race ("whichever decides first applies"), which suggests
  it does.
  - If it does, an answer typed in the terminal settles the prompt by the rules above, and the held hook is released
    with no decision.
  - If it doesn't, the terminal is blocked for up to the hold. The fake claude models this case. That is why the hold
    is 20 s, not longer, and why the session window says the request is held for the inbox, with a countdown.
  - Record the result here, and lengthen the hold if the dialog does show.
- **Codex too (supersedes the earlier "PermissionRequest is not held").** Codex agents' hooks go through the same holds.
  - The forwarder waits up to 599.5 s on `PermissionRequest` (`CODEX_HOOK_TIMEOUTS`), well past the 20 s hold, and
    prints the daemon's reply.
  - Codex reads the same `hookSpecificOutput.decision.behavior`, so an inbox decision settles the call. A lapse
    prints nothing, and Codex prompts in its terminal.
  - Codex's `Interrupt` also settles a prompt, since it ends a turn with no `Stop`.
  - The hold is verified for Codex (a blocking hook's decision is honoured and the TUI shows "Running hook"),
    so its terminal is blocked while a prompt is held. This is the same case as the fake claude, with the same 20 s
    cap.
- **Answering a waiting agent.** The daemon types the text into its PTY and submits it with `\r` 50 ms later. Line
  breaks are flattened to spaces, and answers to one agent are typed one at a time. This is not verified against the
  real TUI's paste detection.
- **Last message.** The agent keeps what it last said to the user, in memory, as the inbox's context: its own `Stop`'s
  `last_assistant_message`, or the `message` of an `agent_needs_input` notification. A `UserPromptSubmit` clears it.

**Update**: scheduled agents (`packages/daemon/src/agents.ts`, `schedules.ts`):

- **`scheduled` is shown, never stored.** The hooks still put a session in one of the states above (`SessionState`).
  An agent with an enabled schedule whose session is live shows `scheduled` while it sits at its prompt: `idle`, or
  `waiting` that came from `idle_prompt` straight after `Stop`, with no permission prompt pending and its last message
  not asking anything. Subagents and external sessions are never `scheduled`.
- **A turn that ends on a question waits for you.** Claude fires `idle_prompt` about a minute into any idle stretch, so
  it can't tell a finished run from one that ended on a question in prose. So the daemon reads the agent's last message
  (`lastMessage`, from `Stop`'s `last_assistant_message`): if its last paragraph has a `?`, the scheduled agent shows
  `waiting` and lands in the needs-you inbox, and every fire time is skipped until the user answers. Otherwise
  `idle_prompt` after `Stop` means "waiting for its next run" and keeps it out of the inbox. A question asked mid-turn
  (`agent_needs_input`) or a permission prompt puts a run in the inbox too. It is a heuristic: a rhetorical question
  holds the schedule until answered, which errs towards never acting blindly. Unscheduled agents are unchanged:
  `idle_prompt` makes them `waiting`.
- **A run is the schedule's prompt typed at the agent's prompt**, the same way as an inbox answer, while the agent sits
  at its prompt (or after a failed turn). A fire time is skipped, and recorded so, while it is still working,
  rate-limited (typing would fail the same way), waiting for you, or the user has a draft at its prompt: text typed
  into its terminal and not yet submitted with Enter or cleared with Ctrl-C or Ctrl-U (`src/terminal-input.ts`;
  focus, mouse and arrow-key reports don't count).
- **An ended agent is relaunched.** When a fire time comes and the agent's session has ended (stopped, crashed, or
  lost with a daemon restart), the daemon starts its harness again in its worktree under the same session id, with
  the schedule's prompt as its first message and a new hook token. Claude gets `--resume <id>`, so it carries on its
  conversation; Codex gets a fresh launch (`codexLaunch`, the same as a spawn), so it starts a new one. A Codex
  worktree that now has Codex config of its own, or a worktree that is gone, skips the run saying why.

**Update**: the chat view as built (`packages/daemon/src/transcript-adapters.ts`, `transcripts.ts`):

- **Where the transcript is.** The daemon keeps the `transcript_path` the agent's own hooks name (not a subagent's: a
  Codex `SubagentStart` names the child's rollout) on its row. Until its first hook the chat shows "No conversation
  yet".
- **"Degrades to TUI only on unknown entries" is per transcript, not per entry** (to be confirmed by the maintainer). Real
  Claude transcripts are mostly bookkeeping entries (attachments, queue operations, titles, hook summaries) and gain
  new kinds with every release, so an unknown entry *type* inside a known format is skipped. The whole transcript is
  unsupported, and the chat shows a "Terminal only" notice saying why, when:
  - any entry, anywhere in the file, is from a version outside the adapter's (Claude Code 2.x; Codex 0.x, from
    `session_meta.cli_version`), as when a session is resumed under a newer release;
  - a line isn't JSON, an entry lacks its format's envelope (Claude: a string `type`; Codex: `type` and a `payload`
    object), or a rollout doesn't open with `session_meta`;
  - an entry the chat is made of doesn't match: a Claude `user` or `assistant` entry without its `version` or its
    `message` object;
  - a line runs past 16 MB.
- **What the chat leaves out, as the TUIs do.** Claude: `isMeta` and sidechain entries, thinking, server tools, and
  slash-command and system-reminder text. Codex: `developer` messages, and user messages Codex tags as anything but
  `user.text` (its environment context); `event_msg`s, which repeat `response_item`s, except `turn_aborted`.
- **Subagents.** A Claude subagent's own transcript (`<session>/subagents/agent-<id>.jsonl`) is read when its call is
  opened, and followed until the call has its result, found by the `agentId` on the call's result or the `toolUseId` in its `.meta.json`. Codex records the
  messages between agents (`agent_message`) in the parent's rollout, so they show with the calls around them; the task
  handed on is encrypted, so only its recipient shows.
- **Reading, bounded.** `agent.transcript` returns the entries from `since`, parsing only the bytes appended since the
  last read, a megabyte at a time, up to the last line break. A file over 8 MB is read from its first line (Codex's
  session line) and then from 8 MB before its end. A session keeps its latest 500 entries, the daemon 8 sessions, and
  a read returns at most the latest 200, saying when earlier ones aren't sent (`earlier`); the chat says those are in
  the terminal. Tool output and inputs are clipped to 4,000 characters. The session window polls every 750 ms while
  its chat shows. A file replaced or cut short starts a new `generation`, seeded from the clock so none repeats across
  daemon restarts.
- **Codex calls.** Codex 0.162 runs shell commands as scripts for its `exec` tool (`custom_tool_call`); a call failed
  when its report says `Script failed`, it was `aborted`, or its `exit_code` wasn't 0. The fake `codex` writes this
  shape, and the fake `claude` a shell's stdout as the result's text, as the real CLIs do.
- **Fixtures.** `fixtures/claude/transcripts/` and `fixtures/codex/rollouts/` are hand-written in the entry shapes of
  real Claude Code 2.1.296 transcripts and codex-cli 0.162.0-alpha.2 rollouts, with no real content: copying real files
  in was not allowed, and they hold prompts, account IDs and system prompts.

**Background commands**, as built (`packages/daemon/src/background-commands.ts`):

- **A second source, for liveness only.** An agent can end its turn while a command it started runs on (a gate, a
  build, a dev server). Hooks name such a command but don't say when it ends: Claude Code reports that by starting a
  turn, if at all, and Codex not at all. So the daemon also reads the process table (`ps`), never terminal output. It
  decides nothing but whether a command still runs; the state machine above is unchanged.
- **Naming.** Claude's `PreToolUse` for `Bash` with `tool_input.run_in_background: true` records the command and when
  it started; its `PostToolUse` carries the `backgroundTaskId`, and a `KillShell`/`KillBash`/`TaskStop` call naming it
  drops it. Codex has no such flag: its commands are found in the process table alone.
- **Liveness.** A command runs while a shell running it (`<sh|bash|zsh|fish|dash|ksh> [flags] -c …`, Claude Code's
  `eval '…'` wrapper taken off) is a child of the agent's harness process, or of Codex's sandbox (`sandbox-exec`,
  `bwrap`) under it. Nothing deeper counts: a shell under an MCP server (`npx` runs its server in `sh -c`) or inside a
  command is not a command the agent ran, and nor are other children (`caffeinate`) or the hook forwarder's runs. A
  recorded command names the shell running exactly its text, quoting aside, one shell each; an unrecorded one takes its
  text from the shell's argv and its start from `ps`'s elapsed time.
- **Only at the prompt.** The table is read only for live agents at their prompt asking nothing (`atPrompt`), as a
  command under an agent mid-turn may be the turn's own. It is read when a turn ends, then every 5 s while such an
  agent has a recorded command or is a Codex agent. Between a turn's end and that first read, the commands the turn
  started in its last seconds count as running, so the tile doesn't flash idle; older ones wait for the read, as they may
  have ended in the turn.
- **State.** Such an agent is `on-command`, derived like `scheduled`: out of the needs-you inbox. Claude's
  `idle_prompt` while a command runs leaves its row `idle`, not `waiting`, so the command's end, in the seconds before
  Claude takes up its result, never shows it waiting for you. A question, a permission prompt or a turn takes over. Once no shell of its
  commands runs, it is `idle` or `waiting` again, whatever its status says: a status that still says "running" is
  then visibly stale.
- **The npm wrapper.** Codex installed from npm is a node wrapper whose child is the real `codex`, so its shells sit
  one level deeper: the scan steps once through a child named `codex`, and no further.
- **Gaps.** Linux `bwrap --unshare-pid` adds a process level between the sandbox and the shell, which isn't followed,
  so a Codex agent sandboxed that way never shows `on-command`. A command that daemonises (`nohup … &`, `setsid`) leaves the tree and isn't seen. Windows has no `ps`, so
  agents there are never `on-command`.
