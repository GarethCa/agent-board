# Claude transcript fixtures

For the chat view's Claude adapter (`packages/daemon/src/transcript-adapters.ts`).

- `transcripts/<session-id>.jsonl`: a session as Claude Code 2.1.x writes it to `~/.claude/projects/<project>/`: a
  prompt, a Read, an Edit, an Agent call, two Bash calls (one failing), a slash command, a second prompt and an
  interrupt, among the bookkeeping entries real transcripts are mostly made of (permission mode, file history,
  attachments, `isMeta` reminders, thinking, turn durations, hook summaries, queue operations, a title).
- `transcripts/<session-id>/subagents/agent-<id>.jsonl` and `.meta.json`: the Agent call's subagent, as Claude Code
  keeps it beside the session, with the call that started it in `toolUseId`.

They are **hand-written** in the entry shapes of real Claude Code 2.1.296 transcripts, not copied from one: real
transcripts hold the user's prompts and code. IDs, paths and texts are made up and `usage` is trimmed.
