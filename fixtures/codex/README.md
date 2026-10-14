# Codex hook fixtures

Real payloads captured from `codex-cli 0.162.0-alpha.2` (an **alpha** build) on 2026-10-08. Every hook was a `command` hook that saved its stdin. Paths are rewritten to `/Users/dev/...` and the encrypted subagent message is redacted. Everything else is exactly what Codex sent. To re-capture on a newer Codex: `scripts/codex-capture/`.

- `hooks/<Event>.json`: one payload per event, all 12 events. Interactive-TUI captures are used where one exists (`permission_mode: "default"`). `SubagentStart`/`SubagentStop` only exist from `codex exec` (`permission_mode: "bypassPermissions"`).
- `hooks/PermissionRequest.response-{allow,deny}.json`: the stdout a hook returns to answer. Both were exercised for real: deny in `tui-permission-interrupt-compact`, allow in `tui-permission-allow-blocking-hook`.
- `notify-agent-turn-complete.json`: the argv JSON the legacy `notify` program receives for the main thread's turn.
- `scenarios/*.jsonl`: every hook and notify call from one real session, in order. Each line is `{"t_ms", "kind": "hook"|"notify", "event"?, "payload"}`, where `t_ms` is milliseconds since the first call. These are scripts for the fake `codex`:
  - `tui-permission-interrupt-compact`: TUI session.
    - A write is denied by the `PermissionRequest` hook. Its `PreToolUse` gets no `PostToolUse`, and the TUI never shows its own prompt.
    - A turn is interrupted with Esc: `Interrupt`, no `Stop`.
    - Then `/compact` (no `Stop`) and `/quit`.
    - The first `notify` comes from Codex's hidden title-generation thread (different `thread-id`).
  - `tui-permission-allow-blocking-hook`: TUI session. The `PermissionRequest` hook blocks for 15s and then allows, so the write happens with no TUI prompt. The session was killed, so there's no `SessionEnd`.
  - `exec-subagent`: `codex exec` with one subagent. The subagent's own turn also fires `notify`.
  - `exec-shell`: `codex exec`, one shell command.
  - `exec-sandboxed-network`: `codex exec`. A network command fails silently inside the sandbox, and exec mode never fires `PermissionRequest`.

- `rollouts/rollout-…-<session-id>.jsonl`: one TUI rollout for the transcript adapter: a shell command through `exec`, a subagent via `spawn_agent`/`wait_agent` with the `agent_message`s between them, then an interrupted turn and a compaction. It is **hand-written** in the entry shapes of real 0.162.0-alpha.2 rollouts, not copied from one: real rollouts carry account IDs, full system prompts and the user's prompts. IDs, paths and texts are made up; the developer instructions, environment context and encrypted contents are placeholders.

## Field sets (from the captures)

All events carry `session_id`, `transcript_path`, `cwd` and `hook_event_name`. On top of that:

| Event | Extra fields |
|---|---|
| `SessionStart` | `model`, `permission_mode`, `source` |
| `SessionEnd` | `reason` only: **no** `model`, `permission_mode` or `turn_id` |
| `UserPromptSubmit` | `turn_id`, `model`, `permission_mode`, `prompt` |
| `PreToolUse` | `turn_id`, `model`, `permission_mode`, `tool_name`, `tool_input`, `tool_use_id` |
| `PermissionRequest` | `turn_id`, `model`, `permission_mode`, `tool_name`, `tool_input` (incl. `description`); **no** `tool_use_id` |
| `PostToolUse` | as `PreToolUse` + `tool_response` |
| `Stop` | `turn_id`, `model`, `permission_mode`, `stop_hook_active`, `last_assistant_message` |
| `Interrupt` | `turn_id`, `model`, `permission_mode` |
| `PreCompact` / `PostCompact` | `turn_id`, `model`, `trigger`; **no** `permission_mode` |
| `SubagentStart` | `turn_id` (**the child's** turn), `model`, `permission_mode`, `agent_id`, `agent_type`; `transcript_path` is **the child's** rollout |
| `SubagentStop` | as `SubagentStart` + `agent_transcript_path` (child), `stop_hook_active`, `last_assistant_message`; `transcript_path` is the parent's |

## Not covered (don't assume these shapes)

- `SessionStart` with `source` other than `startup` (`resume`, `clear`, `compact`).
- `PreCompact`/`PostCompact` with `trigger: "auto"`.
- Subagent events from the TUI (only `exec`), and agent types other than `default`.
- Hooks with a `matcher`.
- A `PermissionRequest` hook that times out or returns no decision.
- MCP or `apply_patch` tool calls (only `Bash` and the subagent tools).
