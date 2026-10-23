---
status: accepted
---
# The board master: one agent the user asks for work, which routes it to a zone's orchestrator and keeps an eye on things

Leading a busy board by hand means one long-lived agent session at `board` scope that starts agents and reviewers, watches them and reports. Everything it needs exists (ADR-0011's orchestrator commands, ADR-0012's edges, ADR-0016's flags), but the user has to create that session, give it board scope, tell it its job and find it again after every pan. The **board master** makes that one session a part of the app: one place to say what you want ("fix the flaky merge-gate test in agent-board"), which hands the work to the right zone's orchestrator and tells you what needs you. The decisions are what it is, where it lives, what it may do, how it talks to orchestrators, and how it reports.

## What it is

- **An agent, not a new kind of thing.** The master is an ordinary agent session, marked as the master (`Agent.master`, `agents.master`, migration 0060, at most one row set), with the orchestrator scope `board`, set by hand as the user's own start sets any scope. Everything ADR-0010 and ADR-0011 say of an agent and an orchestrator holds for it: its board token, the guard, the scope checks, the text allowlist, the activity log, its permission prompts going to the user. It expands, pops out, shows its chat, restarts and is deleted as any agent is.
- **One per board.** `master.start` returns the board's master when there is one, live or ended, and starts one only when there is none. Deleting its tile deletes it; the next start makes a new one. A second is never made, so "the master" always names one session.
- **Only the user starts it.** `master.start` is the app's: a board token's connection is refused it, as every method outside `BOARD_CALLER_METHODS` (the guard stays default-deny), so no agent makes a master or makes itself one. The app calls it only from the user's click (the panel's **Start the master**, below), never by itself.
- **No repo of its own.** It works in a folder the daemon makes for it, `master` in the daemon's data folder: not a git repo, with no worktree and no branch (`ownsWorktree` false, as an Ask Claude agent's folder). So it never opens a pull request or merges (ADR-0011's no-branch rule), and deleting it leaves the folder. It reads repos through `agent-board read` and the agents it starts, which work in worktrees of their own.
- **Claude, Opus by default.** The panel's start takes the harness and model like New agent, defaulting to Claude and `opus`: routing and summarising need judgement more than speed. Codex works too: nothing here is Claude's.
- **Not a role.** Its mark is the column, not a role name: `agent-board new --role master` makes an agent with a custom role of that name and no more, so nothing but `master.start` makes the master, and its role chip stays free.
- **Its brief is its first message.** It starts with the master's prompt (`MASTER_PROMPT`) and no role template, so that prompt is exactly its first message: what it is for, the commands it routes with, and the rules below. Then it waits for the user. Its tile sits loose on the board, outside every zone, left of the zones' top-left corner where nothing is.

## Where it lives in the app

- **On the board: a tile like any agent's**, outside every zone, with a teal **MASTER** badge and a teal outline (`--master`), and dashed teal **rails** to each orchestrator it watches (below), drawn with the board's other connections, so the View toggle that hides crew frames and tethers hides them too. Its digest is an agent note beside it (below).
- **From anywhere: a docked panel.** ⌘⇧M (`move.master`, a `new` key in the key registry, ADR-0015) or the teal **Master** button beside the Needs-you pill opens a 360 px panel docked on the right of the board window (not while a dialog, menu or session window is over the board, which keep their keys): a header (the master's name, "board scope · `<model>`", Show on board, close), **Watching** (each zone, its orchestrator's state and crew size, or "no orchestrator"; a click shows the tile), **For you** (the Needs-you list's rows, then the master's digest), and the master's **chat**, the chat view with its message box, focused when ⌘⇧M opened it. The Master button counts the Needs-you rows, the same number as the pill.
- **One session, two views.** The panel and the tile are views of the same agent. Closing the panel stops nothing; Esc closes it when the focus is in it. With no master yet, the panel says what the master does and offers **Start the master**; with an ended one, **Restart** (it carries on its conversation, as a tile's Restart does).

## What it may do, and what it never does

- **Board scope, and no more.** It starts, messages, waits for, reads, interrupts, restarts and closes agents anywhere, joins them with edges and lays out the board, all through ADR-0011's methods and their checks. It may steer any orchestrator, since none is wider than `board`.
- **Never for the user.** It never answers or decides a permission prompt, answers a question or plan held for the user, types into a session, changes a setting or a zone's switch, or grants anyone orchestrating: none of those methods is open to a board token. It merges nothing itself (it has no branch), and removes only agents it started, after their unsaved-work check. An agent it starts asks the user for its permissions, as every agent does.
- **Its leads' questions and plans are the user's, never its own to settle.** ADR-0016 sends a crew member's questions and plans to its orchestrator as flags, so a master that "settled" them would approve, by a message, a plan the user would have reviewed had they started that lead themselves. So the master is the one orchestrator they never go to: an agent the master started asks and presents plans as a top-level agent does (`board.ask` and `board.presentPlan` hold them for the user, in Needs you), and while one waits on the user, `send` refuses it, as it does any agent waiting on the user. A flag from its crew that asks for a decision goes to the user too, with `needs-you --via`; the master answers only what is about routing or status.
- **No more than the harness.** The app never sends the master anything of its own, and nothing in the app wakes it. Between turns it hears only the user and its crew's flags, typed at its prompt as ADR-0016 types them for any orchestrator; it watches with `agent-board watch` only inside a turn the user started. Its brief tells it to act on what the user asks: route the request, report, and steer an orchestrator only for that request. Nothing in the app starts, restarts, nudges or approves anything on the master's behalf, or on the user's.
- **Its orchestrators work in worktrees.** An orchestrator the master starts is started by an orchestrator, so it gets a worktree of its own (ADR-0011: only the user's own start gives a main checkout). It orchestrates by its zone's switch, as any agent does. So in a zone whose **Let agents orchestrate** is off, a lead the master starts could start no one: `orchestrator.spawn` refuses the master an agent with the orchestrator role there, saying to tell the user (`needs-you`), who can turn the switch on or start the zone's orchestrator.
- **A zone's switch doesn't take its scope.** Turning a zone's **Let agents orchestrate** off clears hand grants in it (ADR-0011), but not the master's: its scope is the user's grant by starting it, wherever its tile is moved.
- **Crew depth counts it.** It is the top of its crew: an orchestrator it starts is second, and that orchestrator's agents third, who start no more (`MAX_CREW_DEPTH`). A lead, its implementers and their reviewers fit, and the bound stays.

## How it and the orchestrators talk

- **Through what exists: `send`, `read`, `wait`/`watch`, status lines and flags.** No new channel. To route a request it finds the zone (from the repo, issue or wording, or by asking the user) with `agent-board tree`, then `send`s the request to that zone's orchestrator, or, with none, starts one there with `agent-board new --zone <zone> --role orchestrator <request>`. It does not do the zone's work itself.
- **Reporting up is a flag.** An orchestrator the master started has it as `spawnedBy`, so its flags go to the master (ADR-0016), which settles what is about routing or status and passes the rest on with `needs-you --via`; its questions and plans go to the user (above). An orchestrator the user started still reports to the user; the master watches it with `agent-board watch <ref>` and reads its status line and handover.
- **Considered: a parent/child channel with structured status.** Rejected for now: crew events, status lines and flags already carry state, needs and hand-overs, scope-checked and logged. A second channel would be a second set of rules to keep in step.

## Which orchestrators it watches

- **Watched** are the live agents with the orchestrator role, and every agent the master started that orchestrates, in any zone: the zones' leads. The panel's Watching list and the tile's rails show them, a zone with none as "no orchestrator". It is the app's reading of the board, not a list the master keeps: the master may watch more or fewer with `watch`.

## How it reports to the user

- **One list.** What needs the user is the Needs-you list (ADR-0016), whoever raised it; the master adds no second queue. The panel's For you section is that list's rows, each opening what it names, as the inbox's do.
- **Its digest is an agent note beside its tile**, which it keeps up to date with `agent-board note add|edit` (ADR-0011): its one-line read on each thing that needs the user and on each zone. The panel shows the latest digest note under For you, with when it last wrote it. When it needs the user itself, it flags, like any top-level agent.

## Restarts and long runs

- **A session like any.** It survives the app quitting (the daemon keeps it); a daemon restart stops it, as it stops every session (`stopped-by-restart`), and the panel or its tile restarts it, carrying on its conversation. Nothing restarts it by itself.
- **It runs for days on the harness's own compaction.** Its digest note and `agent-board tree` hold what it needs to pick up after one; a fresh restart (the tile's, or `restart --fresh` from the user's side) clears its conversation when it is too long.

## Considered options

- **A router built into the daemon, with no agent.** Rejected: routing by wording, reading hand-overs and summarising need a model, and an agent already has the board's commands and checks.
- **A command bar, with the digest in the Needs-you popover.** Rejected by the user: no running conversation to follow up in, and what the master watches shows nowhere.
- **Only the docked panel, or only the tile.** The user picked both: the tile fits the board's model and the rails show what it watches at a glance; the panel reaches the master after a pan, from anywhere.
- **The master in a zone, or in the main checkout of a repo.** Rejected: it is for the whole board, and a checkout would give it a branch and work it shouldn't do.
- **More than one master.** Rejected: "ask the master" must name one session.
