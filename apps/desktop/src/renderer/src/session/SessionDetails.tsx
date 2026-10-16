import { useEffect, useState } from 'react';
import { neighbourOf, paneIds } from '@agent-board/daemon/pane-layout';
import { INTERRUPT_KEY, shortIssueId, TRACKER_PROVIDERS, type Agent, type ExternalSession, type PullRequest, type Shell, type SplitDirection } from '@agent-board/daemon/protocol';
import { Copy, FolderOpen, PanelLeftClose, PanelLeftOpen, RotateCw } from 'lucide-react';
import { clockBadge } from '../board/schedule';
import { checksLabel } from '../board/tile-footer';
import { agentSetupLine, branchLine } from '../board/AgentSetup';
import { useNow } from '../inbox/use-now';
import { errorMessage } from '../../../shared/errors';
import { keyText } from '../keys/registry';
import { STATE_LABELS } from '../states';
import { Button, Chip, ErrorText, Hint, IconButton, Kbd, PanelRow, Section, StatusPill } from '../ui';
import { gateBadge, shortCommit } from '@agent-board/daemon/gate-rules';
import { useGateRun } from '../gate/GatesProvider';
import { gated } from '../gate/gate-view';
import { requestTab } from './tab-request';
import { gateSurfaceOf } from './tabs';
import { runGateShortcut } from './window-keys';
import { useAction } from '../use-action';
import { sessionControls, type Control, type ControlId } from './controls';
import { useDetailsWidth } from './DetailsHandle';
import { CONTROL_ICONS, PANE_ICONS, SectionIcon, type SectionId } from './details-icons';
import { paneLabel } from '../board/rename';
import { insideWorktree, tildify, useLiveFolder } from './live-folder';
import { panesLabel } from './panes';

export interface SessionDetailsProps {
  /** The session the controls act on; none while a shell tile is still being listed. */
  sessionId: string | undefined;
  agent?: Agent;
  /** A session started outside the app: only what its hooks reported, and no controls (it has no terminal here). */
  external?: ExternalSession;
  shell?: Shell;
  /** For the tab showing, an agent's or a shell tile's: the focused pane, and how to focus another (e.g. a new one). */
  focusedPane?: string;
  onFocusPane?(sessionId: string): void;
  /** Splits the tab's focused pane: an agent's own tab the daemon keeps only once it is split. */
  onSplit?(direction: SplitDirection): void;
  live: boolean;
  /** Says why a control failed, or clears that with undefined when the next one starts. Must be stable. */
  onProblem(problem: string | undefined): void;
  /** Whether it is collapsed to an icon rail, and how to change that (⌘I). */
  collapsed: boolean;
  onCollapsed(collapsed: boolean): void;
  /** Opens a link in the OS browser: an issue, or a pull request with no PR tab to open. */
  onOpenLink(url: string): void;
  /** Opens one of the agent's pull requests in a PR tab (BI1). */
  onOpenPullRequest?(pr: PullRequest): void;
}

/**
 * The session window's details, on its LEFT (V and W): a strip of sections (controls, a shell's panes, the agent's
 * issue, worktree, pull requests, subagents and schedule) in the board menu's section style, or the
 * same collapsed to an icon rail, whose actions act and whose facts open the strip at their section.
 */
