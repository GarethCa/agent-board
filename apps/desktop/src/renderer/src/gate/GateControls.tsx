import { useState, type ChangeEvent } from 'react';
import { Check, ChevronDown, CircleDashed, GitMerge, Info, Play, X } from 'lucide-react';
import type { Agent, GateCleanup, PullRequestDetails, PullRequestRef } from '@agent-board/daemon/protocol';
import {
  ALL_CLEANUP,
  gateBadge,
  githubBlocked,
  isOpenPullRequest,
  mergeGateBlocked,
  NO_GATE,
  shortCommit,
  withCleanup,
} from '@agent-board/daemon/gate-rules';
import { pullRequestOfUrl, shortIssueId } from '@agent-board/daemon/protocol';
import { errorMessage } from '../../../shared/errors';
import { requestTab } from '../session/tab-request';
import { gateSurfaceOf } from '../session/tabs';
import { usePullRequest } from '../session/use-pull-request';
import { runGateShortcut } from '../session/window-keys';
import { Button, Checkbox, Chip, Popover, useToast } from '../ui';
import { mergedText } from './gate-view';
import { useGateRun } from './GatesProvider';
import { useGateStatus } from './use-gate-status';

/** The clean-up a zone's merges last used, kept in this browser; every step until one is cleared. */
function keptCleanup(zoneId: string | null): GateCleanup {
  try {
    const kept = JSON.parse(localStorage.getItem(`gate-cleanup:${zoneId ?? ''}`) ?? 'null') as Partial<GateCleanup> | null;
    return kept === null ? ALL_CLEANUP : { ...ALL_CLEANUP, ...kept };
  } catch {
    return ALL_CLEANUP;
  }
}

function keepCleanup(zoneId: string | null, cleanup: GateCleanup): void {
  try {
    localStorage.setItem(`gate-cleanup:${zoneId ?? ''}`, JSON.stringify(cleanup));
  } catch {
    // Only a convenience: the boxes start ticked next time.
  }
}

/**
 * The merge gate in an agent's session window or expanded tile header, in every zone, whatever its tabs
 * show: the gate's badge, or Run gate in a zone with a gate command; then, once it has an open pull request,
 * Merge, whose popover lists its conditions and the clean-up, or Approve when the pull request isn't the user's own. In a
 * zone with no gate, Merge waits for GitHub's checks alone. Each acts only on the user's click, and a disabled one says
 * why. There is no Open PR here: agents open their own pull requests.
 */
export function GateControls({ agent, visible }: { agent: Agent; visible: boolean }) {
  const run = useGateRun(agent.sessionId);
  const { status } = useGateStatus(agent.sessionId, visible, agent.state);
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const pr = agent.pullRequests.find(isOpenPullRequest);
  const pullRef = pr === undefined ? undefined : pullRequestOfUrl(pr.url);
  const openGateTab = () => requestTab(agent.sessionId, gateSurfaceOf(agent.sessionId));
  const act = (what: string, action: () => Promise<unknown>) => {
    setBusy(true);
    action()
      .catch((failure: unknown) => toast.show({ tone: 'error', message: `Could not ${what}: ${errorMessage(failure)}` }))
      .finally(() => setBusy(false));
  };
  const runGate = () =>
    act('run the gate', async () => {
      openGateTab();
      await window.agentBoard.gates.run(agent.sessionId);
    });

  if (status === undefined) return null;
  const gatedZone = status.command !== null;
  return (
    <span className="gate-controls" role="group" aria-label="Merge gate">
      {run !== undefined && run.status !== 'stopped' ? (
        <Chip className="gate-header-badge" data-status={run.status} data-testid="header-gate" title="Open its Gate tab" onClick={openGateTab}>
          {gateBadge(run)}
        </Chip>
      ) : (
        gatedZone && (
          <Button
            size="sm"
            variant="ghost"
            icon={<Play />}
            disabled={busy}
            onClick={runGate}
            tooltip={`Run ${status.command} in its worktree (${runGateShortcut()})`}
            data-testid="header-run-gate"
          >
            Run gate
          </Button>
        )
      )}
      {pr !== undefined && pullRef !== undefined && <PullRequestControls agent={agent} number={pr.number} title={pr.title} pullRef={pullRef} visible={visible} gatedZone={gatedZone} />}
    </span>
  );
}

