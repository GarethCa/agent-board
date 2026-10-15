---
status: accepted
---
# Terminal backends: built-in PTY only; cmux is a dev tool, not a product feature

A session's terminal sits behind a `TerminalBackend` interface (spawn, write, resize, kill, attach output, list). v1 ships one implementation, the built-in `node-pty` backend. We keep the interface because it is a cheap seam for tests and for later backends.

We considered a cmux backend (open sessions in cmux workspaces, discover existing cmux workspaces). The maintainer decided against it: cmux is only the harness the master session uses to run worker sessions while building agent-board. The board still sees those workers through opt-in global hooks and `.agent-board/status.json` (ADR-0004), not through cmux.
