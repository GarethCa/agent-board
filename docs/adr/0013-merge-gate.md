---
status: accepted
---
# The merge gate runs a zone's command, its steps marked in its output, and only on the user's click

The merge gate lets the app run a repo's own check (`pnpm check:local` here) in an agent's worktree, then open a pull request and merge it. A gate command is arbitrary, and it runs code from the agent's branch. The decisions are about how the app runs it, how it knows its steps, and what may start it.

## Only the user starts it

- **No automatic run or merge.** `gate.run`, `gate.stop`, `gate.openPullRequest` and `gate.merge` are not in `BOARD_CALLER_METHODS` (ADR-0010), so no agent, orchestrator or board token can call them; a test pins this. The app calls them only from a click or ⌘⇧G. Nothing runs the gate when a turn ends, a commit lands or a pull request changes.
- **An agent may open its own pull request, as a draft (G38).** `board.openPullRequest { token }` (`agent-board open-pr`) opens a pull request of the token's agent's own branch by the code the header's Open PR button used before it was removed, with the same checks (nothing uncommitted; in a zone with a gate, the gate passed on its head), always with `--draft`. A draft can't be merged until someone marks it ready, so running the gate, marking it ready and merging stay the user's. Only the agent's own session may: a shell's token (a tab's, or an ended agent's shell's, too) is the user's side, which no longer has an Open PR button.
- **The daemon checks again.** `gate.openPullRequest` refuses with anything uncommitted, from a worktree not on its own branch, and, in a zone with a gate command, unless the latest run passed on the worktree's head; it pushes that commit (`<head>:refs/heads/<branch>`), never forced, then sets the branch's upstream to it. `gate.merge` re-reads the pull request with gh and refuses unless GitHub's checks are green, GitHub would merge it, and, in a zone with a gate command, the run passed on its head (`gate-rules.ts`, which the app also uses to say why a button is disabled). It merges with `--match-head-commit` at the commit the user saw.
- **A zone with no gate command** still has Merge (a master decision on BM3's "always visible"; the header's Open PR button was later removed, as agents open their own pull requests): Merge then waits for GitHub's checks alone, and its popover says the zone has no gate.
- **The PR tab goes round it only when the user says so (G41).** `pullRequest.details` names the agent (`gatedBy`) whose pull request it is when that agent's zone has a gate command, and, while that agent's gate hasn't passed on the pull request's head, why (`gateBlocked`, from `mergeGateBlocked`). `pullRequest.merge` refuses such a pull request unless `pastGate`: the PR tab then says why beside Merge, and its confirmation says plainly that the gate hasn't passed on the head, with a **Merge past the gate** button. Once the gate passed on the head, the PR tab merges it as any other. Before the governance review the PR tab never merged a gated pull request: it was merged only from the agent's header. The governance review loosened that, since the user can merge on GitHub anyway; the confirmation keeps it from happening by a slip. Approving and merging stay the user's clicks. It fails closed (`gatedOwner`): an agent owns a pull request it has read, or one whose head is its branch in the same repo, and, while its pull requests haven't been read since the daemon started, any in its repo.

## Merging never loses unmerged work

After a merge the popover's clean-up may close the agent, remove its worktree, delete its branch (here, then on GitHub) and comment on its issue. The agent may have gone on after its pull request was opened, and a squash merge leaves the branch's commits on no other ref, so the usual "unsaved work" check (commits no other branch has) would refuse every clean-up, and skipping it would destroy new work. So the worktree and branch go only while the worktree is still exactly at the merged commit, on its branch, with nothing uncommitted (the agent's `.agent-board/` notes aside: they go with it); otherwise both are kept, and the step says why. The branch is deleted on GitHub last, and only once it has gone here. Closing the agent alone never touches its worktree.

## Trust: the gate runs the branch's own code

The gate is the agent's work being checked, and it runs that work: the command resolves `pnpm check:local` (or a script) from the agent's worktree, so its `package.json` and scripts are the branch's, and an agent can change its own gate so that it passes. It runs as the user, outside any sandbox the agent's harness has, on the user's click. A pass therefore says the branch's checks passed, not that they are the repo's checks; a reviewer should read changes to the gate's own scripts in the pull request. Running the zone checkout's copy of the scripts against the worktree is left for later.

Nothing it does may bring the daemon down. Its output is split into lines and written through capped streams (10 MB per log, then a line saying it stopped); a `log=` it names is read only if it is a regular file outside the gate's own logs, in bounded chunks, every read guarded; and when its agent is deleted mid-run, its logs go only once its process has closed. A run whose worktree changed while it ran (a new commit, or anything uncommitted at its end) ends `dirty`, and counts as a pass on no commit.

## It runs through `sh -c`

The command is the zone's setting, typed by the user, but nothing else is ever put into it: no branch, path or agent name. It runs as `/bin/sh -c <command>` (`gateCommandArgv`) in the agent's working directory, so `&&`, pipes, redirects and `$VAR` work as in a terminal. Before the governance review it was split into words and spawned with no shell, refusing `&&`, `|`, `;`, `>`, `$`, backticks and globs; the governance review dropped that, since the text is the user's own and an agent can't set it (`zone.configure` is refused to every board token). The process runs in a process group of its own, and Stop (or the daemon shutting down) signals the whole group, the shell and all it started, as an edge's gate condition does (`stopGroup`). Its output is capped as before. It gets the daemon's environment less what only the daemon wants, without `GIT_DIR` or `GIT_WORK_TREE`, and with `AGENT_BOARD_GATE=1`.

## Steps are marked in its output

The app can't know a command's steps, so the command says. A line of its output that is exactly one of these is a marker. Any other line, including a marker it can't read, is output:

```text
::gate steps <name> <name>…          the steps it will run, in order, all waiting
::gate start <name> [log=<abs path>] a step starts; its output may go to a file it names
::gate end <name> pass|fail          a step ends
```

A name is letters, digits, `.`, `:`, `_` and `-`. A step not declared joins the table at its end. A line of output belongs to the one step running, or to no step when none or several are. A step's `log=` file is followed into its own log as it grows and read once more as it ends. A command that prints no markers is one step named after itself. The run passes only when the command exits 0 and no step failed.

The markers follow GitHub Actions' workflow-command style (`::group::`), which developers will recognise, but they use their own prefix so a script shared with CI can't confuse the two. This repo's `check:local` prints them when `AGENT_BOARD_GATE` is set, each step's `log=` its own log file; `check:pr` doesn't yet, so as a gate it is one step.

## What is kept

The latest run of each agent is a row of `gate_runs` (migration 0041, as JSON, deleted with its agent). Its logs are files under the data dir, at `gates/<agent>/<commit>/` (`output.log`, and `steps/<n>.log` by the step's place, since a step's name may be `..`). A run on the same commit replaces them. A run the daemon was running when it went away is `stopped` when the next daemon starts.
