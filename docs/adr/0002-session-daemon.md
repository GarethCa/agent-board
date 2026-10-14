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

**2026-10-09**:

- **Output as strings.** PTY output reaches clients as UTF-8 strings inside the JSON-RPC events (`session.snapshot`, `session.output`), as node-pty decodes it, rather than as raw bytes. Output that is not valid UTF-8 is not passed through byte for byte. Switch to base64 bytes if a binary-safe passthrough is ever needed.
- **Reattach and backpressure.** The headless terminal's scrollback (10 000 lines) is the per-session ring buffer. A snapshot is sent in pieces of at most 1 Mi UTF-16 code units, so it never hits the protocol's line cap. A client that falls more than 4 MiB behind stops getting output and is sent a fresh snapshot once it drains. A slow window therefore never makes the daemon buffer without bound, and never stalls the shell for other windows.
- **Hook tokens for shell sessions.** Shell sessions get a hook token row, because the column is NOT NULL, but the token is never put in their environment: a plain shell has no harness hooks. Agents get theirs in the environment as above.

**2026-10-09**:

- **The login shell's PATH.** A daemon started by an app opened from the Dock or Finder inherits launchd's bare PATH, where Homebrew-installed CLIs are missing. At start, before it spawns anything, the daemon reads its login shell's PATH (3 s cap, else it keeps its own) and puts it first in its own environment. Every CLI it runs, `git`, `gh`, and the harnesses and shells of its sessions, finds its program there. The harness launch still goes through the login shell too, which also gives it the profile's other variables.

**2026-10-10**: one exception to the per-session token. External sessions (ADR-0004) are not spawned, so they
have no token of their own: their global hooks post to `/external/<harness>` with one daemon-wide token, read from
`~/.agent-board/external-hook.json` (0600), and the payload's `session_id` says which session it is. That token only
lets a caller report external sessions, never reach an agent's session.

**2026-10-10**: shell tiles and their panes. Each pane is its own daemon session; a shell tile is a row in the
`shells` table holding its zone, folder and pane layout (a split tree of sessions and ratios), so the layout outlives
the app like the sessions do. A pane does not close when its shell exits: it says so until the user closes it. Panes
end with the daemon like every session; after a daemon restart the layout comes back with its panes shown as ended,
not with new shells spawned in their place.

**2026-10-10**: tiles keep their place. A shell tile's zone may be none (loose on the board, its shells started
at home), and agents, shells and external sessions each keep where their tile was put (x, y relative to the zone, and z)
in their own rows, NULL until the board slots the tile in and saves that. A plain shell made by `session.createShell`
gets a loose shell tile as it is made, so no session is off the board (sessions end with the daemon, so there are
none to adopt at start).

**2026-10-10**: a daemon whose data dir is gone exits (`data-dir-removed`), whether or not a client is
connected or a session is live: nothing can reach it any more. Because that ends every session, only a definite ENOENT
counts (any other stat error, such as an unreachable volume, does not), and it must persist for 3 s of idle-timer ticks
(about a second apart), so the exit comes a few seconds after the removal. The idle exit above is unchanged and still
holds under e2e, where the tests reap their own daemons (`e2e/launch.ts`).

**2026-10-10**: placement is visual. An agent's zone may be any zone or none, so each agent records its own
`repo_root` (taken from the zone it was started in); deleting it, its pull request lookup, linking an issue and a
scheduled relaunch's Codex setting go by that repo's zone (`repoZoneOf`), never by where its tile sits. An external
session keeps where its tile was put, in any zone or loose, until that zone is removed; its folder only says where it
first goes.

**2026-10-10**: the board survives reboots. A session that ends because its daemon went away is marked
`stopped_by_restart`: those a dead daemon left live (found at start, as before), and those the daemon ends as it shuts
down (a reboot's SIGTERM, `daemon.stop` with force, a removed data dir), which before were `done` or `failed` from their
exit. The user stopping or killing a session never marks it, even when the shutdown lands while that stop is under way. Nothing restarts on its own: `agent.resume` and
`shell.resumePane` start one again when the user asks, under the same session id, which clears the mark. Each session's
screen and scrollback are saved to `<data dir>/scrollback/<id>.json` (atomically, once its output has been quiet for 2 s,
at most every 20 s while it never is, and as it exits: serializing a full scrollback holds the daemon's one thread for
tens of milliseconds), so attaching to an ended session sends its saved screen and then `session.exited`, instead of
failing. A shell session's folder is looked up after output (`lsof` on macOS, `/proc` on Linux) and kept as `last_cwd`,
where a resumed pane starts. This supersedes the earlier "panes shown as ended": they are ended, and resumable.

**2026-10-11**: when an agent's process exits, not at a daemon shutdown and not for a reviewer, its pane drops
into a shell in its folder (`$SHELL -l`, under its saved screen), and `agent.resume` restarts any ended agent. That
shell is not a session to the user, so it does not count as live. It neither keeps the daemon from its idle exit nor
makes `daemon.stop` ask, and `daemon.health`'s `liveSessions` leaves it out. Shutting down ends it with the rest.
Nothing brings it back after a restart: the pane shows the agent's saved screen, and Restart still works. A scheduled
run or a flow hand-off to the ended agent ends its shell without asking: the user set that run up, and it needs the
pane. Restarting from the board asks first if the shell is running something.
