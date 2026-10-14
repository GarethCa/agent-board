/**
 * Where a session's terminal lives (ADR-0006). v1 has one implementation, the built-in node-pty backend; the
 * interface is the seam for tests and later backends. Terminals are addressed by the id the caller gives at spawn,
 * which is the session id.
 */
export interface TerminalBackend {
  /** Starts `command` in a new terminal. Throws if it cannot be started or the id is taken. */
  spawn(options: TerminalSpawnOptions): TerminalInfo;
  write(id: string, data: string): void;
  resize(id: string, cols: number, rows: number): void;
  /** Signals the process (SIGHUP by default, which also ends an interactive shell). Its exit arrives via `attach`. */
  kill(id: string, signal?: NodeJS.Signals): void;
  /** Flow control: stops reading the terminal's output until `resume`, so the process blocks on a full PTY. */
  pause(id: string): void;
  resume(id: string): void;
  /** Streams the terminal's output and, once, its exit. Returns the detach function. */
  attach(id: string, listener: TerminalListener): () => void;
  /** Terminals whose process has not exited yet. */
  list(): TerminalInfo[];
}

export interface TerminalSpawnOptions {
  id: string;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
}

export interface TerminalInfo {
  id: string;
  pid: number;
}

export interface TerminalExit {
  exitCode: number;
  /** The signal that ended the process, if one did. */
  signal?: number;
}

export interface TerminalListener {
  onData(data: string): void;
  onExit(exit: TerminalExit): void;
}
