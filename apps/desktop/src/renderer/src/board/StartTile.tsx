import { useContext } from 'react';
import { Check, RotateCcw, Trash2, X } from 'lucide-react';
import type { Agent, Harness, StartStep } from '@agent-board/daemon/protocol';
import { HARNESSES } from '../harness';
import { Button, EditableName, IconButton, RenameButton, Spinner, StatusPill, Tag, useRenaming } from '../ui';
import { HarnessMark } from './HarnessMark';
import { modelLabel } from './AgentSetup';
import { TileActionsContext } from './tile';
import { useRenameRequest } from './rename';
import type { ShownStart } from './use-agent-starts';

/** A step of a start as its tile lists it: what it is doing, or did, or failed at. */
export interface StepLine {
  state: StartStep['state'];
  text: string;
}

/** What a start's step reads on its tile: "creating worktree…", then "worktree fix-the-tests". */
export function stepLine(step: StartStep, harness: Harness): StepLine {
  const name = HARNESSES[harness].label;
  const text = {
    issue: { now: 'reading the issue…', done: `issue ${step.detail ?? ''}`.trim(), failed: 'reading the issue' },
    worktree: { now: 'creating worktree…', done: `worktree ${step.detail ?? ''}`.trim(), failed: 'creating worktree' },
    launch: { now: `starting ${name}…`, done: `${name} started`, failed: `couldn't start ${name}` },
  }[step.kind][step.state];
  return { state: step.state, text };
}

/**
 * The steps a started agent's tile lists until its session's first hook: its worktree made (none for a folder it was
 * put in), then its harness starting, or how it exited before it came up.
 */
export function agentStartLines(agent: Agent): StepLine[] {
  const lines: StepLine[] = [];
  if (agent.ownsWorktree) lines.push({ state: 'done', text: `worktree ${agent.branch || agent.worktree.split('/').at(-1)}` });
  if (agent.startup?.failed === true) {
    lines.push({ state: 'failed', text: `${agent.harness} exited${agent.exitCode === null ? '' : ` (code ${agent.exitCode})`}` });
  } else {
    lines.push(stepLine({ kind: 'launch', state: 'now', detail: null }, agent.harness));
  }
  return lines;
}

/** A start's steps, each with its mark: a tick once done, a spinner while under way, a cross where it failed. */
export function StartSteps({ lines }: { lines: readonly StepLine[] }) {
  return (
    <span className="hybrid-tile-steps" data-testid="start-steps">
      {lines.map((line) => (
        <span key={line.text} className="hybrid-tile-step" data-state={line.state}>
          {line.state === 'done' ? <Check aria-hidden /> : line.state === 'failed' ? <X aria-hidden /> : <Spinner />}
          <span className="hybrid-tile-step-text">{line.text}</span>
        </span>
      ))}
    </span>
  );
}

/** Under a start's steps: the last line its terminal showed while it starts, or why it failed. */
export function StartOutput({ output, failed }: { output: string | null; failed: boolean }) {
  if (output === null) return null;
  return failed ? (
    <span className="hybrid-tile-start-error" data-testid="start-error" role="alert" title={output}>
      {output}
    </span>
  ) : (
    <span className="hybrid-tile-start-output" data-testid="start-output" title={output}>
      {output}
    </span>
  );
}

/** A failed start's footer: Retry, when it can be retried, and Delete. */
export function StartFailedActions({ onRetry, onDelete }: { onRetry?(): void; onDelete(): void }) {
  return (
    <span className="hybrid-tile-footer">
      {onRetry !== undefined && (
        <Button size="sm" variant="primary" className="nodrag" icon={<RotateCcw />} onClick={onRetry} onDoubleClick={(event) => event.stopPropagation()}>
          Retry
        </Button>
      )}
      <Button size="sm" variant="danger" className="nodrag" icon={<Trash2 />} onClick={onDelete} onDoubleClick={(event) => event.stopPropagation()}>
        Delete
      </Button>
    </span>
  );
}

/**
 * The tile of an agent being started, before it is one (`AgentStart`): dashed, with a spinner for its mark and the
 * steps as they happen. It can be renamed and moved meanwhile, and turns into the agent's own tile once its session
 * runs. A failed start keeps its error, with Retry and Delete; one the daemon lost in a restart, with Delete only.
 */
export function StartTile({ id, start }: { id: string; start: ShownStart }) {
  const { retryStart, dismissStart, renameStart } = useContext(TileActionsContext);
  const failed = start.error !== null;
  const renaming = useRenaming(start.name, (name) => renameStart(start.sessionId, name));
  useRenameRequest(id, renaming);
  return (
    <div
      className="hybrid-tile hybrid-tile-agent"
      data-testid="start-tile"
      data-representation="hybrid"
      data-harness={start.harness}
      data-start={failed ? 'failed' : 'starting'}
      data-session-id={start.sessionId}
      data-zone={start.zoneId ?? ''}
    >
      <div className="hybrid-tile-head">
        {failed ? <HarnessMark className="hybrid-tile-icon" harness={start.harness} /> : <Spinner />}
        <EditableName className="hybrid-tile-name" value={start.name} title={start.name} renaming={renaming} label="Agent name" />
        <RenameButton renaming={renaming} />
        {!failed && (
          <span className="hybrid-tile-corner">
            <span className="hybrid-tile-actions">
              <IconButton
                size="xs"
                className="nodrag"
                icon={<X />}
                aria-label="Stop starting it"
                onClick={() => dismissStart(start.sessionId)}
                onDoubleClick={(event) => event.stopPropagation()}
              />
            </span>
          </span>
        )}
      </div>
      <StartSteps lines={start.steps.map((step) => stepLine(step, start.harness))} />
      {failed ? <StartOutput output={start.confirm ? 'This repo has its own Codex config: confirm to start.' : start.error} failed /> : null}
      {failed ? (
        <StartFailedActions onRetry={start.lost ? undefined : () => retryStart(start)} onDelete={() => dismissStart(start.sessionId)} />
      ) : (
        <span className="hybrid-tile-footer">
          <StatusPill state="starting" />
          {start.model !== null && (
            <Tag className="hybrid-tile-setup" data-testid="tile-model">
              <span className="hybrid-tile-badge-text">{modelLabel(start.model)}</span>
            </Tag>
          )}
        </span>
      )}
    </div>
  );
}
