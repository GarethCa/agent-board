---
status: accepted
---
# Edge conditions run only approved commands, and held payloads can be kept as paths

A flow edge's **gate green** and **custom script** conditions run a command in the `from` agent's worktree, under the daemon, as the user. That agent writes the worktree: an agent whose Bash is gated could get code run without a permission prompt by editing what the gate calls (a `package.json` script, the shell script it runs). And a hand-off an edge **holds** until its conditions pass, or **queues** until its `to` agent's turn ends, keeps the file it carries (up to 64 KB, whatever the agent wrote, secrets included) in SQLite meanwhile. The maintainer decided both (review finding 9).

## Commands run only once approved, and again once they change

- When a gate or script condition is added, the Edge rules panel shows exactly what it will run and asks for one approval ("Run this command?"). Nothing runs before it.
- What is shown, and approved, is the command's **plan** (`flow-approvals.ts`): the command; the `package.json` script it names (`pnpm check:local`, `npm run x`, `npm test`, `yarn x`, `bun run x`), as the worktree has it now; and each file inside the worktree that the command or that script names by a relative path (`scripts/check-local.sh`), by its SHA-256. The edge stores the plan's fingerprint (a SHA-256 of what was shown) per command, in `flow_edges.approvals`.
- The condition checker works out the plan again before every run. If its fingerprint differs from the approved one, the command isn't run: the condition fails with "changed since you approved it: waiting for your approval", the hand-off stays **held**, and the panel shows Approve again. The check sits in the checker, in front of the shell, so no path to a run skips it (a hand-off, the recheck timer, the PR watcher).
- `flowEdge.approve` takes the fingerprint the panel showed and refuses it if the plan has changed since, so the agent can't swap the script between the dialog and the click. Approvals come only through it, never through `flowEdge.create` or `flowEdge.update`. A command taken off the edge loses its approval, and an edge put back by undo asks again.
- A gate's shared run is keyed by its plan's fingerprint as well as the head commit, so a re-approved gate isn't answered by the verdict of what it ran before.
- Edges made before this have no approvals: their gates and scripts hold until approved.

What is not covered: the plan looks one step deep. What `scripts/check-local.sh` runs in turn (vitest's config, a test file, a dependency's postinstall) isn't hashed. Approving a gate trusts what it calls as the worktree has it, as running `pnpm check:local` by hand would. A command that names no script or file (`test -f ready`) is approved as its text alone. The plan is worked out just before each run, so a change made in the moment between the two runs once, unasked.

## Held payloads: a copy by default, or only the path

- A setting (Settings › Held hand-offs, `settings.heldPayloads` in the daemon's new `settings` table) picks **Keep a copy (default)** or **Path only, read at delivery**.
- With a copy, a held or queued hand-off delivers its file as it was when the agent handed off.
- With only the path, `held_text` and `queued_text` stay NULL, and the file is read again when the hand-off is delivered. A file that has gone or turned invalid by then is skipped, saying why. Changing the setting to path only drops the copies held now.
- A final message isn't a file and is kept anyway (`agents.final_message`), so the setting applies to file payloads.
- A copy is deleted once delivered, skipped or dropped. The panel shows what is held or queued ("Holding plan.md, a copy kept") with a **Drop** button (`flowEdge.drop`), recorded in the edge's history. The daemon opens its database with `PRAGMA secure_delete`, so a deleted copy is overwritten in the file. In WAL mode an old page can linger in the `-wal` file until its next checkpoint.

## Considered options

- **Ask before every run**: rejected. A gate runs on each hand-off and each recheck, and nobody would read the prompt the hundredth time.
- **Hash only the command's text**: rejected. The command is usually `pnpm check:local`, and what it runs is in files the agent can edit.
- **Hash every file the gate could read**: rejected. It's unbounded, and any commit would ask again.
- **Never keep a copy**: rejected as the default. The hand-off B receives would no longer be what A handed off, if A has moved on.
