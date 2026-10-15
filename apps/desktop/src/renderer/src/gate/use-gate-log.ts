import { useEffect, useState } from 'react';
import type { GateRun } from '@agent-board/daemon/protocol';
import { errorMessage } from '../../../shared/errors';

/** How often a running step's log is read on while it shows. */
const FOLLOW_MS = 500;

/** The most of a log kept in view: its last lines. */
const KEPT_CHARS = 200_000;

/**
 * A step's log of the agent's latest run (or its whole output, with no step), read from the daemon as it shows: once,
 * then on every `FOLLOW_MS` while the run is running, following it. Starts again for a new run or another step.
 */
export function useGateLog(run: GateRun | undefined, step: string | undefined, visible: boolean): { text: string; error: string | undefined } {
  const [log, setLog] = useState<{ key: string; text: string; error?: string }>({ key: '', text: '' });
  const key = run === undefined ? '' : `${run.sessionId}/${run.startedAt}/${step ?? ''}`;
  const running = run?.status === 'running';
  // Read once more after it ends: its last lines came with its end.
  const ended = run?.endedAt ?? '';
  useEffect(() => {
    if (run === undefined || !visible) return;
    let next: number | undefined;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = () =>
      window.agentBoard.gates.log(run.sessionId, step, next).then(
        (piece) => {
          if (cancelled) return;
          const fresh = next === undefined || piece.reset === true;
          next = piece.next;
          setLog((current) => ({ key, text: ((fresh || current.key !== key ? '' : current.text) + piece.text).slice(-KEPT_CHARS) }));
          if (running) timer = setTimeout(() => void read(), FOLLOW_MS);
        },
        (failure: unknown) => !cancelled && setLog({ key, text: '', error: errorMessage(failure) }),
      );
    void read();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // `run` itself is new on every change of its steps; what to read is named by the key.
  }, [key, running, ended, visible]);
  return log.key === key ? { text: log.text, error: log.error } : { text: '', error: undefined };
}
