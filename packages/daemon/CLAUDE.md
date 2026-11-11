# packages/daemon: code map

The daemon owns the board: the SQLite database, the agents' terminals, the hooks they report through, and the JSON-RPC socket the app and the `agent-board` CLI talk to. `src/` is flat (about 160 files). Use this map to find a file, not a search of the whole folder.

## Big files: read them in parts

`protocol.ts` (about 6,000 lines), `board-cli.ts`, `agents.ts`, `orchestrator-layout.ts`, `board-ops.ts`, `board-mcp.ts`, `daemon.ts`, `agent-spawns.ts`, `orchestrators.ts`. Look up the line first (go to definition, or `rg -n`), then read about 80 lines around it.

- `protocol.ts`: every type the daemon and its clients share. `DaemonMethods` (about line 4170) lists each RPC method with its params and result. `DaemonEvent` (about line 5890) lists the events it pushes.
- `daemon.ts`: starts everything. `handlers` (about line 860) maps each RPC method to the module that serves it.

## By subsystem

| Subsystem | Files |
|---|---|
| Start, stop, the socket | `daemon.ts`, `daemon-launch.ts`, `restart.ts`, `stop.ts`, `lock.ts`, `spawn.ts`, `rpc.ts`, `params.ts`, `client.ts`, `paths.ts`, `migrate.ts` (SQL in `migrations/`), `schema-rollback.ts` (backups before migrating, and an older daemon on a newer database) |
| Agents | `agents.ts`, `agent-spawns.ts` (the harness command line and env), `agent-starts.ts`, `agent-lifecycle.ts`, `worktrees.ts`, `harness-path.ts`, `login-path.ts`, `board-env.ts` |
| Agent state from hooks | `hook-ingress.ts`, `hook-forwarder.ts`, `hook-states.ts`, `harness-state.ts`, `claude-state.ts`, `codex-state.ts`, `human-status.ts`, `turn-status.ts`, `quiet-turns.ts`, `subagents.ts` |
| Reading the harness's screen | `startup-screen.ts`, `codex-screen.ts`, `rate-limit-screen.ts`, `codex-config-guard.ts` |
| Terminals and shells | `sessions.ts`, `terminal-backend.ts`, `node-pty-backend.ts`, `terminal-input.ts`, `shells.ts`, `shell-integration.ts`, `pane-layout.ts`, `window-layout.ts`, `foreground.ts`, `background-commands.ts` |
| Messages between agents | `deliveries.ts`, `sender-marker.ts`, `reply-paths.ts`, `handoff-text.ts`, `flow-edges.ts`, `flow-conditions.ts`, `flow-payloads.ts`, `flow-approvals.ts` |
| Transcripts and chat | `transcripts.ts`, `transcript-adapters.ts`, `claude-transcript.ts`, `external-sessions.ts`, `external-hooks.ts`, `resume-external.ts` |
| Board items | `items.ts`, `connectors.ts`, `agent-notes.ts`, `documents.ts`, `memory-queue.ts`, `steps.ts`, `clocks.ts`, `schedules.ts`, `cron.ts`, `link-cards.ts`, `link-metadata.ts`, `image-store.ts`, `image-sweeper.ts`, `mermaid.ts`, `diagram.ts` |
| Zones and layout | `zones.ts`, `zone-*.ts`, `repo-zone.ts`, `board-layout.ts`, `board-arrange.ts`, `arrange-board.ts`, `board-tidy.ts`, `board-room.ts`, `shelf-layout.ts`, `tile-position.ts`, `layout-measures.ts`, `work-units.ts` |
| Orchestrators and crews | `orchestrators.ts`, `orchestrator-layout.ts`, `master.ts`, `crew-*.ts`, `prefab-library.ts`, `role-templates.ts` |
| What agents call (CLI and MCP) | `board-cli.ts`, `board-ops.ts`, `board-mcp.ts`, `board-mcp-http.ts`, `*-ops.ts` (layout, memory, steps, clock), `asks.ts`, `selection-asks.ts`, `agent-page.ts`, `agent-records.ts`, `character.ts` |
| Reviews, gates, pull requests | `reviews.ts`, `review-doc.ts`, `gates.ts`, `gate-rules.ts`, `gate-output.ts`, `gate-actions.ts`, `pull-requests.ts`, `agent-pull-requests.ts`, `pull-request-tabs.ts`, `push-targets.ts`, `trackers.ts` |
| Settings and the rest | `settings.ts`, `setup-checks.ts`, `permissions.ts`, `usage.ts`, `time-zone.ts`, `cli.ts`, `cli-install.ts` |

## Adding an RPC method

1. Add its types and its line in `DaemonMethods` (`protocol.ts`), and the event if it pushes one.
2. Serve it from the subsystem's module, and add it to `handlers` in `daemon.ts`.
3. If agents call it: the command in `board-ops.ts` (the CLI and MCP share it), then `board-cli.ts` or `board-mcp.ts`.
4. If the app calls it: see "One call from the window to the daemon" in `apps/desktop/CLAUDE.md`.

## Tests

`test/` has mostly one file per module, named after it (`zones.ts` is tested in `test/zones.test.ts`). Some pure modules keep their test next to them in `src/`. Helpers are in `test/helpers.ts`:

- `startTestDaemon` and `connectTestClient`: a real daemon on a temporary data dir.
- `tempDataDir`, `tempRepo`, `git`: folders and repos that are removed when the test ends.
- `insertFakeSession`, `recordEvents`: a session without a harness, and the events a client receives.

`test/fake-clock.ts` drives time. Agents run on `packages/fake-harness`, never on the real CLIs.
