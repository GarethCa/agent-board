import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { describeBuild, runningSessions, sameBuild, type BuildInfo, type DaemonHealth } from '@agent-board/daemon/protocol';
import { errorMessage } from '../../shared/errors';
import { Button, ErrorText, Tooltip } from './ui';
import { useAction } from './use-action';

export type DaemonStatusValue =
  | { state: 'connecting' }
  | { state: 'connected'; health: DaemonHealth; build: BuildInfo }
  | { state: 'error'; message: string };

/** Asks the daemon how it is once, when the window opens. */
function useDaemonHealth(): DaemonStatusValue {
  const [status, setStatus] = useState<DaemonStatusValue>({ state: 'connecting' });
  useEffect(() => {
    let cancelled = false;
    Promise.all([window.agentBoard.daemonHealth(), window.agentBoard.build()]).then(
      ([health, build]) => !cancelled && setStatus({ state: 'connected', health, build }),
      (error: unknown) => !cancelled && setStatus({ state: 'error', message: errorMessage(error) }),
    );
    return () => {
      cancelled = true;
    };
  }, []);
  return status;
}

/** How long the gate shows nothing before it says it is connecting: a daemon already running answers well within it. */
const SLOW_CONNECT_MS = 1_000;

/** Whether `ms` have passed since the component mounted. */
function useAfter(ms: number): boolean {
  const [passed, setPassed] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setPassed(true), ms);
    return () => clearTimeout(timer);
  }, [ms]);
  return passed;
}

const DaemonStatusContext = createContext<DaemonStatusValue>({ state: 'connecting' });

/** The daemon's status, as `DaemonGate` read it when the window opened. */
export function useDaemonStatus(): DaemonStatusValue {
  return useContext(DaemonStatusContext);
}

/**
 * Shows `children` (the board, or a popped-out window) only once the daemon answers as this app's build. Code from one
 * build can't read another's state: a daemon left running across an upgrade sends agents without the fields this build
 * reads, which would throw while rendering and leave the window blank. So on another build's daemon it shows only the
 * offer to restart it. Before the daemon answers it shows nothing, then, past a second (a daemon starting cold), that it
 * is connecting. A daemon that can't be reached shows the board, which says so.
 */
export function DaemonGate({ children }: { children: ReactNode }) {
  const status = useDaemonHealth();
  const slow = useAfter(SLOW_CONNECT_MS);
  if (status.state === 'connecting') {
    return (
      <div className="build-mismatch-screen">
        <div className="window-drag-strip" aria-hidden />
        {slow && (
          <span className="daemon-connecting" role="status">
            {daemonStatusText(status)}
          </span>
        )}
      </div>
    );
  }
  return (
    <DaemonStatusContext.Provider value={status}>
      {buildMismatch(status) ? (
        <div className="build-mismatch-screen">
          <div className="window-drag-strip" aria-hidden />
          <BuildMismatch app={status.build} health={status.health} />
        </div>
      ) : (
        children
      )}
    </DaemonStatusContext.Provider>
  );
}

/** The daemon's status in words: its build, version, pid and schema, or why it can't be reached. */
export function daemonStatusText(status: DaemonStatusValue): string {
  switch (status.state) {
    case 'connecting':
      return 'Connecting to the daemon…';
    case 'connected':
      return `Build ${describeBuild(status.build)} · daemon ${status.health.version} · pid ${status.health.pid} · schema v${status.health.schemaVersion}`;
    case 'error':
      return `Daemon unavailable: ${status.message}`;
  }
}

/**
 * The daemon's status as a dot on the board menu's island: green when connected, red when it can't be reached. Its
 * words are its tooltip, and are read out; Settings shows them too.
 */
export function DaemonStatus({ status }: { status: DaemonStatusValue }) {
  const text = daemonStatusText(status);
  return (
    <Tooltip content={text} side="bottom">
      <span
        data-testid="daemon-status"
        data-state={status.state}
        data-pid={status.state === 'connected' ? status.health.pid : undefined}
        className="daemon-status"
        // Reached from the keyboard too, so its words can be read without a pointer.
        tabIndex={0}
      >
        <span className="visually-hidden">{text}</span>
      </span>
    </Tooltip>
  );
}

/** Whether the daemon is from another build than the app: it outlived an upgrade. */
function buildMismatch(status: DaemonStatusValue): status is Extract<DaemonStatusValue, { state: 'connected' }> {
  return status.state === 'connected' && !sameBuild(status.build, status.health.build);
}

/**
 * The daemon is from another build than the app (it outlived an upgrade): offer to restart it as this build. Its
 * sessions are stopped by the restart, and the board offers to resume them.
 */
function BuildMismatch({ app, health }: { app: BuildInfo; health: DaemonHealth }) {
  /** Live sessions the daemon reported when asked to restart, which a forced restart would end. */
  const [liveSessions, setLiveSessions] = useState<number>();
  const restart = useAction();
  const restartDaemon = (force: boolean) =>
    restart.run(async () => {
      const result = await window.agentBoard.restartDaemon(force);
      if (result.status === 'sessions-live') return setLiveSessions(result.liveSessions);
      // Every view holds state from the old daemon, so start afresh.
      location.reload();
    });

  return (
    <div className="build-mismatch ui-island" role="alert" data-testid="build-mismatch">
      <span>
        The daemon is from build {describeBuild(health.build)}, but this app is {describeBuild(app)}. Restart it to open
        the board: its agents and shells stop, and you can resume them there.
      </span>
      {liveSessions === undefined ? (
        <Button size="sm" variant="primary" loading={restart.busy} onClick={() => restartDaemon(false)}>
          Restart daemon
        </Button>
      ) : (
        <>
          <span>Restarting it ends {runningSessions(liveSessions)}.</span>
          <Button size="sm" variant="danger" loading={restart.busy} onClick={() => restartDaemon(true)}>
            Restart anyway
          </Button>
          <Button size="sm" variant="ghost" disabled={restart.busy} onClick={() => setLiveSessions(undefined)}>
            Cancel
          </Button>
        </>
      )}
      {restart.error && <ErrorText>{restart.error}</ErrorText>}
    </div>
  );
}
