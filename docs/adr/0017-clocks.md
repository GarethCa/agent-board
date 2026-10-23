---
status: accepted
---
# Schedules are clocks on the board

A schedule used to be a row per agent (`schedules`, keyed by its session), shown only as a chip on the agent's tile and made from the tile's ⋯ Schedule…. The user wanted a schedule to be an object on the board, joined to an agent, that can also start a fresh agent for a task, wait for it to finish and close it. Two ways in were decided, for now, with either to be dropped later as a small change: every schedule is a clock item, and the tile's Schedule… stays and makes the clock beside its tile.

## A clock is a board item

- **The schedule is the item's data** (`ClockData`): its cron, whether it is on, what it does (`message` the agent it is joined to, or start a `fresh` agent), the prompt (what it sends, or a fresh agent's task), a fresh agent's harness, model, role and whether it closes once done, where a fresh agent's result goes, and whether it is drawn folded. So a clock moves with its zone, copies, undoes and deletes as every item does, and nothing else holds a schedule. The item store checks the data (`items.ts`), the cron included.
- **What it is doing is not item data.** When it next fires and its runs (`ClockStatus`) change as time passes, not as the user edits: a clock firing would otherwise write its item, and undo would send stale data back. Runs are rows of `clock_runs`, keyed by the clock's id with no foreign key, so a clock's history comes back when its delete is undone. Clients hear `clock.updated`, and `clock.list` gives them all.
- **The scheduler (`schedules.ts`) keeps its loop** (the plan, the timer at most a minute away, one late fire for times slept through, following clock and time-zone changes), now keyed by clock. It plans only a clock that can fire: on, with a prompt, and joined to an agent (`message`) or in a zone (`fresh`). It replans a clock whenever its item is made, changed or deleted; one still planned on the same cron keeps its fire time, so a drag or a fold as it falls due loses no fire. A clock whose last run is still going skips, saying so.
- **An agent's schedule is derived** (`Agent.schedule`): the clock that messages it, the soonest of several. So the `scheduled` state, the tile's clock chip, an agent never being stopped by restart while it has one, and the daemon staying up for one all work as before. `agent.setSchedule` stays, as a façade over that clock: it makes one beside the tile, changes it, or deletes it.
- **Existing schedules moved over** in the migration that made `clock_runs`: one clock each, joined to its agent, 60 px left of its tile in its zone (on its right when there is no room in the zone; a tile loose on the board always has room), as the tile's Schedule… places one, its runs with it.
- **Deleting an agent leaves its clocks**, unjoined: the clock says it is not set until it is joined to another agent. A schedule used to go with its agent; a board object going because something else did would surprise.

## A fresh agent's run

- **It starts as the user's agent** (no `spawnedBy`), unless an orchestrator made the clock (below), in the clock's zone, under the clock and clear of the tiles there, named from its task and the run's number (`Deps check #12`), with its harness, model and role. A clock starts none while three it started are still on the board, so kept agents don't pile up.
- **Its run ends when its first turn ends** (its `Stop`), the same moment Ask Claude's answer lands, unless its last message asks the user something (its last paragraph has a question mark, the rule that makes a scheduled agent `waiting`): then it stays open and shows `waiting`, as a scheduled agent that asks does (in the needs-you inbox when that shows every turn), and the run goes on until a turn ends that doesn't ask. Its state alone can't say so as the turn ends: Claude's `Stop` leaves it `idle`. `Agent.workFinishedAt` was not used: an agent sets it only by handing off or saying it is done, which a plain task never asks for.
- **Its result** is its final message, kept in the run's row. A per-clock setting also leaves it as an agent note where the agent's tile was, or hands it to another agent as a hand-off would (`agents.deliver`), before the agent is closed.
- **Closing it never throws work away.** It is deleted as `agent.delete` without force does; if that is refused for unsaved work, it is stopped instead and the run says it was kept.
- **A run fails** when its agent fails, ends, or is removed before its turn does, or can't be started.
- **A run the app stopped during** says so (`the app stopped during its run`), not that its agent failed, once the app is back; its agent, stopped by the restart, is then closed as the clock says, as at the end of a run. One whose agent was still being made says the app stopped as it started; an agent made in that moment is left on the board, not matched to its run.

## Orchestrators

`agent-board schedule add|list|remove` and the MCP's `add_schedule`, `list_schedules` and `remove_schedule` reach `orchestrator.addClock` and `orchestrator.removeClock`, logged as `add-clock` and `remove-clock`. The agent a clock messages, a fresh agent's zone and a hand-off's agent must each be in the caller's scope; a clock is marked as made by its caller, and only its crew (or the user's side) removes it. A fresh agent an orchestrator's clock starts is in its crew (`spawnedBy` the orchestrator), so it is no shallower in the crew than one the orchestrator starts itself, and `MAX_CREW_DEPTH` holds: a clock can't give an orchestrator at the limit agents that orchestrate. Once that orchestrator is deleted its clock starts none (each fire time is skipped, saying why), while the user's clocks start the user's agents.

## Considered options

- **The schedule in a `clocks` table, with an item pointing at it**: rejected. Two records to keep in step, and copy, undo and zone moves would each need to carry the table row along.
- **Runs in the item's data**: rejected, for the undo and broadcast reasons above, and items' 64 KB cap.
- **A drawn edge from the clock as the join**: deferred. Flow edges join agents only, and a connector is a drawing. The clock's own data names its agent, the editor picks it, and a dashed tether shows it, as an agent note's does.
