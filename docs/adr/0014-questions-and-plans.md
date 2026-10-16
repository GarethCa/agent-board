---
status: accepted
---
# An agent's questions and plans hold its MCP call until the user answers, and an HTML plan runs in a view of its own

An agent can ask the user something (`ask`) or show them a plan before it acts (`present_plan`) through the board MCP, and wait for the answer, which the user gives in the needs-you inbox or the Plan tab. The decisions are about how the agent waits, what ends the wait, and how an HTML plan, which is untrusted, is drawn.

## The call holds until the user answers

- **One MCP call, held open.** `board.ask` and `board.presentPlan` resolve only once the user answers, skips or decides, or the wait times out: 30 minutes for a question and 60 for a plan by default, at most 4 hours (`MAX_ASK_WAIT_MS`). Unlike `orchestrator.wait`, which gives up after 50 s and is called again, a question isn't asked twice: the agent's turn simply waits, as it would on a permission prompt. Claude gives an MCP tool call far longer than that by default (`MCP_TOOL_TIMEOUT`), and over HTTP (ADR-0010, Claude's agents) the call's event stream starts at once and stays alive with a comment line every 15 s, inside Claude's per-request and idle timers; Codex gives one 60 s, so its launch adds `-c mcp_servers.agent-board.tool_timeout_sec=` the longest wait plus a minute. A harness or user that set a shorter timeout cancels the call, which ends it as below.
- **Only the user answers.** A timeout tells the agent no answer came, and a skip that the user skipped: never an option picked for them. The methods that answer (`ask.answer`, `plan.decide`) and read the plans (`plan.list`) are not in `BOARD_CALLER_METHODS` (ADR-0010), so no board token reaches them; `board.ask` and `board.presentPlan` are, and act only for the live agent holding the token, from its own session (not a shell, nor an ended agent's).
- **What ends it besides the user.**
  - The connection that made the call closing: the MCP server closes its daemon connection when the harness sends `notifications/cancelled`, as Claude and Codex are expected to when the user interrupts the turn.
  - The agent's turn ending (`UserPromptSubmit`, `StopFailure`, `Interrupt`, `SessionEnd`, and its own `Stop`, as a harness that gave up on the call itself carries on), its session ending, and the daemon stopping.
  - Interrupt or Stop in the app, which drop it whether or not the harness cancels the call: neither leaves a call waiting.

  None of these leaves the turn waiting on the call, so ending the wait on each is safe. A question then just goes from the inbox; a plan is kept, `withdrawn`. A plan still waiting as the daemon went is withdrawn as the next one starts.
- **One at a time.** An agent waiting on a question or plan can't ask another until that one ends.
- **Nothing types into the waiting turn.** An orchestrator's `send` refuses an agent waiting on the user's answer, as it refuses one that needs permission; a schedule's run and a hand-off already skip it, its hooks saying it still works.
- **The harness may ask first.** In a permission mode that asks before an MCP tool runs, Claude raises a permission prompt for `ask` or `present_plan` before the call reaches the board, so the inbox shows that first. The app doesn't allow the tool for the user: it does no more than the harness does.
- **The agent is `waiting` meanwhile.** Its hooks say it runs (it is mid-tool-call), so the agent host shows `waiting` while it waits on the user, over anything but a subagent's permission prompt, and a new question or plan clears `seen`, as a new permission prompt does. `agent.interrupt` takes an agent waiting this way (`isMidTurn`).
- **Plans are kept, questions are not.** A plan is the agent's history: `plans` keeps every version with its body and decision, and goes with its agent. A question is held in memory only while it waits.
- **MCP only.** There is no `agent-board ask` or `plan` command: a shell command in a harness times out in minutes (Claude's Bash tool after 2 by default), long before a user may answer. `agent-board --help` says so.

## Not yet verified against a real Claude or Codex

The fake harnesses can't show what a real one does. These stand on the harnesses' docs and reports, and a one-off manual check (an `ask` that waits more than a minute in each, interrupted once) should settle them and be recorded here: that Claude's stdio MCP tool calls run past a minute by default (some builds have been reported to cut them at 60 s, or less); that Codex takes `mcp_servers.<name>.tool_timeout_sec`; that both send `notifications/cancelled` when the user interrupts the turn; and (for `agent-board mcp` over stdio, Codex's) that the client starts it in the agent's working directory, which a plan's relative `path` is read from; over HTTP the daemon reads it from the session's start folder. Also whether a background subagent of Claude's, still running past its main agent's `Stop`, can be the one waiting in `ask`: the MCP server is the session's, so its call is the session's, and the main agent's `Stop` (or a new prompt) would then drop the question while the subagent still waits, telling it no answer came. If it can, the drop on `Stop` should wait while the agent has live subagents.

## An HTML plan is untrusted

An agent writes its plan, and an HTML plan's page may carry script. It must not reach the app, this machine, the network, or the user by another page. It is drawn the way a web tab's page is (a `WebContentsView` over the tab's area, `web-tabs.ts`), but locked down harder (`plan-lockdown.ts`):

- **Its own view and partition**, in memory only, a fresh one each time the plan is shown, forgotten as it goes: no Node, no preload, `contextIsolation`, `sandbox`, no webview tag, no devtools, no dialogs, no spellcheck dictionaries.
- **Served from memory.** The main process serves the plan, which the renderer read from the daemon, at `agent-board-plan:plan` on that partition alone, with a Content-Security-Policy of `default-src 'none'`: its own inline script and style (no `eval`), and images, fonts and media it carries as `data:` or makes as `blob:`; no `connect-src`, frames, form posts or `<base>`. The policy also sandboxes the page with `allow-scripts` alone: no modals (`print()` among them, which `disableDialogs` doesn't stop: the OS print dialog would open, and could be reopened in a loop, over the window), forms, popups, top navigation or downloads, and an opaque origin, so no storage and no file pickers.
- **No network.** Every request the partition makes is cancelled but the page itself and `data:` and `blob:` URLs, so a fetch, an image, a socket or a form post to anywhere (this machine included) never leaves. WebRTC, which no request rule sees, is held to `disable_non_proxied_udp`; with no proxy that leaves it no UDP, though a TCP candidate is not ruled out. That is no wider than the agent itself, which runs as the user and has the network in its shell; what the view rules out is a page of the agent's using the app or the user's browser state, and it has neither.
- **Goes nowhere, opens nothing.** Every navigation and redirect of the page or a frame in it is stopped, `window.open` opens nothing (not even an offer, as a web tab makes), and the tab says what was stopped. No permission, device or download is granted, no dialog or print dialog opens, and the page can't keep the user on it.
- **A plan's file is the agent's to name.** `present_plan`'s `path` may name any file the user can read; the MCP server, which runs as the user, reads it and the app only shows it, which is no wider than the agent's own shell.
- **Scripts run only there.** The view runs the plan's scripts, which is what makes an HTML plan worth more than its Markdown; they reach nothing outside it. A Markdown plan runs nothing: it is rendered as the PR tab renders a description, its raw HTML dropped.

## Considered options

- **Answering after the call ended, as the agent's next message.** Rejected: it types into the agent's terminal for the user, which the app doesn't do beyond what the harness does; a question that ended unanswered is simply gone, and the agent was told.
- **A question that times out and is asked again, like `orchestrator.wait`.** Rejected: the inbox would see a new question each minute, and its timer would mean nothing.
- **A sandboxed `<iframe srcdoc>` in the renderer.** Rejected: it shares the renderer's process, and keeping it off the network relies on its CSP alone. A view of its own adds a process, a partition the request rule covers, and the main process's navigation and window guards.
- **A `data:` URL.** Rejected for size: Chromium caps the URLs it loads at 2 MB, and a large plan of non-ASCII text would pass that once encoded.