export function SessionDetails(props: SessionDetailsProps) {
  const { sessionId, agent, external, shell, focusedPane, onFocusPane, onSplit, live, onProblem, collapsed, onCollapsed, onOpenLink, onOpenPullRequest } = props;
  // In an agent's window, the agent's own pane, unless a shell pane in one of its tabs has the keyboard.
  const agentFocused = agent !== undefined && (focusedPane === undefined || focusedPane === agent.sessionId);
  const width = useDetailsWidth();
  const { busy, error, run } = useAction();
  useEffect(() => onProblem(error), [error, onProblem]);
  /** The section the rail last asked for, drawn open even if it was closed. */
  const [reveal, setReveal] = useState<SectionId>();

  const act = (id: ControlId) => {
    if (sessionId === undefined) return;
    run(actionFor(id, sessionId, agent));
  };
  const controls = external ? [] : sessionControls({ agent, live });
  const closePane = () => {
    if (shell === undefined || focusedPane === undefined) return;
    const neighbour = neighbourOf(shell.layout, focusedPane);
    run(async () => {
      await window.agentBoard.shells.closePane(shell.id, focusedPane).catch((failure: unknown) => {
        throw new Error(`could not close the pane: ${errorMessage(failure)}`);
      });
      if (neighbour !== undefined) onFocusPane?.(neighbour);
    });
  };
  const paneActions = onSplit !== undefined && [
    { label: 'Split horizontally', icon: PANE_ICONS.splitHorizontally, hint: 'Split inside the tab: a shell beside the focused pane', onClick: () => onSplit('horizontal') },
    { label: 'Split vertically', icon: PANE_ICONS.splitVertically, hint: 'Split inside the tab: a shell below the focused pane', onClick: () => onSplit('vertical') },
    // The agent's own pane is closed by nothing: Stop and Delete end the agent.
    ...(shell && !agentFocused ? [{ label: 'Close pane', icon: PANE_ICONS.closePane, hint: 'Close the focused pane, ending its shell', onClick: closePane }] : []),
  ];
  const open = (section: SectionId) => {
    setReveal(section);
    onCollapsed(false);
  };

  if (collapsed) {
    const fact = (section: SectionId, label: string) => (
      <IconButton key={section} icon={<SectionIcon id={section} />} aria-label={label} tooltip={label} onClick={() => open(section)} />
    );
    return (
      <nav className="session-details session-details-rail" aria-label="Session controls">
        {controls.map((control) => (
          <IconButton
            key={control.id}
            icon={CONTROL_ICONS[control.id]}
            variant={control.id === 'stop' ? 'danger' : 'ghost'}
            aria-label={control.label}
            tooltip={control.hint}
            disabled={!control.enabled || busy}
            onClick={() => act(control.id)}
          />
        ))}
        {paneActions &&
          paneActions.map((action) => (
            <IconButton key={action.label} icon={action.icon} aria-label={action.label} tooltip={action.hint} disabled={busy} onClick={action.onClick} />
          ))}
        {agent && (
          <>
            <span className="details-rail-separator" aria-hidden />
            {fact('issue', agent.issue ? `Issue ${agent.issue.id}` : 'Issue')}
            {fact('worktree', 'Worktree and branch')}
            {fact('pulls', pullsLabel(agent))}
            {gated(agent) && fact('gate', 'Merge gate')}
            {fact('subagents', subagentsLabel(agent))}
            {fact('schedule', 'Schedule')}
          </>
        )}
        {external && (
          <>
            {fact('status', 'Status file')}
            {fact('worktree', 'Folder')}
            {fact('subagents', subagentsLabel(external))}
          </>
        )}
        <span className="details-rail-fill" />
        <IconButton icon={<PanelLeftOpen />} aria-label="Show details" tooltip={<>Show details<Kbd>{keyText('window.details')}</Kbd></>} onClick={() => onCollapsed(false)} />
      </nav>
    );
  }

  /** The section's props: its id, and drawn open while the rail just asked for it. */
  const sectionProps = (id: SectionId) => (reveal === id ? { open: true, onOpenChange: () => setReveal(undefined) } : {});
  return (
    <aside className="session-details" aria-label="Session details" style={{ width }}>
      <div className="session-details-head">
        <span className="session-details-title">Details</span>
        <Kbd>{keyText('window.details')}</Kbd>
        <IconButton icon={<PanelLeftClose />} size="sm" aria-label="Hide details" tooltip="Collapse to an icon rail" onClick={() => onCollapsed(true)} />
      </div>
      <div className="session-details-sections">
        {!external && (
        <nav aria-label="Session controls">
          <Section label="Controls" {...sectionProps('controls')}>
            <div className="session-controls">
              {controls.map((control) => (
                <ControlButton key={control.id} control={control} busy={busy} onClick={() => act(control.id)} />
              ))}
            </div>
          </Section>
          {paneActions && (
            <Section label="Panes" meta={paneCount(shell?.layout)} {...sectionProps('panes')}>
              <div className="session-controls session-controls-column">
                {paneActions.map((action) => (
                  <Button key={action.label} size="sm" className="session-control" icon={action.icon} disabled={busy} title={action.hint} onClick={action.onClick}>
                    {action.label}
                  </Button>
                ))}
              </div>
            </Section>
          )}
        </nav>
        )}
        {(shell || agent) && (
          <LiveFolder
            // An ended agent's pane is the shell it dropped into, while that runs.
            sessionId={agentFocused ? (agent.shellSessionId ?? sessionId) : focusedPane}
            worktree={agent?.worktree}
            fallback={agentFocused ? agent.cwd : focusedPane === undefined ? undefined : shell?.paneFolders[focusedPane]}
            pane={!agentFocused && shell && paneIds(shell.layout).length > 1 && focusedPane !== undefined ? (paneLabel(shell, focusedPane) ?? shell.name) : undefined}
            onProblem={onProblem}
          />
        )}
        {agent && <AgentSections agent={agent} sectionProps={sectionProps} onOpenLink={onOpenLink} onOpenPullRequest={onOpenPullRequest ?? ((pr) => onOpenLink(pr.url))} />}
        {external && <ExternalSections session={external} sectionProps={sectionProps} />}
      </div>
    </aside>
  );
}

