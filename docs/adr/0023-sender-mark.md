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
- **A pasted message keeps its start.** Messages are pasted whole with bracketed paste, so the harness keeps the start of a long one. A message whose start was lost would show as the user's, the same as before this mark.

The brackets are U+27E8 and U+27E9: no harness reads them as markup (Claude's own `<command-name>` and the like start with `<`), nothing typed strips them, and a mark can't start a `/` or `!` command. A name in a mark has them, line breaks and control characters replaced by spaces, so no name ends the mark early; only a mark at the very start of a message counts, so one quoted inside a message is text.

## Not marked

- An orchestrator's first prompt to an agent it starts (`orchestrator.spawn`): the agent's prompt, not a message to it.
- A crew member's flag told to its orchestrator (`[agent-board] … needs you`) and the board's own notices (`[agent-board] …`): they are the board's, already headed so.
