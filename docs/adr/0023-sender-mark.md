---
status: accepted
---
# A message another agent sent is headed with a sender mark

The board types at an agent's prompt for other agents: an orchestrator's `send`, an answer to a message, flag or question, and an edge's hand-off. The harness records each as a user turn, the same as one the user typed, so the chat view showed another agent's words as the user's own. The chat must tell them apart, and say who sent each.

## Decision

Every message the board types for another agent is headed with a **sender mark**, on its first line: `⟨send from Captain · agent:944e1234⟩ Fix the login test` (`markSender`, `packages/daemon/src/sender-marker.ts`). It names the kind (`send`, `reply`, `hand-off`), the sender's name and its ref. The transcript adapters read it back (`readSender`) into the user entry's `from` (`MessageSender`), for both harnesses, and drop the mark from its text; a hand-off's payload is read from its head (`Hand-off from impl (its plan.md):`) as `from.payload`. The head, and a send's closing line on who it is from (`[agent-board] From …`), stay in the entry's text: they are the only cue a chat that doesn't yet draw `from` gives, and the chat hides them under its sender badge once it does. The receiver reads all of it.

- **A send** from an agent is `send`; one that answers a message from the receiver (a reply path, ADR-0011), or the flag or question of the crew member it started, is `reply`. The user's own sends, from the app or a shell with no agent, carry no mark.
- **A hand-off** along an edge, explicit or inferred, is `hand-off`, the mark before its head.
- **The send result says what was typed** (`OrchestratorSent.typed`), and `agent-board send` prints it, so the sender knows what the receiver reads.
- The time is the transcript entry's own (`at`).

## Why a mark, and not a record matched to the transcript

The other way was to keep, per receiver, who sent what and when, and match each record to the transcript's user entry by its text and a time window. We chose the mark:

- **It travels with the message.** A transcript read after a daemon restart, or one the daemon never saw written, still says who sent each message; a record would need its own table, and to outlive every restart, to do the same.
- **The same text sent twice needs nothing more.** Each copy carries its own mark; matching records by text must also match them by order and time, and guess when a harness took a message much later than it was typed (a message waiting for a turn's end, a woken agent).
- **The text the harness records is not always the text typed.** A hand-off is joined onto one line and stripped of control characters; a harness may trim or wrap what it keeps. A mark only needs its own first line to survive.

What it costs: the receiver reads a mark it didn't before, and a user who types a mark at an agent's prompt themselves is shown as that sender in their own chat. And two messages queued in one turn can reach the harness as one message, so one transcript entry: it says only its first sender, and a later message's mark stays in its text (a message of the user's that went up behind an agent's shows as that agent's). The chat may split such an entry where a later line starts with a mark. All are acceptable for now: the mark tells the receiving agent who wrote to it, which it was mostly told already; what the user types at their own agent is theirs to label; and messages merge only when sent within one turn, which the chat can still tell apart by the marks in the text.

## Why at the start

On the first line, not as a line of its own or a closing line:

- **A short message is still typed as one line.** A mark on a line of its own would make every message multi-line, so every one would be pasted; on the same line, only a long or multi-line message is pasted, as before, and a hand-off stays one line.
- **A closing mark could be lost to the text it follows**: a send's closing line, or a message that ends quoting a mark of its own.
- **A pasted message keeps its start.** Messages are pasted with bracketed paste, so the harness keeps the start of a long one, in order, whether it goes as one paste or several. Claude wraps one it folds in `<pasted_content>`; a message that starts with such a block is read as if unwrapped, so its mark still counts and the agent's text has no wrapper left. Two limits follow: a message the user pasted by hand from an agent, with words of their own typed after it, shows as all that agent's, and a marked message quoting a whole wrapper shows it unwrapped. Neither can be told apart from a message Claude folded. A message whose start was lost would show as the user's, the same as before this mark.

The brackets are U+27E8 and U+27E9: no harness reads them as markup (Claude's own `<command-name>` and the like start with `<`), nothing typed strips them, and a mark can't start a `/` or `!` command. A name in a mark has them, line breaks and control characters replaced by spaces, so no name ends the mark early; only a mark at the very start of a message (or of the block that starts it) counts, so one quoted inside a message is text.

## A clock's run, and the board's own notices

The board types at an agent's prompt for no agent too, and the chat drew those as the user's: a clock's run, a ticket's news of its pull request, a ticket's hand-over between its chat and its builder, and every `[agent-board] …` notice (steps, documents, asks, a crew member's flag, an undelivered message).

