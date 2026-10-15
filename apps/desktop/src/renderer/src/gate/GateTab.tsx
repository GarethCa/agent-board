import { useEffect, useRef, useState } from 'react';
import { Check, CircleDashed, ClipboardPaste, LoaderCircle, Minus, Play, RotateCw, Square, X } from 'lucide-react';
import type { Agent, GateStep } from '@agent-board/daemon/protocol';
import { noGateCommand, shortCommit, stepTime } from '@agent-board/daemon/gate-rules';
import { errorMessage } from '../../../shared/errors';
import { useNow } from '../inbox/use-now';
import { composerBlock } from '../session/composer-block';
import { requestTab } from '../session/tab-request';
import { Button, ErrorText } from '../ui';
import { shortWhen } from '../when';
import { gateHeadline, gateTone, shownStep, staleNote } from './gate-view';
import { useGateRun } from './GatesProvider';
import { useGateLog } from './use-gate-log';
import { useGateStatus } from './use-gate-status';

const STEP_ICONS: Record<GateStep['status'], typeof Check> = { passed: Check, failed: X, running: LoaderCircle, waiting: CircleDashed, stopped: Minus };

const STEP_RESULTS: Record<GateStep['status'], string> = { passed: 'pass', failed: 'FAIL', running: 'running', waiting: 'waiting', stopped: 'stopped' };

/** Starts the agent's gate, saying why when it can't. */
const runGate = (sessionId: string): Promise<unknown> => window.agentBoard.gates.run(sessionId);

/**
 * The Gate tab (BL1): an agent's latest merge gate run. Its step table on top; pick a row and its log streams
 * underneath, following the running step until another is picked. Stop while it runs; Run again after; a failed run
 * offers "Send failure to <agent>", which pastes the failing step's last lines at its prompt without sending them. A run
 * on an older commit, or with uncommitted changes, is greyed and says so.
 */