/** The home folder, for writing paths with `~`; undefined until the daemon says. */
export function useHomeDir(): string | undefined {
  const [home, setHome] = useState<string>();
  useEffect(() => {
    window.agentBoard.daemonHealth().then((health) => setHome(health.homeDir), () => {});
  }, []);
  return home;
}

/**
 * The focused pane's folder now, following `cd` and the focus; for an agent beside its fixed worktree, with a
 * hint when it has left that. Copyable, and opens in the file manager.
 */
function LiveFolder({
  sessionId,
  worktree,
  fallback,
  pane,
  onProblem,
}: {
  sessionId: string | undefined;
  worktree: string | undefined;
  /** What to show until the first lookup answers: where it started, or was last seen. */
  fallback: string | undefined;
  pane: string | undefined;
  onProblem(problem: string | undefined): void;
}) {
  const folder = useLiveFolder(sessionId) ?? fallback;
  const home = useHomeDir();
  const outside = folder !== undefined && worktree !== undefined && !insideWorktree(folder, worktree);
  return (
    <Section label="Folder (live)" icon={<SectionIcon id="worktree" />} meta={pane}>
      {folder === undefined ? (
        <Hint>Looking…</Hint>
      ) : (
        <>
          <p className="details-mono" data-testid="details-folder" title={folder}>
            {tildify(folder, home)}
          </p>
          {outside && (
            <Hint data-testid="details-outside-worktree">Outside its worktree</Hint>
          )}
          <div className="details-folder-actions">
            <IconButton
              icon={<Copy />}
              size="sm"
              aria-label="Copy folder"
              tooltip="Copy the folder's path"
              onClick={() => void navigator.clipboard.writeText(folder).catch((error: unknown) => onProblem(`could not copy: ${errorMessage(error)}`))}
            />
            <IconButton
              icon={<FolderOpen />}
              size="sm"
              aria-label="Open folder in Finder"
              tooltip="Open in Finder"
              onClick={() => void window.agentBoard.sessions.openFolder(folder).catch((error: unknown) => onProblem(`could not open the folder: ${errorMessage(error)}`))}
            />
          </div>
        </>
      )}
    </Section>
  );
}

