---
status: accepted
---
# An agent's work sits in one of seven work categories, set by the agent or guessed by the board

With many projects running at once, the user needs to see at a glance where each piece of work stands: what is on them, what is stuck, what waits on other people, and what goes on without them. An agent's **human status** (Needs you, Problem, Working, Done, Paused, Scheduled) says what the agent is doing at its prompt, not where its work is. An agent waiting three days on a supplier's reply looks Done from its prompt, the same as one whose pull request merged. Only the agent knows the first, so the agent must be able to say it.

## Decision

Every agent's work is in one **work category**, read by the overview. There are seven, ordered by who acts next, each in one of four groups:

| Group | Categories |
|---|---|
| On you | Needs help (`needs-help`), Ready for review (`ready-for-review`) |
| Stuck | Blocked (`blocked`) |
| On others | Waiting on others (`waiting-on-others`), In review (`in-review`) |
| On its own | Working (`working`), Done (`done`) |

`WORK_CATEGORIES` (`protocol.ts`) lists them in order; `work-category.ts` gives their groups and names, and the board's guess.

### What an agent sets

The agent sets its own with `board.setStatus`, beside its line and its pose: `agent-board status set --category waiting-on-others --label "With Legal" --on "Northwind Pay support · #48213"`, or the MCP's `set_status` with `category`, `label` and `waiting_on { who, ref }`. An orchestrator sets one for an agent in its crew, as it sets the crew member's line (`orchestrator.setStatus`), and the category names it.

- **A label** of the agent's own, at most 40 characters, is shown in place of the category's name. The colour, group and place stay the category's: a label always lands in one of the four groups.
- **Who it waits on** (`waitingOn`), at most 80 characters, with a reference of theirs (a ticket, a PR), only for the two that wait on others.
- **A set replaces all of it**, and stays until the agent sets another or `none`, across restarts. The board stamps when it was set.
- **`done: true`** with no category is Done, and so is a hand-off (`board.handoff`), over whatever it set: both say its work is finished. A Done goes with the agent's next prompt, as its work's finish does (`workFinishedAt`): new work is not done. Any other category stays through its prompts.

`Agent.workCategory` holds only what was set, in `agents.work_category` and the columns beside it; null when none is.

### What the board guesses, and who wins

The overview reads each agent through `workCategory(agent, { shows, reviewers })`, which says the category, its label, whether the agent set it or the board guessed (`source`), why the board guessed it, who it waits on, and since when. In this order:

1. **Needs help**, over anything the agent set, while something waits on the user now: whatever the needs-you inbox holds for the user (a permission prompt, a question, a plan, steps or a to-do, a flag), a restart that stopped it, or last words at its prompt that ask. A finished turn the inbox lists is not, nor a crew member's question, which its orchestrator takes.
2. **How its session ended**, which the agent can no longer change: Blocked when it failed, else read on as below.
3. **The agent's own category**, while its session lives.
4. Otherwise the board's guess:
   - Working while it runs, paused or is scheduled;
   - Blocked at its usage limit;
   - In review while a reviewer agent of its work runs;
   - Waiting on others, labelled "CI", while its open pull request's checks run, and Blocked while they fail;
   - Ready for review for an open pull request;
   - Working for a draft pull request;
   - Done for a merged pull request, work it said is finished, or a session that ended;
   - Working, with its orchestrator, for a crew member at its prompt; Done for any other agent whose turn ended asking nothing.

   A crew member is read by its pull request and its reviewer like any other agent: its pull request waits on review, whoever does it, and the overview is where the user sees the crew's work too.

## Why one of seven, with a label, and not free groups or free words

A group and a word of the agent's own (two inputs) would let the agent put "With Legal" in any group. The label on a category is one input, and the category already says the group, the colour and the order. Free words alone could not be grouped or counted at all.

## Why Needs help wins over the agent's own

A permission prompt or a question stops the agent whatever it said its work was waiting on. The user has to act before anything moves, and the overview is where they look for that. What the agent set comes back once the ask is answered.

## Why In review only from a reviewer agent

A pull request's GitHub review requests are not read by the board yet. A reviewer agent the board started on the agent's branch is the one review it can see running. A review requested on GitHub can join the guess when the board reads it.

## Considered options

- **Inferring every category, with nothing set by the agent**: rejected. The board cannot see work that waits on someone outside it, which is what the overview most needs to show.
- **Keeping the guess in the database**: rejected. It is a reading of facts the board already keeps (state, asks, pull requests, reviewers), like the human status, so it is computed where it is shown and never goes stale.