export function GateTab({ sessionId, agent, visible }: { sessionId: string; agent: Agent | undefined; visible: boolean }) {
  const run = useGateRun(sessionId);
  const { status } = useGateStatus(sessionId, visible, agent?.state);
  const [picked, setPicked] = useState<string>();
  const [problem, setProblem] = useState<string>();
  const [busy, setBusy] = useState(false);
  const now = useNow(visible && run?.status === 'running');
  const step = run === undefined ? undefined : shownStep(run, picked);
  // With no steps yet, the whole output.
  const log = useGateLog(run, run !== undefined && run.steps.length > 0 ? step : undefined, visible);
  const act = (action: () => Promise<unknown>) => {
    setBusy(true);
    setProblem(undefined);
    action().then(
      () => setBusy(false),
      (failure: unknown) => {
        setBusy(false);
        setProblem(errorMessage(failure));
      },
    );
  };
  const name = agent?.name ?? 'the agent';
  // Pasted at its prompt by the daemon, which checks the agent as it writes (never into a permission prompt), and not
  // sent: shown in its own tab, for the user to read and send.
  const sendFailure = (failedStep: string) =>
    act(async () => {
      await window.agentBoard.gates.sendFailure(sessionId, failedStep);
      requestTab(sessionId, { kind: 'own' });
    });

  if (run === undefined) {
    return (
      <div className="pr-view gate-view" data-testid="gate-view">
        <div className="gate-empty">
          <p className="pr-quiet">The gate hasn&rsquo;t run for {name} yet.</p>
          {status?.command === null ? (
            <p className="pr-quiet">{noGateCommand(undefined)}</p>
          ) : (
            <Button size="sm" variant="primary" icon={<Play />} disabled={busy} onClick={() => act(() => runGate(sessionId))} data-testid="gate-run">
              Run gate{status?.command ? <code className="gate-command-inline">{status.command}</code> : null}
            </Button>
          )}
          {problem !== undefined && <ErrorText>{problem}</ErrorText>}
        </div>
      </div>
    );
  }

  const stale = staleNote(run, status?.head ?? null);
  const failedStep = run.status === 'failed' ? (run.steps.find((each) => each.status === 'failed')?.name ?? run.steps.at(-1)?.name) : undefined;
  const following = run.status === 'running' && picked === undefined;
  // Never into a permission prompt, where it would answer it, nor into an agent that has ended.
  const blocked = agent === undefined ? `${name} has gone` : composerBlock(agent)?.reason;
  const canSend = blocked === undefined && failedStep !== undefined;
  return (
    <div className="pr-view gate-view" data-testid="gate-view" data-status={run.status} data-stale={stale !== undefined || undefined}>
      <header className="pr-head gate-head">
        <div className="gate-title-row">
          <h3 className="gate-headline" data-tone={gateTone(run)} data-testid="gate-headline">
            {gateHeadline(run, now)}
          </h3>
          <code className="gate-command">{run.command}</code>
          <span className="pr-meta-end">
            {run.status === 'running' ? (
              <Button size="xs" variant="ghost" icon={<Square />} disabled={busy} onClick={() => act(() => window.agentBoard.gates.stop(sessionId))} data-testid="gate-stop" tooltip="Stop it, and everything it started">
                Stop
              </Button>
            ) : (
              <>
                {failedStep !== undefined && (
                  <Button
                    size="xs"
                    variant="ghost"
                    icon={<ClipboardPaste />}
                    disabled={busy || !canSend}
                    onClick={() => sendFailure(failedStep)}
                    data-testid="gate-send-failure"
                    tooltip={canSend ? `Paste ${failedStep}'s last lines at ${name}'s prompt; you send it` : blocked}
                  >
                    Send failure to {name}
                  </Button>
                )}
                <Button size="xs" variant="ghost" icon={<RotateCw />} disabled={busy} onClick={() => act(() => runGate(sessionId))} data-testid="gate-run-again">
                  Run again
                </Button>
              </>
            )}
          </span>
        </div>
        <div className="pr-meta gate-meta" data-testid="gate-meta">
          {stale === undefined ? (
            <span>
              on <code>{shortCommit(run.commit)}</code>
              {agent?.branch ? (
                <>
                  {' · '}
                  <code>{agent.branch}</code>
                </>
              ) : null}
              {` · started ${shortWhen(run.startedAt)}`}
            </span>
          ) : (
            <span className="gate-stale" data-testid="gate-stale">
              {stale}
              {run.status !== 'running' && (
                <>
                  {' · '}
                  <button type="button" className="gate-link" disabled={busy} onClick={() => act(() => runGate(sessionId))}>
                    Run again
                  </button>
                </>
              )}
            </span>
          )}
        </div>
        {problem !== undefined && <ErrorText className="pr-error">{problem}</ErrorText>}
      </header>
      <table className="gate-steps" data-testid="gate-steps">
        <thead>
          <tr>
            <th>Step</th>
            <th>Result</th>
            <th>Time</th>
          </tr>
        </thead>
        <tbody>
          {run.steps.map((each) => {
            const Icon = STEP_ICONS[each.status];
            return (
              <tr
                key={each.name}
                data-status={each.status}
                aria-selected={each.name === step}
                tabIndex={0}
                onClick={() => setPicked(each.name)}
                onKeyDown={(event) => (event.key === 'Enter' || event.key === ' ') && setPicked(each.name)}
                data-testid="gate-step"
              >
                <td className="gate-step-name">{each.name}</td>
                <td>
                  <span className="gate-step-result">
                    <Icon aria-hidden className="gate-step-icon" />
                    {STEP_RESULTS[each.status]}
                  </span>
                </td>
                <td className="gate-step-time">{each.status === 'running' && each.startedAt !== null ? stepTime({ startedAt: each.startedAt, endedAt: new Date(now).toISOString() }) : stepTime(each) || '–'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="gate-log-head">
        {step ?? 'Output'}
        {following && <span className="pr-quiet"> · following</span>}
      </div>
      <GateLogView text={log.text} error={log.error} />
    </div>
  );
}

/** A log, kept scrolled to its end as it grows, unless the user has scrolled up from there. */
function GateLogView({ text, error }: { text: string; error: string | undefined }) {
  const view = useRef<HTMLPreElement>(null);
  const atEnd = useRef(true);
  useEffect(() => {
    const element = view.current;
    if (element !== null && atEnd.current) element.scrollTop = element.scrollHeight;
  }, [text]);
  return (
    <pre
      ref={view}
      className="gate-log"
      data-testid="gate-log"
      onScroll={(event) => {
        const element = event.currentTarget;
        atEnd.current = element.scrollTop + element.clientHeight >= element.scrollHeight - 4;
      }}
    >
      {error === undefined ? text : <ErrorText>{error}</ErrorText>}
    </pre>
  );
}