/** Merge, or Approve for someone else's pull request, read from GitHub as the window shows. */
function PullRequestControls({
  agent,
  number,
  title,
  pullRef,
  visible,
  gatedZone,
}: {
  agent: Agent;
  number: number;
  title: string;
  pullRef: PullRequestRef;
  visible: boolean;
  gatedZone: boolean;
}) {
  const read = usePullRequest(pullRef, visible);
  const { details } = read;
  const [open, setOpen] = useState(false);
  const chip = (
    <Chip mono className="gate-header-pr" title={`#${number} ${title}: open it in a PR tab`} onClick={() => requestTab(agent.sessionId, { kind: 'pr', ...pullRef })}>
      #{number}
    </Chip>
  );
  if (details !== undefined && !details.byViewer) {
    return (
      <>
        {chip}
        <Popover
          aria-label={`Approve #${number}`}
          align="end"
          open={open}
          onOpenChange={setOpen}
          content={
            <ApprovePopover
              details={details}
              busy={read.busy}
              onCancel={() => setOpen(false)}
              onApprove={() => {
                setOpen(false);
                read.act('approve');
              }}
            />
          }
        >
          <Button size="sm" icon={<Check />} data-testid="header-approve">
            Approve
          </Button>
        </Popover>
      </>
    );
  }
  return (
    <>
      {chip}
      <Popover
        aria-label={`Merge #${number}`}
        align="end"
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (next) read.refresh();
        }}
        content={<MergePopover agent={agent} details={details} error={read.error} busy={read.busy} gatedZone={gatedZone} onDone={() => setOpen(false)} />}
      >
        <Button size="sm" icon={<GitMerge />} trailingIcon={<ChevronDown />} data-testid="header-merge">
          Merge
        </Button>
      </Popover>
    </>
  );
}

/**
 * Approve's popover: as the user, at the head shown. A component of its own, so nothing in it is worked out until it
 * opens; a pull request read with no head commit can't be approved from here.
 */
function ApprovePopover({ details, busy, onCancel, onApprove }: { details: PullRequestDetails; busy: boolean; onCancel(): void; onApprove(): void }) {
  const head = details.headCommit as string | null;
  const why = head === null ? 'GitHub gave no head commit to approve at: refresh it.' : details.approve.allowed ? undefined : details.approve.why;
  return (
    <div className="gate-popover">
      <p className="gate-popover-title">Approve #{details.number}?</p>
      {head !== null && (
        <p className="pr-quiet">
          As you, at <code>{shortCommit(head)}</code>, the commit shown: if anything was pushed since, nothing is approved.
        </p>
      )}
      {why !== undefined && <p className="pr-quiet">{why}</p>}
      <div className="gate-popover-actions">
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" icon={<Check />} disabled={busy || why !== undefined} onClick={onApprove} data-testid="header-approve-confirm">
          Approve
        </Button>
      </div>
    </div>
  );
}

/**
 * Merge's popover: its conditions (the gate passed on the PR's head, in a zone with a gate; GitHub's checks green), each
 * ticked or saying why not; what happens after; then Squash and merge. In a zone with no gate, it says so, and how to set one.
 */