function AgentSections({
  agent,
  sectionProps,
  onOpenLink,
  onOpenPullRequest,
}: {
  agent: Agent;
  sectionProps(id: SectionId): { open?: boolean; onOpenChange?(open: boolean): void };
  onOpenLink(url: string): void;
  onOpenPullRequest(pr: PullRequest): void;
}) {
  const { issue, pullRequests, subagents, schedule } = agent;
  const now = useNow(schedule !== null);
  const badge = schedule && clockBadge(schedule, agent.endedAt !== null, new Date(now));
  const active = subagents.filter((subagent) => subagent.state !== 'done' && subagent.state !== 'failed').length;
  return (
    <>
      <Section label="Issue" icon={<SectionIcon id="issue" />} meta={issue === null ? 'None' : TRACKER_PROVIDERS[issue.provider].name} {...sectionProps('issue')}>
        {issue === null ? (
          <Hint>No linked issue. Link one from its tile&rsquo;s More menu.</Hint>
        ) : (
          <div className="details-issue">
            <Chip tone="accent" mono title={`Open ${issue.id} in ${TRACKER_PROVIDERS[issue.provider].name}`} onClick={() => onOpenLink(issue.url)}>
              {shortIssueId(issue)}
            </Chip>
            <span className="details-issue-title">{issue.title}</span>
          </div>
        )}
      </Section>
      <Section label="Last message" meta={agent.lastMessage ? undefined : 'None'}>
        {agent.lastMessage ? (
          <p className="details-message" data-testid="details-last-message">
            {agent.lastMessage}
          </p>
        ) : (
          <Hint>It hasn&rsquo;t said anything yet.</Hint>
        )}
      </Section>
      <Section label="Worktree and branch" icon={<SectionIcon id="worktree" />} meta={worktreeName(agent.worktree)} {...sectionProps('worktree')}>
        <p className="details-mono details-branch" title={branchLine(agent)}>
          {branchLine(agent)}
        </p>
        {(agent.model !== null || agent.role !== null) && <p className="details-soft">{agentSetupLine(agent)}</p>}
        <p className="details-mono details-soft" title={agent.worktree}>
          {agent.worktree}
        </p>
      </Section>
      <Section label="PR and checks" icon={<SectionIcon id="pulls" />} meta={pullRequests.length === 0 ? 'None' : String(pullRequests.length)} {...sectionProps('pulls')}>
        {pullRequests.length === 0 ? (
          <Hint>No pull request from its branch yet.</Hint>
        ) : (
          <ul className="details-list">
            {pullRequests.map((pr) => (
              <li key={pr.number}>
                <PanelRow
                  as="button"
                  title="Open it in a PR tab"
                  onClick={() => onOpenPullRequest(pr)}
                  mark={<SectionIcon id="pulls" className="details-row-icon" />}
                  name={`#${pr.number} ${pr.title}`}
                  meta={`${pr.state} · ${checksLabel(pr)}`}
                />
              </li>
            ))}
          </ul>
        )}
      </Section>
      {gated(agent) && <GateSection agent={agent} sectionProps={sectionProps} />}
      <Section
        label="Subagents"
        icon={<SectionIcon id="subagents" />}
        meta={subagents.length === 0 ? 'None' : `${active} active · ${subagents.length - active} done`}
        {...sectionProps('subagents')}
      >
        {subagents.length === 0 ? (
          <Hint>None</Hint>
        ) : (
          <ul className="details-list">
            {subagents.map((subagent) => (
              <PanelRow
                key={subagent.id}
                as="li"
                data-testid="session-subagent"
                title={subagent.result ?? undefined}
                mark={<SectionIcon id="subagents" className="details-row-icon" />}
                name={subagent.type}
                end={<StatusPill state={subagent.state} label={STATE_LABELS[subagent.state]} />}
              />
            ))}
          </ul>
        )}
      </Section>
      <Section label="Schedule" icon={<SectionIcon id="schedule" />} meta={badge === null ? 'None' : badge.label} defaultOpen={false} {...sectionProps('schedule')}>
        {schedule === null ? (
          <Hint>Runs only when you message it. Schedule it from its tile&rsquo;s More menu.</Hint>
        ) : (
          <>
            <p className="details-mono">{schedule.cron}</p>
            <Hint>{badge?.title}</Hint>
          </>
        )}
      </Section>
    </>
  );
}

/**
 * The agent's merge gate (BL1): its last run in a word, on which commit, and Run gate, which shows the run in a
 * Gate tab in the focused pane, as the tile's badge and ⌘⇧G do.
 */
function GateSection({ agent, sectionProps }: { agent: Agent; sectionProps(id: SectionId): { open?: boolean; onOpenChange?(open: boolean): void } }) {
  const run = useGateRun(agent.sessionId);
  const { busy, error, run: act } = useAction();
  const openTab = () => requestTab(agent.sessionId, gateSurfaceOf(agent.sessionId));
  return (
    <Section label="Gate" icon={<SectionIcon id="gate" />} meta={run === undefined ? 'Not run' : gateBadge(run)} {...sectionProps('gate')}>
      {run === undefined ? (
        <Hint>Runs its zone&rsquo;s gate command in its worktree, only when you ask.</Hint>
      ) : (
        <PanelRow
          as="button"
          title="Open its Gate tab"
          onClick={openTab}
          mark={<SectionIcon id="gate" className="details-row-icon" />}
          name={gateBadge(run)}
          meta={`on ${shortCommit(run.commit)}`}
          data-testid="details-gate"
        />
      )}
      <div className="session-controls">
        <Button
          size="sm"
          className="session-control"
          icon={<RotateCw />}
          disabled={busy || run?.status === 'running'}
          title={`Run its zone's gate command in its worktree (${runGateShortcut()})`}
          onClick={() =>
            act(async () => {
              openTab();
              await window.agentBoard.gates.run(agent.sessionId);
            })
          }
          data-testid="details-run-gate"
        >
          {run === undefined ? 'Run gate' : 'Run again'}
        </Button>
      </div>
      {error !== undefined && <ErrorText>{error}</ErrorText>}
    </Section>
  );
}

