# Claude transcript fixtures

For the chat view's Claude adapter (`packages/daemon/src/transcript-adapters.ts`).

- `transcripts/<session-id>.jsonl`: a session as Claude Code 2.1.x writes it to `~/.claude/projects/<project>/`: a
  prompt, a Read, an Edit, an Agent call, two Bash calls (one failing), a slash command, a second prompt and an
  interrupt, among the bookkeeping entries real transcripts are mostly made of (permission mode, file history,
  attachments, `isMeta` reminders, thinking, turn durations, hook summaries, queue operations, a title).
- `transcripts/<session-id>/subagents/agent-<id>.jsonl` and `.meta.json`: the Agent call's subagent, as Claude Code
  keeps it beside the session, with the call that started it in `toolUseId`.

- `transcripts/queued-mid-turn.jsonl`: a turn into which messages came while it ran, each a `queued_command` attachment
  where Claude Code took it, at the step after a tool call: one the user typed (`commandMode: "prompt"`), a subagent's
  report (`isMeta`, `origin.kind: "peer"`) and a background task's notification (`commandMode:
  "task-notification"`). Claude Code writes no `user` entry for any of them.
- `transcripts/background-turn.jsonl`: in Claude Code 2.1.312's shapes, a turn that leaves a command in the background
  and ends (its `turn_duration`); hours later, the command's notification starting a turn of its own (a `user` entry
  with `origin.kind: "task-notification"`, after its queue operations), thinking and a reply; then a run of two calls,
  the second taking five minutes, thinking, and a call the user turns down (its result an error, then the interrupt).
  Before two of its thinking lines is a `deferred_tools_record` attachment, stamped a few milliseconds from it (one
  after it), as Claude Code 2.1.312 writes them.

They are **hand-written** in the entry shapes of real Claude Code 2.1.296 transcripts, not copied from one: real
transcripts hold the user's prompts and code. IDs, paths and texts are made up and `usage` is trimmed.

## OSC 8 hyperlinks

`osc8/links.bin`: what Claude Code 2.1.309 writes for links when it believes the terminal supports hyperlinks
(`FORCE_HYPERLINK=1`, or a known `TERM_PROGRAM`). **Hand-built** from the bundle, not captured from a session: its link
writer prints `ESC ] 8 ; ; <url> BEL`, the label in `blueBright` (`ESC [ 94 m … ESC [ 39 m`), then `ESC ] 8 ; ; BEL`, and its
screen renderer writes one such span per drawn segment, so each row of a wrapped address carries the whole URL. The file
holds: an address with `[`, `]` and `'` in it, hard-wrapped over two rows; a labelled link to `http://example.com/docs`
(which the terminal view may not open); and one whose address ends in `.`. Used by the terminal link e2e (`web-tab.spec.ts`).
