---
status: accepted
---
# Needs you lists what agents ask for, and a crew member's flag goes to its orchestrator

The needs-you inbox listed every live agent `waiting` or needing permission. Hooks say `waiting` each time a turn ends at the prompt, so on a board of orchestrated agents it filled with crew members that had only finished a turn for their orchestrator, and OS notifications, which followed the same states, said so too. Codex never reached it at all, as its hooks never say `waiting`. The decisions are what counts as needing the user, how an agent says so, and where a crew member's request goes.

## Only explicit requests, by default

- **The rule is one function** (`needsYouKind` in the protocol): a permission prompt pending (or `needs-permission`), a question (`ask`), a plan waiting on a decision, or a flag that reaches the user, in that order; with `DaemonSettings.needsYouShows: 'turns'`, also an agent `waiting` at its prompt. The inbox, the pill, the dock badge, each tile's needs-you look and pill, the switcher, the daemon's start banner and notifications all read it with the one setting, so they agree. The daemon keeps the setting and tells every client when it changes (`settings.updated`).
- **The default is explicit requests only.** A turn ending is no request: the agent's tile looks idle, and the inbox, pill and notifications say nothing. The old behaviour stays one switch away, in Settings › Notifications.
- **A permission prompt always counts**, whoever started the agent: only the user can allow or deny a tool. A question and a plan count when an agent the user started (or an orchestrator) puts them; a crew member's go to its orchestrator, below. A first version listed a crew member's questions and plans for the user too, as only the user answers a held question (ADR-0014); that went against the decision that only orchestrators, top-level agents and permission prompts reach Needs you, so they became flags.

## A flag: "please look", with nothing held

- **`board.needsYou`** (`agent-board needs-you <reason>`, MCP `needs_you`) sets the caller's flag: a reason in a line, at most `MAX_FLAG_LENGTH`, replacing any it had. It is in `BOARD_CALLER_METHODS` and acts only for a live agent from its own session, as `board.setStatus` does. Unlike `ask`, nothing waits, so it is a CLI command too: a shell command returns at once.
- **Each flag has an id**, so one raised again with the same reason (or in the same millisecond) is still new to the crew events, the orchestrator and notifications.
- **It goes when the user looks.** Opening the agent's session (`agent.markSeen`) clears it, as does the agent (`--clear`) and its session ending. It is kept in memory only: a daemon restart ends every session, which would clear it anyway. It is not tied to `seen`, which every state change resets: an agent flags mid-turn, then its turn ends, and the flag must outlast that.
- **Injected guidance** is the board MCP's instructions and the tool's description: a turn ending tells no one, so flag when blocked, ready for review, or a decision is needed. Nothing nudges an agent to flag; it is the agent's own call.

## A crew member's flag goes to its orchestrator

- **Who a flag reaches** (`AgentFlag.to`) is worked out each time the agent is read: its orchestrator (`spawnedBy`) while that one's session is live, else the user. An orchestrator ending passes its crew's open flags to the user, and the daemon re-announces them so the inbox shows them.
- **The orchestrator hears it two ways**: a `flagged` crew event, for one that watches its crew, and a message typed at its prompt (`crew-flags.ts`), one for all its crew's flags not yet told, typed as a hand-off is (below). The message names each crew member by ref and says how to answer (`agent-board send`) or pass it on (`agent-board needs-you --via <ref>`). This types into an agent's terminal for another agent, as a hand-off does; the app itself never sends anything of its own.
- **It clears** when the orchestrator `send`s the crew member a message, when the crew member clears it, or when the user opens the crew member's session.
- **Passing it on** (`via`, a crew member the orchestrator started) sets the orchestrator's own flag, to the user, naming the crew member on the inbox row.
- **A crew member's question or plan is a flag too.** While its orchestrator is live, `board.ask` and `board.presentPlan` hold nothing: they set the crew member's flag (`asks: <question> (<options>)`, or `plan to review, in <path>: <title>`). Nothing is cut silently: a question and options too long for a flag are written in full to `CREW_QUESTION_PATH` in the crew member's worktree, and the flag names the file and how many options it has, with the question's start and answer at once with `SentToOrchestrator`, telling the agent to end its turn, as the orchestrator's answer comes as its next message (`send` takes only an agent between turns). A plan's body is written to `CREW_PLAN_PATH` in the crew member's worktree, where `agent-board read` reaches it; not for an agent resumed in a folder of the user's (`ownsWorktree` false), whose plan waits for the user as any other. Crew members start in worktrees agent-board made, so that is rare. Once its orchestrator has ended, its question or plan waits for the user as any agent's does.
- **Typed as a hand-off is.** The message goes through the deliveries' queue, after any line still being typed, and only while the orchestrator is ready for its next message by the rule hand-offs and scheduled runs use (`whyNotReady`): at its prompt with nothing pending, not in Claude's own question or dialog (a `waiting` its idle prompt didn't make), and not while the user has a half-typed line there. Refused, it stays pending and is tried again at the orchestrator's next update.

## Notifications follow the list

`createAgentAlerts` raises one OS notification per new request in the inbox, with its reason. It keeps, per agent, every request standing as it was last heard (its permission prompts as one, each question id, plan version and flag id), not only the most pressing: a request is told of once while it stands, so a flag that outlasts a permission prompt isn't told of again, and one raised behind a question still is. One that goes is forgotten, so its return is news. A turn ending, a failure and an end raise none. `notifications` turns them off, and `notifyInFront` (off by default) whether they come while one of the app's windows is in front and drawn. A muted agent still raises none.

## Considered options

- **The crew member's flag in the user's inbox, marked as a crew one.** Rejected: the orchestrator exists to field its crew; the user would be back to watching every crew member.
- **A flag as a question with no options.** Rejected: a question holds the agent's call until the user answers (ADR-0014), and most flags need no answer, only a look.
- **Typing a crew flag into the orchestrator's turn at once.** Rejected: a line typed mid-turn is queued into that turn, or taken as an answer to whatever it is doing; waiting for its prompt is what `send` and hand-offs do.
