import { useEffect, useRef, useState, type FormEvent } from 'react';
import { isOrchestratorRole, ORCHESTRATOR_ROLE, shortIssueId, type Agent, type Zone } from '@agent-board/daemon/protocol';
import { TriangleAlert } from 'lucide-react';
import { errorMessage } from '../../../shared/errors';
import { HARNESSES } from '../harness';
import { Button, Checkbox, Dialog, ErrorText, Field, Fieldset, Hint, Input, Kbd, Segmented, Select, Textarea } from '../ui';
import type { SegmentedOption } from '../ui';
import { AgentSetupChips, DEFAULT_SETUP, reviews, roleNote, type AgentSetup } from './AgentSetup';
import { bypassNoticeSeen, CodexBypassExplanation, markBypassNoticeSeen } from './codex-notice';
import { NEW_AGENT_SIZE } from '@agent-board/daemon/board-layout';
import { IssuePicker, type PickedIssue } from './IssuePicker';
import { reviewable, reviewSpawn } from './review-target';
import { repoName } from './tiles';
import { RepoField, repoParam, type RepoValue } from './RepoField';
import { useCheckoutWarning } from './checkout-warning';
import { keyText } from '../keys/registry';

const CHECKOUTS: readonly SegmentedOption<'main' | 'worktree'>[] = [
  { id: 'main', label: 'Main checkout' },
  { id: 'worktree', label: 'New worktree' },
];

interface NewAgentDialogProps {
  /** The zone it starts in; none for an agent loose on the board, which needs a `position`. */
  zone?: Zone;
  /** The agents on the board: a reviewer reviews the branch of one of its zone's repo. */
  agents: readonly Agent[];
  /** The issue to start from, picked already (from an issue card), and the zone whose tracker it is in. */
  issue?: PickedIssue;
  issueZoneId?: string;
  /** Its name, filled in already (from ⌘K). */
  name?: string;
  /** Where its tile goes in the zone, or on the board (from the Agent tool, or a card there); the board slots it in without. */
  position?: { x: number; y: number };
  /** Its tile is on the board, as the agent the session id will be; `fromIssue` when it starts from an issue. */
  onStarted(sessionId: string, fromIssue: boolean): void;
  onCancel(): void;
  /** The zone's settings changed. */
  onZoneChanged(zone: Zone): void;
}

/**
 * What the dialog shows: the form, or the one-time explanation of Codex's hook-trust bypass, before the first Codex
 * agent that would use it. The daemon's warning that the new worktree has Codex config of its own comes on the tile.
 */
type Step = { kind: 'form' } | { kind: 'bypass-notice' };

/**
 * Asks for a new agent's task and name (optional), with its harness, model and role in the footer's chips
 *, then starts it in the zone. Where the zone has no repo of its own (a group, or no zone at all) a Repo field
 * comes first: which repo it works in, with its base and new branch folded under it. A reviewer picks the agent whose branch it reviews. In a zone with a
 * tracker it can start from an issue instead: the issue becomes its prompt (the task, if any, follows it) and names
 * its branch. The zone's Codex setting is saved only when a Codex agent starts, so Cancel leaves it as it was. Start
 * closes it as soon as the agent's tile is on the board: what fails after that stays on the tile.
 */
