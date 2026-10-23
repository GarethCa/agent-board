---
status: accepted
---
# A document is the agent's file, read live, and the user's edits write it and are told to the agent

An agent often has more to show than its terminal reads well: a design, a findings report, a release plan. It can now show the user a Markdown or HTML file of its as a **document** (`show_doc` in the board MCP, `agent-board doc <path>`): a Document tab in its window, and if it asks, a card beside its tile. The user can edit a Markdown document, and the agent should learn what changed. The decisions are what the document is, how it stays live, what an edit does, and how plans fit in.

## The file is the document

- **Nothing is copied.** A document is a row per file per agent (`documents`: its path, format, title, version, who wrote it last and when, and the SHA-256 of the text last seen). Its text is read from the file each time it is shown (`doc.read`), so the board never holds a stale copy. Showing the same file again shows the same document, as the one the agent showed last.
- **Markdown or HTML, by extension** (`.md`, `.markdown`, `.html`, `.htm`), at most `MAX_PLAN_LENGTH` characters, as a plan. The path is absolute on the wire; the MCP server and the CLI resolve a relative one from the agent's folder, as `present_plan` does a plan's `path`.
- **A link is shown as the file it leads to.** The path is resolved to its real path as the document is shown, and that is what is kept, checked for its extension, and shown in the tab. A link named `notes.md` leading to `config.conf` is refused, and one leading out of the worktree shows where it leads.
- **The title** is the one the agent gave, else the first heading (an HTML page's `<title>`), else the file's name, and follows the file as it is rewritten until the agent names it.
- **It goes with its agent**, as plans do: its rows cascade, and its cards are deleted as the agent is.

## It stays live by looking, not by watching

- **A poll every 1.5 s** (`DOCUMENT_POLL_MS`) stats the files of live agents' documents, and reads one when its modified time or size moved, or when it was modified in the last 2 s (a write within the file system's time tick keeps its time). A new hash is the agent's next version; the same text (a touch, or the user's own save) is none. `fs.watch` was not used: editors and agents replace files by rename, which a watch on the old inode misses, and a directory watch per document is more to keep than a stat.
- **Showing, reading and saving read the file and compare its hash first**, whatever its stat says, so a rewrite the poll hasn't seen yet, or one that kept its modified time (`cp -p`, `rsync -t`, a coarse-clock file system), is still counted before anything is shown or written.
- **An agent that ended** isn't polled: its file may change under a later agent, but the document is its history. Reading it still shows the file as it is.

## An edit writes the file, and the agent is told

- **The user's save writes the file** (`doc.save`), as the user decided: the agent has nothing to apply, and a later `cat` of the file is the truth. It is written whole, through a file beside it renamed over it, keeping its mode, so a reader never sees half of it, and in the file's own line breaks: the Document tab edits with `\n`, and a file of `\r\n` is written back so, its diff only the lines the user changed.
- **What a save refuses.** An HTML document, and a Markdown one outside its agent's worktree (`editable` false: shown read only, as edited there). A file gone since it was shown: it is never made again. A file made a link since it was shown, which would be written through to wherever it now leads. And a Markdown one written since the version the user began editing, by the agent or by an earlier save of theirs.
- **Only Keep mine writes over the agent's newer version** (`force`). Once the Document tab knows of the rewrite it shows the banner; Save is disabled and ⌘S moves to Keep mine, so writing over the agent is always the user's choice. The agent is then told `The user kept their version of <path> over your vN …, which undoes your changes since vB`, with the diff from its version to the user's.
- **The agent is told the diff** (`text-diff.ts`, a line diff with a line of context, each line led by a minus or a plus), headed `[agent-board] The user edited <path> (vN). The file is already changed; you don't need to apply this:`. A diff past 6,000 characters is cut, saying to read the file. The path is relative to the agent's worktree when inside it.
- **Typed as a crew flag is** (ADR-0016): only once the agent is at its prompt (`idle` or `waiting`), through the deliveries' queue (`AgentHost.tell`), never into a turn, a question or the user's half-typed line. Refused, it stays pending in memory and is tried again at the agent's next update; several saves and comments waiting go as one message. A daemon restart drops what was still pending: the file itself still says what changed.
- **This types into the agent's terminal for the user**, which the app otherwise leaves to the harness. The user asked for it here: the edit is theirs, made in the app, and the message only says what they did, as a hand-off does for another agent. Nothing is typed that the user didn't cause.
- **HTML is view-only**, drawn exactly as an HTML plan is (ADR-0014: its own locked-down view and partition, served from memory, offline, going nowhere). The user's comments on it go to the agent as an edit's diff does (`doc.comment`). Quoting a selection of the page in a comment is left for later: the page's view has no preload, and reaching into it from the main process would widen what the view may do.
- **Only the user edits.** `doc.read`, `doc.save` and `doc.comment` are not in `BOARD_CALLER_METHODS` (ADR-0010): no board token reaches them. `board.showDoc` is, and acts only for the live agent holding the token, from its own session, as `board.presentPlan` does. A document's file is the agent's to name, and the app only reads what it names: any `.md` or `.html` file the user can read. Writing is narrower: only a real file inside the agent's worktree, never through a link, since a sandboxed agent (Codex in `workspace-write`, Claude with its sandbox on) can make a link inside its worktree to a file it can't write itself, and the user's save must not write that file for it.

## On the board, a card that is a board item

- **A document card is a board item** (`document`), not drawn from the document as a question card is (ADR-0014): the user moves it, collapses it to a slim bar, and takes it off the board, and it survives a restart with the board. Its data is the document's id and its agent as they were then (name, harness, role), so it still says whose it was; what it shows of the document (version, "you edited", the first lines) is read from the agent's documents as they are now.
- **It is put beside its agent's tile**, to its right or the nearest spot clear of what is there (`spotBesideAgent`), and tied to it by the agent note's dashed tether. One card per document: showing it on the board again adds none.
- **Taking it off the board leaves the document**, a tab of its agent and counted on its tile.

## Plans are documents with a decision

- **`show_doc` with `plan`** reads the file and presents it as `present_plan` does, waiting for the decision; `present_plan` stays as it was, so either works. A plan keeps its own versioned store and its held call (ADR-0014): a plan's body is the version decided on, kept even once the file moves on, which a live document can't be.
- **The Plan tab reads as a document** with its type tag (PLAN) beside its title and the decision bar under it.

## Considered options

- **Only sending the diff, for the agent to apply.** Rejected by the user: the file would disagree with what the user sees until the agent acts, and an agent mid-turn might never apply it.
- **Storing each version's text**, as plans do. Rejected for documents: the file is the agent's working copy and changes often; a copy per write would grow without bound, and git already keeps what matters. A plan keeps its body because its decision is about that text.
- **A document card drawn from the document, like a question card.** Rejected: a card the user placed and collapsed should stay where they left it across restarts, which a board item already does, with undo, selection and zones.
- **Folding plans into the documents table.** Deferred: a plan given inline has no file, and its held call and versions are already settled (ADR-0014). The fold is in the tool and the tab. The rest (a plan from a file as a document with a decision, its card on the board, and editing it before approving it, "approved, with your edits") is a follow-up of its own.
