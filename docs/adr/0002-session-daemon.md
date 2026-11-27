---
status: accepted
---
# Sessions live in a separate daemon process

All sessions, PTYs, the SQLite database, the scheduler and the webhook listener live in `agent-board daemon` — the same `agent-board` executable started with a `daemon` subcommand — and the Electron app is only a client. This is what lets sessions survive window closes and app restarts, tmux-style.

- **Lifetime.** The app starts the daemon (detached) if none is running. On app quit the daemon keeps running while any session is alive, so a relaunch reattaches; it exits on its own when the last session ends and no client is connected. *Amended:* it also stays up while any agent has an enabled schedule, since a schedule relaunches its agent when it fires. A fully headless daemon (launchd/systemd) is M4.
- **Transport.** Clients talk to the daemon over a local socket (Unix domain socket; named pipe on Windows) using JSON-RPC requests plus a server-pushed event stream. PTY output is streamed as raw bytes per session.
- **Hook ingress.** The daemon also listens on `127.0.0.1:<port>` (HTTP) for harness hooks. Each spawned session gets a per-session token in its environment, so hook calls authenticate and map to a session without guessing.
- **Reattach.** The daemon keeps a scrollback ring buffer per session and a headless terminal model (`@xterm/headless` + serialize addon) so a reconnecting window gets the current screen instantly.

## Considered options

- **PTYs in the Electron main process** — simplest, but every app quit or crash kills every agent. Rejected: the definition of done requires sessions to survive a relaunch.
- **tmux as the session owner** — gives persistence for free, but adds a hard dependency, hides PTY bytes behind tmux's own renderer, and is awkward on Windows.

## Amendments

**Update**:

- **Output as strings.** PTY output reaches clients as UTF-8 strings inside the JSON-RPC events (`session.snapshot`, `session.output`), as node-pty decodes it, rather than as raw bytes. Output that is not valid UTF-8 is not passed through byte for byte. Switch to base64 bytes if a binary-safe passthrough is ever needed.
- **Reattach and backpressure.** The headless terminal's scrollback (10 000 lines) is the per-session ring buffer. A snapshot is sent in pieces of at most 1 Mi UTF-16 code units, so it never hits the protocol's line cap. A client that falls more than 4 MiB behind stops getting output and is sent a fresh snapshot once it drains. A slow window therefore never makes the daemon buffer without bound, and never stalls the shell for other windows.
- **Hook tokens for shell sessions.** Shell sessions get a hook token row, because the column is NOT NULL, but the token is never put in their environment: a plain shell has no harness hooks. Agents get theirs in the environment as above.

**Update**:

- **The login shell's PATH.** A daemon started by an app opened from the Dock or Finder inherits launchd's bare PATH, where Homebrew-installed CLIs are missing. At start, before it spawns anything, the daemon reads its login shell's PATH (3 s cap, else it keeps its own) and puts it first in its own environment. Every CLI it runs, `git`, `gh`, and the harnesses and shells of its sessions, finds its program there. The harness launch still goes through the login shell too, which also gives it the profile's other variables.

**Update**: one exception to the per-session token. External sessions (ADR-0004) are not spawned, so they
have no token of their own: their global hooks post to `/external/<harness>` with one daemon-wide token, read from
`~/.agent-board/external-hook.json` (0600), and the payload's `session_id` says which session it is. That token only
lets a caller report external sessions, never reach an agent's session.

**Update**: shell tiles and their panes. Each pane is its own daemon session; a shell tile is a row in the
`shells` table holding its zone, folder and pane layout (a split tree of sessions and ratios), so the layout outlives
the app like the sessions do. A pane does not close when its shell exits: it says so until the user closes it. Panes
end with the daemon like every session; after a daemon restart the layout comes back with its panes shown as ended,
not with new shells spawned in their place.

**Update**: tiles keep their place. A shell tile's zone may be none (loose on the board, its shells started
at home), and agents, shells and external sessions each keep where their tile was put (x, y relative to the zone, and z)
in their own rows, NULL until the board slots the tile in and saves that. A plain shell made by `session.createShell`
gets a loose shell tile as it is made, so no session is off the board (sessions end with the daemon, so there are
none to adopt at start).

