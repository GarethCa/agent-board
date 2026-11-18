---
status: accepted
---
# Crew branches: makers on branches of their own, merged into the crew's branch, one pull request

A crew prefab may have more than one maker (an implementer or a spike), and a crew with two that worked in one worktree would have them write over each other. Each maker gets a branch of its own instead, and the crew needs one place their work comes together, and one pull request for the user to read. The decision is where that place is, when the makers' work goes into it, and what the crew does when it doesn't go in cleanly.

## The crew branch

- **Two or more makers on branches of their own get one.** A crew with one maker runs as before: the builder's branch is the crew's, and its pull request is the builder's own. With two or more, the crew cuts a **crew branch** from the builder's branch as it starts (`<builder's branch>-crew`, made free in the repo), in a **crew worktree** under the board's worktrees folder that the crew owns, not any agent.
- **Makers start from it.** Each maker after the builder is cut from the crew branch, so it starts from what is merged so far. A non-maker that only one maker's work reaches starts on that maker's branch (it reads, or reviews, that maker's work); any other non-maker starts on the crew branch.
- **Merged where work meets, with a merge commit.** Before the crew routes work to another maker, or to a member that two or more makers' work reaches, it merges the makers whose work reaches it into the crew branch, each `--no-ff`, with a message naming the maker. At an end (ready or done) it merges every maker. A branch already in the crew branch is skipped. Git runs without a shell, on the branch names resolved to commits first, and with the repo's hooks off (`core.hooksPath=/dev/null`, `--no-verify`) for the merges and the push: a hook a maker committed (an in-tree hooks path, as husky's) never runs as the board merges or pushes its work.
- **A ready end opens one draft pull request**, of the crew branch: pushed to origin, never forced, its title the ticket's, or else the crew prefab's name and the crew branch, its body each maker's branch and the ticket. The board opens it with no step from the user, so neither carries the crew's prompt to GitHub. It is recorded on the builder, so the builder's tile and the crew's card show it and the crew's merged stop sees it. A push or a pull request that fails is flagged, for the user to open, and the crew still stops ready.

## When a merge conflicts

- **Aborted, and sent back to its maker.** The merge is aborted (`merge --abort`), so the crew worktree is never left mid-merge, and the maker is told, at its prompt, the files it conflicted in and to merge the crew branch into its own. That counts as a round of the maker's loop gate, as a reviewer's again would. A merge left half-done (the daemon stopped mid-merge) is aborted before the next one, and a crew worktree with changes of its own merges nothing: that is flagged, never blamed on a maker.
- **Only what is committed is merged.** A maker that hands off with changes it didn't commit (the board's own `.agent-board/` files aside) is sent back the same way, told the files and to commit them, before its branch is merged. Each maker is told as it starts that only what it commits is merged.
- **Twice running stops the crew.** A second send-back of a maker in a row, or one at its loop's limit, stops the crew at its round limit (`round-limit`, reused rather than a new stop) with a flag naming the files. `crew round` sends that held send-back as one more try (at its loop's limit, one more round of it). What the other makers handed to the same member, or end, is kept for it. A merge that fails for another reason is flagged, for the user to make by hand.

## Clean-up

- **Only the crew's pull request merging closes the crew,** its crew worktree and branch with it. The builder's own pull request merging stops the crew instead, and says so: the makers' work is on the crew branch, not the builder's, so nothing of it is deleted. Once the crew's pull request is open, the builder's merging changes nothing: the crew waits for its own.
- **A done end, a user's stop or the builder going removes the crew worktree** and keeps its branch (the work is there, with no pull request). Wherever the board deletes a branch it first checks that nothing on it is unsaved (uncommitted, or commits on no remote branch), and a branch with unsaved work is kept and named in a flag, or in the crew's news if the builder is gone.
- **A stop at the round limit keeps both,** for `crew round`. A crew waiting at its round limit, or ready to merge, whose builder goes (seen as the daemon starts) stops as `builder-gone` and removes its crew worktree, keeping a branch with unsaved work.

## Restarts

The crew branch's name and worktree are saved before it is cut, so a daemon stopped mid-cut finds them again: a branch already cut is checked out where it was placed, and a worktree already there is checked to be on it. A cut that fails fails the start, flagged, and is tried again only at `crew round`. A ready end that runs again finds the crew branch's open pull request rather than opening a second.

## Considered options

- **The makers in one worktree, each writing only paths of its own.** Kept for non-makers (a non-maker sharing the crew worktree writes only its `writes` paths), but not for makers, whose work is open-ended. Such non-makers run beside makers too: a maker's merge into the crew worktree waits until no one there is mid-turn and the files it changes are committed, and asks the user once the wait runs out.
- **A pull request per maker.** Rejected: the user reviews one change, and the makers' pull requests would conflict with each other at merge.
- **Merging only at the end.** Rejected: a maker started after another, or a reviewer of both, must see both makers' work, and conflicts found late cost a whole round.
- **Rebasing makers' branches onto the crew branch.** Rejected: it rewrites a branch an agent is working on, and needs a force-push.
