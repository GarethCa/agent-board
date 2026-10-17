---
status: accepted
---
# Terminal backends: built-in PTY only

A session's terminal sits behind a `TerminalBackend` interface (spawn, write, resize, kill, attach output, list). v1 ships one implementation, the built-in `node-pty` backend. We keep the interface because it is a cheap seam for tests and for later backends.

We considered a backend for a terminal multiplexer (open sessions in its workspaces, discover existing ones). The maintainer decided against it: a multiplexer is a way of running sessions, not part of the product. The board still sees sessions started elsewhere through opt-in global hooks and `.agent-board/status.json` (ADR-0004), not through a backend.
