// The environment every session the daemon starts gets, so the `agent-board` CLI and MCP in it know where they are
// (ADR-0010), as cmux hands its terminals CMUX_WORKSPACE_ID. Kept free of imports: the CLI starts often.

/** The daemon's socket, which the CLI talks to. */
export const BOARD_SOCKET_ENV = 'AGENT_BOARD_SOCKET';

/** The session the CLI runs in (set by `sessionEnv`). */
export const BOARD_SESSION_ENV = 'AGENT_BOARD_SESSION_ID';

/** The zone the session's tile was in when it started. A hint only: the tile may have moved since. */
export const BOARD_ZONE_ENV = 'AGENT_BOARD_ZONE_ID';

/**
 * The session's board token: says which session a CLI or MCP call comes from. Unlike the hook token it can't post
 * hook events, so the model's shell may see it. Its name has no KEY, SECRET or TOKEN in it: Codex keeps vars named
 * like those from the model's shell commands by default.
 */
export const BOARD_TOKEN_ENV = 'AGENT_BOARD_IDENTITY';

/** Points the CLI at another data dir's daemon when it runs outside a session. */
export const BOARD_DATA_DIR_ENV = 'AGENT_BOARD_DATA_DIR';