function MergePopover({
  agent,
  details,
  error,
  busy,
  gatedZone,
  onDone,
}: {
  agent: Agent;
  details: PullRequestDetails | undefined;
  error: string | undefined;
  busy: boolean;
  gatedZone: boolean;
  onDone(): void;
}) {
  const run = useGateRun(agent.sessionId);
  const toast = useToast();
  const [cleanup, setCleanup] = useState(() => keptCleanup(agent.zoneId));
  const [merging, setMerging] = useState(false);
  if (details === undefined) return <p className="pr-quiet gate-popover">{error ?? 'Reading the pull request…'}</p>;
  if ((details.headCommit as string | null) === null) return <p className="pr-quiet gate-popover">GitHub gave no head commit to merge at: open it again.</p>;
  const gateWhy = mergeGateBlocked({ run, pr: details, gated: gatedZone });
  const githubWhy = githubBlocked(details);
  const blocked = gateWhy ?? githubWhy;
  const issue = agent.issue === null ? undefined : shortIssueId(agent.issue);
  const toggle = (step: keyof GateCleanup) => (event: ChangeEvent<HTMLInputElement>) => {
    const next = withCleanup(cleanup, step, event.target.checked);
    setCleanup(next);
    keepCleanup(agent.zoneId, next);
  };
  const greenChecks = details.checks.filter((check) => check.state === 'passing').length;
  const merge = () => {
    setMerging(true);
    window.agentBoard.gates
      .merge(agent.sessionId, details.number, details.headCommit, { ...cleanup, comment: cleanup.comment && issue !== undefined })
      .then(
        (merged) => {
          onDone();
          toast.show({
            tone: merged.failed.length === 0 ? 'success' : 'error',
            message: mergedText(details.number, details.baseRefName, merged, { agent: agent.name, branch: agent.branch, issue }),
          });
        },
        (failure: unknown) => toast.show({ tone: 'error', message: `Could not merge #${details.number}: ${errorMessage(failure)}` }),
      )
      .finally(() => setMerging(false));
  };
  return (
    <div className="gate-popover" data-testid="merge-popover">
      <p className="gate-popover-title">Squash and merge #{details.number}?</p>
      <ul className="gate-conditions">
        {gatedZone ? (
          <li data-ok={gateWhy === undefined} data-testid="merge-gate-condition">
            {gateWhy === undefined ? <Check aria-hidden /> : run?.status === 'running' ? <CircleDashed aria-hidden /> : <X aria-hidden />}
            {gateWhy ?? `Gate passed on ${shortCommit(details.headCommit)} (head)`}
          </li>
        ) : (
          <li data-ok="none" data-testid="merge-no-gate">
            <Info aria-hidden />
            {NO_GATE}
          </li>
        )}
        <li data-ok={githubWhy === undefined} data-testid="merge-github-condition">
          {githubWhy === undefined ? <Check aria-hidden /> : <X aria-hidden />}
          {githubWhy ?? `GitHub checks green${details.checks.length === 0 ? '' : ` (${greenChecks})`}`}
        </li>
      </ul>
      <fieldset className="gate-then">
        <legend>Then</legend>
        <Checkbox label={`Close ${agent.name}`} checked={cleanup.close} onChange={toggle('close')} />
        <Checkbox
          label="Remove its worktree"
          title="Only while it holds nothing but what was merged: anything newer or uncommitted keeps it, with its branch"
          checked={cleanup.worktree}
          onChange={toggle('worktree')}
        />
        <Checkbox
          label={
            <>
              Delete <code>{agent.branch}</code>
            </>
          }
          checked={cleanup.branch}
          onChange={toggle('branch')}
        />
        <Checkbox
          label={issue === undefined ? 'Comment on its issue' : `Comment on ${issue} with the PR${gatedZone ? ' and gate' : ''}`}
          checked={cleanup.comment && issue !== undefined}
          disabled={issue === undefined}
          title={issue === undefined ? 'It has no linked issue' : undefined}
          onChange={toggle('comment')}
        />
      </fieldset>
      <div className="gate-popover-actions">
        <Button size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" className="pr-merge" icon={<GitMerge />} disabled={busy || merging || blocked !== undefined} onClick={merge} data-testid="merge-confirm">
          Squash and merge
        </Button>
      </div>
      {blocked !== undefined && (
        <p className="pr-quiet gate-why-line" data-testid="merge-why">
          {blocked}
        </p>
      )}
    </div>
  );
}