/** An external session's details: what its hooks and status file told the board. */
function ExternalSections({
  session,
  sectionProps,
}: {
  session: ExternalSession;
  sectionProps(id: SectionId): { open?: boolean; onOpenChange?(open: boolean): void };
}) {
  const { status } = session;
  return (
    <>
      <Section label="Status file" icon={<SectionIcon id="status" />} meta={status?.state ?? 'None'} {...sectionProps('status')}>
        {status === null ? (
          <Hint>Its worktree has no status file from this session.</Hint>
        ) : (
          <>
            <p className="details-message" data-testid="details-status">
              {status.summary}
            </p>
            {status.handover && <p className="details-mono details-soft">handover {status.handover}</p>}
            {status.reviewDoc && <p className="details-mono details-soft">review {status.reviewDoc}</p>}
          </>
        )}
      </Section>
      <Section label="First prompt">{session.description ? <p className="details-message">{session.description}</p> : <Hint>Not seen yet.</Hint>}</Section>
      <Section label="Folder" icon={<SectionIcon id="worktree" />} {...sectionProps('worktree')}>
        {session.branch !== null && <p className="details-mono details-branch">{session.branch}</p>}
        <p className="details-mono details-soft" title={session.worktree ?? session.cwd}>
          {session.worktree ?? session.cwd}
        </p>
      </Section>
      <Section label="Subagents" icon={<SectionIcon id="subagents" />} meta={session.subagents.length === 0 ? 'None' : String(session.subagents.length)} {...sectionProps('subagents')}>
        {session.subagents.length === 0 ? (
          <Hint>None</Hint>
        ) : (
          <ul className="details-list">
            {session.subagents.map((subagent) => (
              <PanelRow
                key={subagent.id}
                as="li"
                mark={<SectionIcon id="subagents" className="details-row-icon" />}
                name={subagent.type}
                end={<StatusPill state={subagent.state} label={STATE_LABELS[subagent.state]} />}
              />
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}

function ControlButton({ control, busy, onClick }: { control: Control; busy: boolean; onClick(): void }) {
  return (
    <Button
      size="sm"
      variant={control.id === 'stop' ? 'danger' : 'secondary'}
      className="session-control"
      icon={CONTROL_ICONS[control.id]}
      disabled={!control.enabled || busy}
      title={control.hint}
      onClick={onClick}
    >
      {control.label}
    </Button>
  );
}

/** The worktree's folder name, for its section's heading: the full path is under it. */
const worktreeName = (worktree: string) => worktree.split('/').filter(Boolean).at(-1) ?? worktree;

const paneCount = (layout: Shell['layout'] | undefined) => panesLabel(layout === undefined ? 1 : paneIds(layout).length);

function pullsLabel(agent: Agent): string {
  const failing = agent.pullRequests.filter((pr) => pr.checks === 'failing').length;
  if (agent.pullRequests.length === 0) return 'Pull requests: none';
  return `Pull requests: ${agent.pullRequests.length}${failing > 0 ? `, ${failing} failing` : ''}`;
}

function subagentsLabel(agent: Pick<Agent, 'subagents'>): string {
  return agent.subagents.length === 0 ? 'Subagents: none' : `Subagents: ${agent.subagents.length}`;
}

/**
 * What a control does: the agent's daemon call, or for a shell, the keystroke or kill. Its failure says which control
 * failed.
 */
function actionFor(id: ControlId, sessionId: string, agent: Agent | undefined): () => Promise<unknown> {
  const { agents, sessions } = window.agentBoard;
  const failing = (verb: string, action: () => Promise<unknown>) => () =>
    action().catch((failure: unknown) => {
      throw new Error(`could not ${verb}: ${errorMessage(failure)}`);
    });
  switch (id) {
    case 'interrupt':
      return failing('interrupt', agent ? () => agents.interrupt(sessionId) : async () => sessions.write(sessionId, INTERRUPT_KEY));
    case 'stop':
      return failing('stop', agent ? () => agents.stop(sessionId) : () => sessions.kill(sessionId));
  }
}
