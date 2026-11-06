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
- **One at a time.** An agent waiting on a question or plan can't ask another until that one ends; one ask may hold several questions (below).
- **Nothing types into the waiting turn.** An orchestrator's `send` refuses an agent waiting on the user's answer, as it refuses one that needs permission; a schedule's run and a hand-off already skip it, its hooks saying it still works.
- **The harness may ask first.** In a permission mode that asks before an MCP tool runs, Claude raises a permission prompt for `ask` or `present_plan` before the call reaches the board, so the inbox shows that first. The app doesn't allow the tool for the user: it does no more than the harness does.
- **The agent is `waiting` meanwhile.** Its hooks say it runs (it is mid-tool-call), so the agent host shows `waiting` while it waits on the user, over anything but a subagent's permission prompt, and a new question or plan clears `seen`, as a new permission prompt does. `agent.interrupt` takes an agent waiting this way (`isMidTurn`).
- **Plans are kept, questions are not.** A plan is the agent's history: `plans` keeps every version with its body and decision, and goes with its agent. A question is held in memory only while it waits.
- **Asked on the board, it is put there as a steps card.** An agent that asks with `onBoard` (`on_board` in the MCP tool) has its ask put on the board at once, as Put on the board does (below): a steps card beside its tile that its call waits on, whose Send answers it. This replaces the question card, a bubble drawn from the question that was never stored. Nothing about it needs migrating: a question lives in memory only while its call waits, and none outlives the daemon.
- **A crew member asks its orchestrator, not the user** (ADR-0016). While the orchestrator that started it is live, its question or plan holds nothing: it becomes its flag to that orchestrator, and the call answers at once that it went there.
- **A plan from a file is a document too** (ADR-0018): `show_doc` with `plan` presents it as `present_plan` does, and waits the same way. It is the documented way in; `present_plan` is kept for agents that call it.
- **The user may edit a Markdown plan before deciding it, and the decision applies to their text.** A decision is always on a fixed text: the user's edit (`plan.edit`, only the user's connection, as `plan.decide`) is saved as a version of its own, the next one, `author` the user, and the version it came from is stamped `edited`. The held call carries over to it: what the agent waits on is now the user's version, its wait unchanged, and a decision sent for the agent's version is refused. Editing again makes the next version. The call resolves with the decision and the edits (`PlanResult.edits`): the line diff from the agent's last version to the one decided, given back in the call's own answer, never typed into the waiting turn. Approving (**Approve with my edits**) approves the user's text, which the agent didn't write, so its answer leads with the diff; Request changes sends the diff with the comments and needs none of its own; a rejection sends no diff.
- **An approved edit is written to the plan's file**, if the plan came from one (its real path is kept with it) and only as documents are written (ADR-0018): a real file inside the agent's worktree, not a link, still there, whole and in its mode, and only while it still holds exactly the agent's version the user edited: whatever wrote it while the plan waited is kept, as a document's save refuses to write over a rewrite it hasn't seen. Written on approval, not on each save: until then the decision is open, and the file is the agent's working copy. Otherwise the agent is told where its file still holds its version, why, and to apply the changes. A file that is also one of the agent's documents counts the write as the user's version of it. In the app, an edit not yet saved holds every decision on that version (the Plan tab's, the inbox's and the card's) in every window, so a decision never drops it unseen: each window tells main of its own drafts, and main tells every window the plans held in any, dropping a window's as it closes. An HTML plan stays view-only.
- **A plan card on the board** (`plan`, a board item, as a document card is): with `on_board`, one card for the agent beside its tile, showing its latest plan as it is now, so a new version updates it in place and its decision stamps it. It decides through `plan.decide`, the inbox's path, from a popover holding the inbox's own decision bar; it never edits the text. Like a document card it survives a restart, is taken off the board by the user, and goes with its agent. A crew member's plan, which goes to its orchestrator, puts no card.
- **A question is MCP only; a plan can also be left from a shell.** There is no `agent-board ask` command: a shell command in a harness times out in minutes (Claude's Bash tool after 2 by default), long before a user may answer. `agent-board doc <path> --plan [--board]` presents a plan without waiting: `board.presentPlan` with `detached` answers at once with the plan, and the plan then outlives the connection and the agent's turns (a turn's end, an interrupt and the command's exit don't withdraw it; the end of its session, its deletion and the daemon's close do). A left plan has no timer, so it waits as long as the user takes, beside a question or plan the agent holds a call on (its own slot), and the agent's next version takes its place; it doesn't count as the agent being mid-turn, so Interrupt and an orchestrator's `send` are as for an idle agent. The decision is typed at the agent's prompt once it is ready for it, as a document's edit is (ADR-0018), in the words the held call would have answered with (`plan-told.ts`) and led by `[agent-board]`. The agent isn't held: it must end its turn and wait for the message, where the held call stops it. An orchestrated crew member's plan still goes to its orchestrator. A left plan ends with its agent's session, which the agent is told once it is resumed; a plan still undecided as the daemon goes is withdrawn as the next one starts, and a plan left this way is not told of that.

## An ask holds up to four questions, and can be put on the board

- **One to four questions.** `ask` takes one question, or `questions`: up to four (the most Claude's own question tool
  asks at once), each with its options or none. More, or a to-do, is refused with "That's a steps card: use steps new":
  if it fits in an ask it is an ask, and everything longer is a card.
- **Answered one at a time, sent together.** For several questions, each answer (`ask.answer` with its question's
  `index`) is kept on the ask, in memory with it, so closing the ask and coming back keeps them, in every window. The
  wait ends on `ask.send`, which sends a question left unanswered as skipped, or on a skip, which skips the whole ask.
  A single question still ends on its answer. The call answers with every question and its answer.
- **Put on the board.** `ask.toCard` makes the ask a steps card beside the agent's tile, holding the answers so far
  (`fromAsk` on the card). The agent's call still waits: from then on the ask is answered only on its card, and the
  card's Send answers the call, in its own answer, typing nothing. A question whose options a card can't offer, or that
  the user answered in their own words, becomes a question answered in words, its options in its text. A skip still
  ends the wait from anywhere, and the card is stamped that its ask ended. A card taken off the board while its ask
  waits gives the ask back to the agent's tile, with the answers it had when it was put there: answers given on the
  card go with it. Put back by an undo while its ask still waits with no card, the card is its card again; otherwise
  it is stamped that its ask stopped. Only the card the ask waits on answers it, and while that card is being made the
  ask is answered nowhere, so a second Put on the board gives the same card. As the daemon starts, no ask waits, so any
  card still marked as waited on is stamped stopped.
- **An ask that ends half-answered is kept.** If the wait ends with no Send (a timeout, a cancelled call, the turn
  ending) after some answers, its questions and answers become a steps card, stamped that the agent stopped waiting,
  and a timeout tells the agent where the card is. Not when the agent's session ends (deleted, stopped, the daemon
  going): no card is made for an agent that is gone. A card the ask was already on is stamped the same way. From then
  on the card is an ordinary one: its Send is typed at the agent's prompt.

## A steps card is told, not held

A **steps card** (`agent-board steps new`, the MCP tool `steps_new`) is for more than a quick question: a set of
questions to step through, to-dos, or both. Unlike `ask`, nothing holds the agent's call.

- **Returns at once.** The card is a stored board item (ADR-0005), not a held call, so it outlives the agent's turn,
  and its answers outlive the agent. The agent ends its turn and waits for the message.
- **Typed at its prompt on Send.** The user answers in any order and presses Send once every required question is
  answered; the answers go to the card's maker as one message, typed at its prompt once it is ready, as a left plan's
  decision is, and led by `[agent-board]`. A question left unanswered is sent as skipped. Changing an answer and
  sending again tells the agent only what changed; Send with nothing changed is refused. Send is the user's own act,
  so the message is theirs.
- **Nothing else is typed.** An agent waiting on a to-do (`steps wait`) is told once someone else ticks it, or the
  card is closed, since it asked; ticking its own is told to no one. Unticking says nothing, and the wait a tick used
  is spent. What a change tells is typed only once the change is saved, so a refused one tells no one. Naming an agent on a to-do sends it nothing: it finds its
  to-dos with `steps ls --mine`.
- **A crew member's set goes to its orchestrator**, as its questions do (ADR-0016): the card is that orchestrator's to
  answer, which is flagged, and it answers and sends with `steps answer` instead of the user; sending clears the flag.
  The user's methods refuse that card while the orchestrator is live; once it ends or goes, the card is the user's to
  answer.
- **Holding the call is not offered.** A held set (`wait: true`) was proposed, and dropped: one quick question stays
  `ask`, held; everything longer is a card, told. The mixed case, a short held ask that turns into a card, is above: the card's Send answers the call.
- **Closed is closed.** The maker's `steps close` ends it: nothing is answered, ticked or added from then on. The card
  stays until the user takes it off the board, and stays when its maker's session ends.

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
- **Editing a plan counts as Request changes**: the user's edit goes back as the changes, and they approve the agent's next version. Rejected by the user: a round trip for a fix as small as a typo, and the agent may rephrase the edit. The rule that a decision is on a fixed text holds either way.
- **Editing a plan on its board card.** Rejected by the user: the text is edited only in the Plan tab.
- **A question card saved as a board item, like an agent note.** Rejected at first, for a single question: it would need deleting when the question goes, by every way it goes (an answer in the inbox, a timeout, a cancelled call, the daemon stopping), and a crash between the two would leave a card answering nothing. Drawn from the question, it has nothing to clean up.
- **A `data:` URL.** Rejected for size: Chromium caps the URLs it loads at 2 MB, and a large plan of non-ASCII text would pass that once encoded.