export function NewAgentDialog({ zone, agents, issue: initialIssue, issueZoneId, name: initialName = '', position, onStarted, onCancel, onZoneChanged }: NewAgentDialogProps) {
  const [setup, setSetup] = useState<AgentSetup>(DEFAULT_SETUP);
  const { harness, model, role } = setup;
  const candidates = reviewable(zone, agents);
  /** The agent whose branch a reviewer reviews, by session id: '' for the zone's repo's checked-out branch. */
  const [reviewed, setReviewed] = useState(candidates[0]?.sessionId ?? '');
  /** A group (a zone with no repo of its own) asks which repo the agent works in; a repo zone's agent works in its own. */
  const group = zone === undefined || zone.repoRoot === null;
  const defaultRepo = zone?.defaultRepo ?? null;
  /** Where its agent runs given no repo: the group's own folder, while the group has no default repo. */
  const groupFolder = group && defaultRepo === null ? (zone?.groupFolder ?? null) : null;
  // A group added for a folder of the user's outside git starts its agents in that folder.
  const [pickedRepo, setRepo] = useState<RepoValue>(
    defaultRepo !== null ? { kind: 'folder', path: defaultRepo, branch: null } : zone?.userFolder === true ? { kind: 'none' } : { kind: 'scratch' },
  );
  const [baseBranch, setBaseBranch] = useState('');
  /** The new branch as typed: '' takes the one made from the agent's name (or its issue's). */
  const [newBranch, setNewBranch] = useState('');
  /** Whether the user has picked a repo, which the last used must not then replace as it loads. */
  const userPicked = useRef(false);
  /** The same, for what it shows: an orchestrator starts with no repo until the user picks one. */
  const [repoChosen, setRepoChosen] = useState(false);
  const pickRepo = (next: RepoValue, byUser = true) => {
    userPicked.current ||= byUser;
    if (byUser) setRepoChosen(true);
    setRepo(next);
    setBaseBranch(next.kind === 'folder' ? (next.branch ?? '') : '');
    setError(undefined);
  };
  const [prompt, setPrompt] = useState('');
  /** An orchestrator works in the repo's own checkout by default, or in a worktree like any agent. */
  const orchestrator = isOrchestratorRole(role);
  // An orchestrator in a group with no repo works in the group's own folder, its agents each picking their repo.
  const repo: RepoValue = orchestrator && groupFolder !== null && !repoChosen ? { kind: 'none' } : pickedRepo;
  /** A group with no repo of its own to review has no checked-out branch to offer. */
  const ownBranch = !group || repo.kind === 'folder';
  const [checkout, setCheckout] = useState<'main' | 'worktree'>('main');
  /** The orchestrator template the task was filled with, while it is still what the task says. */
  const [template, setTemplate] = useState<string>();
  const hasRepoCheckout = !group || repo.kind === 'folder';
  const inMain = orchestrator && hasRepoCheckout && checkout === 'main';
  // Starting in a checkout that is dirty or off its default branch still works: the row only says so.
  const checkoutWarning = useCheckoutWarning(inMain ? (group ? (repo.kind === 'folder' ? repo.path : undefined) : (zone?.repoRoot ?? undefined)) : undefined);
  // Choosing the orchestrator role fills the task from its template; choosing another role takes it back out, unedited.
  useEffect(() => {
    if (!orchestrator) {
      setTemplate((filled) => {
        if (filled !== undefined) setPrompt((current) => (current === filled ? '' : current));
        return undefined;
      });
      return;
    }
    if (zone === undefined) return;
    let cancelled = false;
    window.agentBoard.zones.roleTemplates(zone.id).then(
      (templates) => {
        const body = templates.find((each) => each.role.toLowerCase() === ORCHESTRATOR_ROLE)?.body ?? '';
        // A template with variables can only be filled in by the daemon, which starts it as it always does.
        if (cancelled || body === '' || body.includes('{{')) return;
        setTemplate(body);
        setPrompt((current) => (current === '' ? body : current));
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [orchestrator, zone?.id]);
  const [name, setName] = useState(initialName);
  const [issue, setIssue] = useState<PickedIssue | undefined>(initialIssue);
  const [bypass, setBypass] = useState(zone?.codexBypassHookTrust ?? true);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string>();
  const [step, setStep] = useState<Step>({ kind: 'form' });

  const start = async (options: { bypassNoticeShown?: boolean } = {}) => {
    setStep({ kind: 'form' });
    setStarting(true);
    setError(undefined);
    try {
      // The daemon reads the setting from the zone when it spawns.
      if (zone !== undefined && harness === 'codex' && bypass !== zone.codexBypassHookTrust) {
        onZoneChanged(await window.agentBoard.zones.configure(zone.id, { codexBypassHookTrust: bypass }));
      }
      const sessionId = await window.agentBoard.agents.start({
        zoneId: zone?.id ?? null,
        harness,
        model: model || undefined,
        role: role ?? undefined,
        ...(group
          ? {
              repo: repoParam(repo),
              baseBranch: repo.kind === 'folder' && !inMain ? baseBranch.trim() || undefined : undefined,
              branch: repo.kind === 'folder' && !reviews(role) && !inMain ? newBranch.trim() || undefined : undefined,
            }
          : {}),
        ...(reviews(role) ? reviewSpawn(zone, candidates.find((agent) => agent.sessionId === reviewed)) : {}),
        prompt,
        ...(orchestrator ? { orchestrate: 'zone' as const, ...(inMain ? { checkout: 'main' as const } : {}) } : {}),
        // The task holds the template, if it still does: then the daemon doesn't add it again.
        ...(template !== undefined && prompt.includes(template) ? { noTemplate: true } : {}),
        name: name.trim() || undefined,
        issueId: issue?.id,
        issueZoneId: issue === undefined ? undefined : issueZoneId,
        position,
        ...NEW_AGENT_SIZE,
      });
      if (options.bypassNoticeShown) markBypassNoticeSeen();
      onStarted(sessionId, issue !== undefined);
    } catch (failure) {
      setError(errorMessage(failure));
      setStarting(false);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (harness === 'codex' && bypass && !bypassNoticeSeen()) setStep({ kind: 'bypass-notice' });
    else void start();
  };

  const back = (
    <Button variant="ghost" onClick={() => setStep({ kind: 'form' })}>
      Back
    </Button>
  );

  if (step.kind === 'bypass-notice') {
    return (
      <Dialog
        aria-label="About Codex hooks"
        title="Codex agents skip hook review"
        onClose={onCancel}
        footer={
          <>
            {back}
            <Button variant="primary" autoFocus onClick={() => void start({ bypassNoticeShown: true })}>
              Start
            </Button>
          </>
        }
      >
        <CodexBypassExplanation />
        <p>
          To review agent-board&apos;s hooks once instead, turn off &ldquo;Skip Codex&apos;s hook review&rdquo; for the
          zone. Codex then asks in the agent&apos;s terminal, and until you trust its hooks the tile can&apos;t show
          what the agent is doing.
        </p>
      </Dialog>
    );
  }

  return (
    <Dialog
      aria-label="New agent"
      title={
        <>
          New {HARNESSES[harness].label} agent{zone !== undefined && ' in '}
          {zone !== undefined && <span className="new-agent-zone">{zone.name}</span>}
        </>
      }
      onClose={onCancel}
      onSubmit={submit}
      footerStart={<AgentSetupChips setup={setup} onChange={setSetup} />}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={starting}>
            {starting ? 'Starting…' : 'Start'}
            <Kbd aria-hidden>{keyText('dialog.submit')}</Kbd>
          </Button>
        </>
      }
    >
      {group && (
        <RepoField
          value={repo}
          defaultRepo={defaultRepo}
          groupFolder={groupFolder}
          baseBranch={baseBranch}
          branch={newBranch}
          reviewer={reviews(role)}
          inPlace={inMain}
          reviewsPicked={reviews(role) && reviewed !== ''}
          onRecents={(found) => {
            // The last used is the repo to start with, unless the group names one, or a folder of the user's, or the user has picked.
            if (found[0] !== undefined && defaultRepo === null && zone?.userFolder !== true && !userPicked.current) pickRepo({ kind: 'folder', path: found[0].path, branch: found[0].branch }, false);
          }}
          onPick={pickRepo}
          onBaseBranch={setBaseBranch}
          onBranch={setNewBranch}
          onError={setError}
        />
      )}
      {orchestrator && repo.kind === 'none' && (
        <div className="ui-field">
          <span className="ui-field-name">Checkout</span>
          <Hint data-testid="checkout-no-repo">
            No repo: runs in {groupFolder}. Agents it starts pick their repo per task.
          </Hint>
        </div>
      )}
      {orchestrator && hasRepoCheckout && (
        <div className="ui-field">
          <span className="ui-field-name">Checkout</span>
          <Segmented<'main' | 'worktree'>
            aria-label="Checkout"
            value={checkout}
            onChange={setCheckout}
            options={CHECKOUTS}
          />
          <Hint>
            {checkout === 'main'
              ? "Works in the repo's own folder, on the branch checked out there. Agents it starts get worktrees of their own."
              : 'Works in a worktree and branch of its own, as any agent does.'}
          </Hint>
          {checkoutWarning !== undefined && (
            <Hint className="ui-hint-warning" data-testid="checkout-warning">
              <TriangleAlert aria-hidden /> {checkoutWarning}
            </Hint>
          )}
        </div>
      )}
      {zone?.tracker != null && (issueZoneId === undefined || issueZoneId === zone.id) ? (
        <Fieldset legend="Start from an issue (optional)">
          <IssuePicker zone={zone} selected={issue} onSelect={setIssue} />
        </Fieldset>
      ) : (
        issue !== undefined && (
          <Hint>
            Starts from {shortIssueId(issue)}: {issue.title}
          </Hint>
        )
      )}
      <Field label="Task">
        <Textarea
          rows={3}
          value={prompt}
          placeholder={issue === undefined ? 'Task (optional)… or type it in the terminal' : 'Task (optional, after the issue)…'}
          autoFocus={zone?.tracker == null}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) event.currentTarget.form?.requestSubmit();
          }}
        />
      </Field>
      <Field label="Name (optional)">
        <Input
          value={name}
          placeholder={issue === undefined ? 'From the task' : `${shortIssueId(issue)}: ${issue.title}`}
          onChange={(event) => setName(event.target.value)}
        />
      </Field>
      {reviews(role) && (
        <Field label="Reviews">
          <Select value={reviewed} onChange={(event) => setReviewed(event.target.value)}>
            {candidates.map((agent) => (
              <option key={agent.sessionId} value={agent.sessionId}>
                {agent.name} · {agent.branch}
                {agent.repoRoot === zone?.repoRoot ? '' : ` (${repoName(agent.repoRoot)})`}
              </option>
            ))}
            {ownBranch && <option value="">The repo&apos;s checked-out branch</option>}
          </Select>
        </Field>
      )}
      {role !== null && (
        <Hint>
          {roleNote(role, zone === undefined ? "the repo's" : `${zone.name}'s`)}{template !== undefined && ' The task is filled in from it.'}
          {reviews(role) && ' It starts on a detached checkout of that branch, in a worktree of its own.'}
        </Hint>
      )}
      {harness === 'codex' && zone !== undefined && (
        <>
          <Checkbox label="Skip Codex's hook review in this zone" checked={bypass} onChange={(event) => setBypass(event.target.checked)} />
          {!bypass && (
            <Hint>
              Codex asks you to review agent-board&apos;s hooks in the agent&apos;s terminal. Until you trust them, the
              tile stays idle.
            </Hint>
          )}
        </>
      )}
      {error && <ErrorText>{error}</ErrorText>}
    </Dialog>
  );
}