- **A clock's run** is marked `⟨clock from Master check-in · item:c0ffee12-…⟩` (`markClock`): kind `clock`, the clock's ref (`item:` and its id), and a name from its prompt's first line, cut to 32 characters, as a clock has no name of its own. A `clock` mark is read only with an `item:` ref, and the agent kinds only with an `agent:` ref; any other pairing is text. Its wake, when the clock wakes a hibernated agent, types the same marked prompt, and a fresh agent a clock starts for its run gets it as its first prompt: a timer types it with nobody there, unlike an orchestrator's first prompt (below).
- **A clock's prompt that is a command** (it starts with `/` or `!`) **is not marked.** It is the user's own words, set to run as that command; a mark first would turn it into text that only names the command. Its run shows in the chat as typed, as the user's.
- **The board's notices** keep their `[agent-board]` lead (and the space after it), which already says whose they are, and gain no mark. Some relay the user's own words (a comment on a document, an edit the user kept, a plan's decision and its note, a Go on note), and those are shown as the board's too: each says it is the user's ("The user commented on …"), and the board typed it at the agent, not the user. The rest: `readSender` reads a message that starts with the lead as `{ kind: 'board', name: 'agent-board', ref: 'board' }`, dropping the lead from its text. A ticket's pull-request news and its hand-over now start with the lead too.
- **In the chat** both are drawn as an agent's message is, apart from the user's: in a neutral grey, the kind's icon (a clock, the board) in place of a character, headed `Clock · <name>` or `agent-board`, with the pill `Scheduled run` or `Notice`.

What it costs: a user who starts a message with the lead themselves is shown as the board in their own chat, as one who types a mark is shown as its sender (above). A name can't start with it (`params.ts`), so no agent's name brings it to the start of a line.

## Not marked

- An orchestrator's first prompt to an agent it starts (`orchestrator.spawn`): the agent's prompt, not a message to it. A crew's member started for the work it is handed is different: the work in its first prompt is another agent's words, and so is the crew's prompt when an agent started the crew, so they are marked (below).
- A crew member's flag told to its orchestrator (`[agent-board] … needs you`) and the board's own notices (`[agent-board] …`): they are the board's, already headed so, and read as the board's by that lead (above).

## The board's line inside a crew's delivery

A running crew's delivery (ADR-0011) goes under the sender's mark, as a hand-off does: the member, or a loop gate's decider, whose work it is. When the crew went on without an input, or delivers one late, the board adds one line of its own before the sender's text, inside that delivery: `<names> hasn't reported yet, so this goes on without it after 30 min.`, `Late: <name> reported after <member> went on without it.`, or a loop gate at its limit. A join that delivers several inputs at once heads each with its sender's name (`code (round 1)'s review: …`) under the mark of its first source in the prefab's order; a loop gate's words go under its first decider that asked for changes, or its first decider when none did. These are not marked as the board's (`[agent-board]`) or as another sender: the line is plain words about what is missing or late, it names no instruction, and its one sender's mark still says whose work the rest is, so a receiver reads the sender's text under its sender as before. A separate board notice would type a second message and split the one delivery the join exists to make.

The user's Go on note at Your OK is different: it is the user's words, not the sender's, and it can say what to do. So it never goes inside the sender's mark. It is the board's own notice (`[agent-board] The user let the work of <member> go on from Your OK, and says: …`): in a new agent's first prompt, or typed at a running agent's prompt as its own message before the work, which then comes under its sender's mark as any hand-off does (ADR-0011).

### The work in a new member's first prompt

A member the crew starts for the work it is handed (`spawnFor`, `crew-loop.ts`) gets a first prompt of its brief, the crew's prompt, the work, then the user's note if there is one. The work in it is typed as a delivery types it, under its sender's mark and head, on one line (`⟨hand-off from impl · agent:944e1234⟩ Hand-off from impl (its final message): …`, `handOffMessage`, which `deliveries.ts` types too), the board's lines of a join or a late input inside it as above; work that is nothing once on one line is left out, as a delivery sends none. So no line of the work can start as the board's: a sender's text holding a line like the user's note (`[agent-board] The user let the work of impl go on from Your OK, and says: …`) can't start a line, and reads as the sender's. The brief (the prefab's) is not marked or cleaned: as an orchestrator's first prompt (above), it is the agent's prompt.

The crew's prompt is its starter's words, and any agent may start a crew. So when an agent started it, it is typed as that agent's send, on one line under its mark (`⟨send from lead · agent:944e1234⟩ Add a footer …`, `sentLine` in `handoff-text.ts`): a line of it like the user's note can't start a line, and reads as the starter's. One that is nothing once on one line (blank, or only control characters) is left out, as empty work is. We chose the mark over escaping its leading `[agent-board]` lines for the reasons below, and so it reads as the work under it does. What it costs: an agent's crew prompt loses its line breaks. A crew the user started has its prompt as they wrote it, unmarked, as the user's own sends are.

The mark heads a line inside the first prompt, never the prompt itself: one that started with the mark would be read back (`readSender`) as all the sender's, the user's note after the work included. So when nothing unmarked comes first (no brief, and no crew prompt or one an agent wrote), a plain line comes first: `Your crew starts you with this prompt.` before an agent's crew prompt, else `Your crew hands you this work.` before the work. The mark tells the new agent whose words the work is, as a running member is told.

We chose the mark over escaping a leading `[agent-board]` in a member's text: it is what a running member reads for the same work, so the two read alike; it names the sender, which an escape doesn't; and an escape would have to find every line that starts like the board's, where joining onto one line leaves no line to find. What it costs: the work loses its line breaks (a plan or a review on one line), as a running member's delivery already does.
