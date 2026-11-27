# packages/daemon: code map

The daemon owns the board: the SQLite database, the agents' terminals, the hooks they report through, and the JSON-RPC socket the app and the `agent-board` CLI talk to. `src/` is flat (about 160 files). Use this map to find a file, not a search of the whole folder.

## Big files: read them in parts

`protocol.ts` (over 6,000 lines), `board-cli.ts`, `agents.ts`, `orchestrator-layout.ts`, `board-mcp.ts`, `board-ops.ts` (each over 2,000), `daemon.ts`, `orchestrators.ts`, `agent-spawns.ts`, `board-arrange.ts`, `queues.ts`, `flow-edges.ts`, `deliveries.ts` (each over 1,000). Every file over 300 lines is named on this page. Look up the line first (go to definition, or `rg -n`), then read about 80 lines around it.

- `protocol.ts`: every type the daemon and its clients share. The interface `DaemonMethods` lists each RPC method with its params and result. The type `DaemonEvent` lists the events it pushes. Go to their definitions; don't scroll.
- `daemon.ts`: starts everything. The `handlers` object in it maps each RPC method to the module that serves it.

## By subsystem

| Subsystem | Files |
|---|---|
| Start, stop, the socket | `daemon.ts`, `event-ring.ts` (every broadcast event numbered, the recent ones kept for devices that drop), `run-daemon.ts` (a daemon in the foreground, as `agent-board daemon` runs it), `daemon-launch.ts`, `restart.ts`, `stop.ts`, `lock.ts`, `spawn.ts`, `rpc.ts`, `params.ts`, `client.ts`, `paths.ts`, `migrate.ts` (SQL in `migrations/`), `schema-rollback.ts` (backups before migrating, and an older daemon on a newer database) |
| Agents | `agents.ts`, `agent-close.ts` (every close and delete: helpers, then reviewers, then the agent, unsaved work judged one way), `agent-spawns.ts` (the harness command line and env), `launch-settings.ts`, `launch-settings-keychain.ts` and `launch-settings-store.ts` (an agent's own env vars and settings: their values in the keychain, or a file where there is none, their names in its row), `agent-starts.ts`, `agent-lifecycle.ts`, `worktrees.ts`, `harness-path.ts`, `login-path.ts`, `board-env.ts` |
| Agent state from hooks | `hook-ingress.ts`, `hook-forwarder.ts`, `hook-states.ts`, `harness-state.ts`, `claude-state.ts`, `codex-state.ts`, `human-status.ts`, `turn-status.ts`, `quiet-turns.ts`, `subagents.ts` |
| Reading the harness's screen | `startup-screen.ts`, `codex-screen.ts`, `rate-limit-screen.ts`, `codex-config-guard.ts` |
| Terminals and shells | `sessions.ts`, `terminal-sizing.ts` (who of a terminal's viewers sets its size), `left-screen.ts` (the screen a full-screen harness leaves as it exits), `terminal-backend.ts`, `node-pty-backend.ts`, `terminal-input.ts`, `shells.ts`, `shell-integration.ts`, `pane-layout.ts`, `window-layout.ts`, `foreground.ts`, `background-commands.ts` |
| Messages between agents | `deliveries.ts`, `sender-marker.ts`, `reply-paths.ts`, `handoff-text.ts`, `flow-edges.ts`, `flow-conditions.ts`, `flow-payloads.ts`, `flow-approvals.ts` |
| Transcripts and chat | `transcripts.ts`, `transcript-adapters.ts`, `claude-transcript.ts`, `external-sessions.ts`, `external-hooks.ts`, `resume-external.ts` |
| Board items | `items.ts`, `connectors.ts`, `agent-notes.ts`, `documents.ts`, `queues.ts`, `steps.ts`, `clocks.ts`, `schedules.ts`, `cron.ts`, `link-cards.ts`, `link-metadata.ts`, `image-store.ts`, `image-sweeper.ts`, `mermaid.ts`, `diagram.ts` |
| Zones and layout | `zones.ts`, `zone-*.ts` (among them `zone-sources.ts`, a zone from a GitHub repo, and `zone-map.ts`, a zone as the map an orchestrator reads), `repo-zone.ts`, `board-layout.ts`, `board-arrange.ts`, `arrange-board.ts`, `board-tidy.ts`, `board-room.ts`, `shelf-layout.ts`, `tile-position.ts`, `layout-measures.ts`, `work-units.ts` |
| Orchestrators and crews | `orchestrators.ts`, `orchestrator-layout.ts`, `master.ts`, `crew-*.ts` (among them `crew-loop.ts`, a running crew's loop, and `crew-prefabs.ts`, a saved crew shape and its `.crew.json`), `prefab-graph.ts` (a prefab's graph from its members' starts, and the starts and round limit read back from it), `prefab-checks.ts` (the checks a graph passes as its file is read), `prefab-paths.ts` (a non-maker's own paths), `prefab-library.ts`, `role-templates.ts` |
| What agents call (CLI and MCP) | `board-cli.ts`, `board-ops.ts`, `board-mcp.ts`, `board-mcp-http.ts`, `board.ts` (the `board.*` RPC methods and who may call them), `*-ops.ts` (among them `layout-ops.ts` for `move`, `arrange`, `zone` and `note`, and `queue-ops.ts` for `queue`; also steps and clock), `asks.ts`, `selection-asks.ts`, `agent-page.ts`, `agent-records.ts`, `character.ts` |
| Reviews, gates, pull requests | `reviews.ts`, `review-doc.ts`, `gates.ts`, `gate-rules.ts`, `gate-output.ts`, `gate-actions.ts`, `pull-requests.ts`, `agent-pull-requests.ts`, `pull-request-tabs.ts`, `push-targets.ts`, `trackers.ts`, `ticket-watches.ts` (what a ticket's watches report of its pull request) |
| Settings and the rest | `protocol.ts` (the shared types, above), `settings.ts`, `setup-checks.ts`, `permissions.ts`, `usage.ts`, `time-zone.ts`, `cli.ts`, `cli-install.ts`, `live-home.ts` (what only the installed app may change in the user's home) |

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

`test/server/` holds the server suite (`pnpm exec vitest run --project server`): real daemons driven as their clients drive them, which the gate runs for a daemon change in place of e2e.

`test/fake-clock.ts` drives time. Agents run on `packages/fake-harness`, never on the real CLIs.