**Update**: a daemon whose data dir is gone exits (`data-dir-removed`), whether or not a client is
connected or a session is live: nothing can reach it any more. Because that ends every session, only a definite ENOENT
counts (any other stat error, such as an unreachable volume, does not), and it must persist for 3 s of idle-timer ticks
(about a second apart), so the exit comes a few seconds after the removal. The idle exit above is unchanged and still
holds under e2e, where the tests reap their own daemons (`e2e/launch.ts`).

**Update**: placement is visual. An agent's zone may be any zone or none, so each agent records its own
`repo_root` (taken from the zone it was started in); deleting it, its pull request lookup, linking an issue and a
scheduled relaunch's Codex setting go by that repo's zone (`repoZoneOf`), never by where its tile sits. An external
session keeps where its tile was put, in any zone or loose, until that zone is removed; its folder only says where it
first goes.

**Update**: the board survives reboots. A session that ends because its daemon went away is marked
`stopped_by_restart`: those a dead daemon left live (found at start, as before), and those the daemon ends as it shuts
down (a reboot's SIGTERM, `daemon.stop` with force, a removed data dir), which before were `done` or `failed` from their
exit. The user stopping or killing a session never marks it, even when the shutdown lands while that stop is under way. `agent.resume` and
`shell.resumePane` start one again under the same session id, which clears the mark; the next daemon's start does so
for what its restart stopped (see "A restart brings back what it stopped", below, which supersedes "nothing restarts
on its own"). Each session's
screen and scrollback are saved to `<data dir>/scrollback/<id>.json` (atomically, once its output has been quiet for 2 s,
at most every 20 s while it never is, and as it exits: serializing a full scrollback holds the daemon's one thread for
tens of milliseconds), so attaching to an ended session sends its saved screen and then `session.exited`, instead of
failing. A shell session's folder is looked up after output (`lsof` on macOS, `/proc` on Linux) and kept as `last_cwd`,
where a resumed pane starts. This supersedes the earlier "panes shown as ended": they are ended, and resumable.

**Update**: when an agent's process exits, not at a daemon shutdown and not for a reviewer, its pane drops
into a shell in its folder (`$SHELL -l`, under its saved screen), and `agent.resume` restarts any ended agent. That
shell is not a session to the user, so it does not count as live. It neither keeps the daemon from its idle exit nor
makes `daemon.stop` ask, and `daemon.health`'s `liveSessions` leaves it out. Shutting down ends it with the rest.
Nothing brings it back after a restart: the pane shows the agent's saved screen, and Restart still works. A scheduled
run or a flow hand-off to the ended agent ends its shell without asking: the user set that run up, and it needs the
pane. Restarting from the board asks first if the shell is running something.

**Update**: every wake as Wake. Superseding the line above, nothing starts an ended agent over its shell without
the check Wake makes. A scheduled run, a hand-off, a resend and a retried start go through the same check (`wakeRefusal`) as the board's Restart, never forced. None starts it while its shell runs
something or its own harness runs there, and none starts a reviewer whose round is over (a retried start aside).
None of these paths can ask the user, so a run or hand-off refused for its shell is kept as not delivered on the
agent, with the reason, for the user to Resend once the shell is free. A board notice never wakes a paused agent: it
is busy, and tried again later.
Each of them, an orchestrator's `send` and the composer's answer decide what becomes of a message (typed now, kept
until the turn ends or the session is up, a wake, or refused) by one plan (`planMessage`).

**Upgrades**: an app shows nothing of a daemon from another build. The daemon outlives the app, so after
an upgrade the new app may find the old build's daemon still running, and code from one build can't read another's
state: the new board read fields the old daemon never sent, threw while rendering, and left its window blank, the offer
to restart the daemon with it. So the board and every popped-out window first ask `daemon.health`, and on another build
show only that offer, until the restart. `agent-board restart-daemon --data-dir <dir>` restarts the daemon as its own
build for the app's updater: it stops the old daemon with force, so its sessions are stopped by restart, starts its
own, and waits while that daemon's start brings back each agent and shell pane the stop ended (`daemon.afterRestart`).
It says what it restarted and what came back, and names the agents it cut off mid-turn, which wait at their prompt for
the user's Carry on. It fails when another build's daemon answers in its place, which may bring back nothing. It starts the daemon from the home folder, with the caller's environment less every `AGENT_BOARD_*`, pnpm's script
variables, the Claude Code session it may run in, and `node_modules/.bin` on PATH, which a daemon would otherwise hand
all its sessions. It refuses to run inside a session of the daemon it restarts (that daemon an ancestor of it), as
stopping the daemon would end it first, and when it can't tell (no `ps`, or Windows). `pnpm update:app` runs
it between installing the app and opening it, unless told `--no-restart`, or run inside such a session (or unsure of it), where it leaves
the daemon running and the app offers the restart.

**Resuming a cut-off turn**: sessions still end with their daemon. An agent whose daemon went away while
it was at work (running, thinking, or on a permission prompt) has its turn cut off; the daemon records that
(`agents.turn_cut_off`) as its session ends at a shutdown, or at the next start for a daemon that died, where the
agent's last state is still the one it had. A Claude agent whose transcript ends in Claude's own "Request interrupted by
user" was stopped by the user with Esc, which Claude fires no hook for, so it is not cut off. Any resume in its
conversation that the user or an orchestrator asks for (`agent.resume`: Resume, Wake all; and an orchestrator's restart
or wake of its crew) carries on its conversation with the harness's own resume and types one fixed line as its next message, "The app
restarted; carry on from where you were." Each was asked for, by the user or an orchestrator they set going, so it is
that ask relayed, not the app acting on its own. The record stays until a turn begins, so a restart before the line
could be typed tells it again; it goes once its session ends any other way, or it starts on a new conversation. An agent
that was idle, or had ended its turn on a question, is told nothing. With no conversation to carry on it starts afresh
on its task, as before. `Agent.cutOffMidTurn` says it is still to be told, which is how `restart-daemon` names the
agents cut off, rather than guessing from their states before the stop. The daemon's own start, below, never types it. A resume after a restart is normal, so it puts no
notice on the tile. Only an agent that had turns but lost its conversation is told so, until a turn begins.

**A restart brings back what it stopped**: after the app or the machine restarts, every agent comes back as it was, and
the user presses nothing. The daemon marks each session its own shutdown ends, or each that a dead daemon left live, as
the latest restart's (`sessions.resume_at_start`, set with `stopped_by_restart`; the migration that adds it marks the
latest batch an older daemon stopped as it shut down, so the first start onto this build brings that back too). Once its
socket listens, the next
start brings back each marked agent still stopped by restart, one at a time, with a quiet resume: in its conversation,
tile, worktree and branch, typing nothing to it. An agent that was idle comes back idle at its prompt; one cut off
mid-turn comes back at its prompt too, still `cutOffMidTurn`, and its tile reads `backAfterRestart`. A task the agent
never had (its first prompt never reached it) is still typed, as that was its own start; one it had is not typed
again. Each marked shell pane is reopened. A paused, done or exited agent was never marked, and stays as it was; so
does one an earlier restart stopped, as every start spends the marks (a start that brings nothing back, as the e2e
suite runs with `AGENT_BOARD_RESUME_AFTER_RESTART=0`, clears them). Each session is tried once: one that fails stays
stopped by restart, named in `daemon.afterRestart`'s `notResumed`, and waits for its Wake. The agent of a clock run the
restart stopped is left to its clock, which closes or keeps it. One woken while the start ran is counted as back if it
is live, and otherwise left as it was then (paused, done or exited): the start resumes only what is still stopped by
restart and still marked. A daemon that shuts down while its start is running resumes nothing more, waits for the
resume in hand, and leaves the untried their marks for the next start. This relaunches what was running and never prompts
anyone, so it is not the app acting on the agents' behalf beyond what the harness does: a relaunched harness sits at
its prompt as it was left. The board's restart banner says how many came back, how many were cut off mid-turn and how
many stayed stopped; its Carry on (`agent.carryOn`) types the fixed line to the cut-off ones only, once each is up,
and wakes nothing; it is the user's ask, as Wake all's line is. One it couldn't tell keeps its Carry on, and Wake all is
offered for what stayed stopped once none is left to tell. One cut off on a permission prompt is counted as neither by
the start nor by the banner. The banner waits while the start is still bringing agents back
(`Agent.comingBackAfterRestart`), so a Wake all pressed then can't race the start's own resume. `wake` (an orchestrator's, or the CLI's) takes an agent stopped by a restart as well as a
paused one, as `restart` does.

Keeping the agents themselves alive across a daemon restart was considered and left for later. A PTY is owned by the
process that opened it, so it would take a holder process per agent and a protocol to reattach to it; and each agent
is launched with the daemon's hook and board MCP URLs, on a port the daemon picks afresh at each start, so a surviving
agent would report to nothing until that port were kept too. A restart for an upgrade, the common case, also has to
replace the code that would hold them.
