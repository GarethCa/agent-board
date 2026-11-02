import { useEffect, useSyncExternalStore, type ReactNode } from 'react';
import { shortIssueId, type Agent, type PullRequest, type SplitDirection } from '@agent-board/daemon/protocol';
import { HUMAN_STATUS_LABELS, humanStatus } from '@agent-board/daemon/human-status';
import type { Surface } from '@agent-board/daemon/window-layout';
import { Bot, ChevronDown, ChevronRight, ClipboardList, Clock, FileText, Folder, FolderOpen, GitBranch, GitPullRequest, Globe, ListTodo, Pin, Sparkles, StickyNote, Workflow } from 'lucide-react';
import { agentSetupLine, branchLine } from '../board/AgentSetup';
import { clockBadge } from '../board/schedule';
import { useNow } from '../inbox/use-now';
import { useNeedsYouShows } from '../needs-you-setting';
import { storedValue, type StoredValue } from '../stored-value';
import { useAction } from '../use-action';
import { useTechnicalDetails } from '../technical';
import { shortWhen } from '../when';
import { errorMessage } from '../../../shared/errors';
import { useDetailsWidth } from './DetailsHandle';
import { moreDetailsCounts, moreDetailsLabel, pullRequestRows, startedBy, statusLine } from './inspector';
import { insideWorktree, tildify, useLiveFolder } from './live-folder';
import { crewSection, docSection, documentSection, pinSection, subagentSection, type PinRow } from './sidebar-records';
import { docName, docSurfaceOf, documentSurfaceOf, planSurfaceOf } from './tabs';
import { controlAction, useHomeDir } from './SessionDetails';
import { sessionControls } from './controls';
import { CONTROL_ICONS, PANE_ICONS } from './details-icons';
import { useLiveAgents } from './use-live-board';

export interface SimplifiedInspectorProps {
  agent: Agent;
  /** Says why something it did failed. Must be stable. */
  onProblem(problem: string | undefined): void;
  /** Opens a link in the OS browser: its linked issue. */
  onOpenLink(url: string): void;
  /** Opens one of its pull requests, in a PR tab where it can. */
  onOpenPullRequest(pr: Pick<PullRequest, 'url'>): void;
  /** Shows a surface as a tab of the window: a hand-off doc, a document, or an agent of its crew. */
  onOpenSurface?(surface: Surface): void;
  /** Shows a pinned link in a web tab of the window. */
  onOpenWeb(url: string): void;
  /**
   * Under Classic, whose header has no Stop, Wake or ⋯ of the agent's: its window's controls (Interrupt, Pause or Wake,
   * Stop, and splitting the tab), listed at the end of More details. The Simplified design's header has them instead.
   */
  controls?: { live: boolean; onSplit?(direction: SplitDirection): void };
}

/** Whether "More details" is open, one choice for every inspector. */
const moreOpen = storedValue('agent-board.inspector-more');
/** Whether "Technical details" is open, one choice for every inspector. */
const technicalOpen = storedValue('agent-board.inspector-technical');

/**
 * An agent's inspector, at its window's trailing edge: the Simplified design's sidebar, and
 * Classic's when its Agent sidebar setting is Simple. The work comes first: a line with what the header's status leaves
 * out, then its task when linked and its pull requests. Then two folds, closed and remembered: Technical details
 * (branch, folder, AI and model), drawn only while technical details show, and More details, naming what it holds (its
 * crew, hand-off docs, documents, pins, subagents and schedule, and under Classic its window's controls). A fold with
 * nothing in it doesn't show. Classic's Full sidebar is its details strip (SessionDetails.tsx).
 */
export function SimplifiedInspector({ agent, onProblem, onOpenLink, onOpenPullRequest, onOpenSurface, onOpenWeb, controls }: SimplifiedInspectorProps) {
  const width = useDetailsWidth();
  const shows = useNeedsYouShows();
  const technical = useTechnicalDetails();
  const { agents = [] } = useLiveAgents();
  const reading = humanStatus(agent, shows);
  const pulls = pullRequestRows(agent);
  const counts = moreDetailsCounts(agent, agents);
  const more = moreDetailsLabel(counts);
  return (
    <aside className="inspector" aria-label="Inspector" data-testid="inspector" style={{ width }}>
      <p className="inspector-status-line" data-testid="inspector-status-line">
        {statusLine(reading.detail, startedBy(agent, agents), shortWhen(agent.createdAt))}
      </p>
      <InspectorGroup label="Work">
        {agent.issue !== null && (
          <InspectorRow icon={<ListTodo />} name="Task" end={`${shortIssueId(agent.issue)} ↗`} title={`${agent.issue.title}: opens in your browser`} onClick={() => onOpenLink(agent.issue!.url)} />
        )}
        {pulls.length === 0 ? (
          <InspectorRow icon={<GitPullRequest />} name="Pull request" end="not yet" />
        ) : (
          pulls.map((row) => <InspectorRow key={row.key} icon={<GitPullRequest />} name={row.name} end={row.checks} title="Open it in a PR tab" onClick={() => onOpenPullRequest(row)} />)
        )}
      </InspectorGroup>
      {technical && (
        <InspectorFold label="Technical details" stored={technicalOpen}>
          <TechnicalDetails agent={agent} onProblem={onProblem} />
        </InspectorFold>
      )}
      {(more !== undefined || controls !== undefined) && (
        <InspectorFold label="More details" stored={moreOpen} count={more}>
          <MoreDetails agent={agent} agents={agents} onProblem={onProblem} onOpenSurface={onOpenSurface} onOpenWeb={onOpenWeb} />
          {controls && <WindowControls agent={agent} live={controls.live} onSplit={controls.onSplit} onProblem={onProblem} />}
        </InspectorFold>
      )}
    </aside>
  );
}

/** The work's rows, first and with no heading: its region keeps its name for a screen reader. */
function InspectorGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="inspector-group" aria-label={label}>
      <ul className="inspector-rows">{children}</ul>
    </section>
  );
}

/** A fold of the inspector, open or closed as it last was in any window; closed, it names what it holds when it says. */
function InspectorFold({ label, stored, count, children }: { label: string; stored: StoredValue; count?: string; children: ReactNode }) {
  const open = useSyncExternalStore(stored.subscribe, () => stored.get() === 'open');
  return (
    <section className="inspector-more" aria-label={label} data-open={open}>
      <button type="button" className="inspector-more-head" aria-expanded={open} onClick={() => stored.set(open ? undefined : 'open')}>
        {open ? <ChevronDown aria-hidden /> : <ChevronRight aria-hidden />}
        <b>{open || count === undefined ? label : `${label}:`}</b>
        {!open && count !== undefined && <span data-testid="inspector-more-count"> {count}</span>}
      </button>
      {open && children}
    </section>
  );
}

/** A short row: an icon, its name and a fact at its end; a button when it opens or does something, dimmed while it can't. */
function InspectorRow({
  icon,
  name,
  end,
  title,
  onClick,
  disabled = false,
  mono = false,
  testId,
}: {
  icon: ReactNode;
  name: ReactNode;
  end?: ReactNode;
  title?: string;
  onClick?: () => void;
  disabled?: boolean;
  mono?: boolean;
  testId?: string;
}) {
  const body = (
    <>
      <span className="inspector-row-icon" aria-hidden>
        {icon}
      </span>
      <span className="inspector-row-name" data-mono={mono || undefined}>
        {name}
      </span>
      {end !== undefined && <span className="inspector-row-end">{end}</span>}
    </>
  );
  return (
    <li className="inspector-row-item" data-testid={testId}>
      {onClick ? (
        <button type="button" className="inspector-row" title={title} disabled={disabled} onClick={onClick}>
          {body}
        </button>
      ) : (
        <div className="inspector-row" title={title}>
          {body}
        </div>
      )}
    </li>
  );
}

/** Its branch, its folder now (copied, or revealed in Finder; said when it has left its worktree) and its AI, model and role: only while technical details show. */
function TechnicalDetails({ agent, onProblem }: { agent: Agent; onProblem(problem: string | undefined): void }) {
  const folder = useLiveFolder(agent.shellSessionId ?? agent.sessionId) ?? agent.cwd;
  const home = useHomeDir();
  const copy = () => void navigator.clipboard.writeText(folder).catch((error: unknown) => onProblem(`could not copy: ${errorMessage(error)}`));
  const outside = !insideWorktree(folder, agent.worktree);
  const reveal = () => void window.agentBoard.sessions.revealFolder(folder).catch((error: unknown) => onProblem(`could not reveal the folder: ${errorMessage(error)}`));
  return (
    <ul className="inspector-rows">
      <InspectorRow icon={<GitBranch />} name={<span className="inspector-branch">{branchLine(agent)}</span>} title={branchLine(agent)} mono />
      <InspectorRow
        icon={<Folder />}
        testId="inspector-folder-row"
        name={<span className="inspector-folder">{tildify(folder, home)}</span>}
        end={outside ? 'Outside its worktree · Copy' : 'Copy'}
        title={`${folder}: copy its path`}
        onClick={copy}
        mono
      />
      <InspectorRow icon={<FolderOpen />} name="Reveal in Finder" title={`${folder}: show it in Finder`} onClick={reveal} />
      <InspectorRow icon={<Sparkles />} name={agentSetupLine(agent)} />
    </ul>
  );
}

/** What the fold holds, each a short row that opens its item as the details strip's did. */
function MoreDetails({
  agent,
  agents,
  onProblem,
  onOpenSurface,
  onOpenWeb,
}: {
  agent: Agent;
  agents: readonly Agent[];
  onProblem(problem: string | undefined): void;
  onOpenSurface: ((surface: Surface) => void) | undefined;
  onOpenWeb(url: string): void;
}) {
  const shows = useNeedsYouShows();
  const { schedule } = agent;
  const now = useNow(schedule !== null);
  const badge = schedule && clockBadge(schedule, agent.endedAt !== null, new Date(now));
  const crew = crewSection(agent, agents).rows;
  const docs = docSection(agent).rows;
  const documents = documentSection(agent);
  const pins = pinSection(agent).rows;
  const subagents = subagentSection(agent).rows;
  const openPin = ({ target, opens }: PinRow): (() => void) | undefined => {
    if (target.kind === 'link') return () => onOpenWeb(target.url);
    if (target.kind !== 'file') return undefined;
    if (opens === 'doc') return onOpenSurface && (() => onOpenSurface(docSurfaceOf(agent.sessionId, target.path)));
    return () => void window.agentBoard.sessions.revealFile(target.path).catch((error: unknown) => onProblem(`could not show the file: ${errorMessage(error)}`));
  };
  return (
    <ul className="inspector-rows">
      {crew.map(({ key, item }) => {
        const member = agents.find((each) => each.sessionId === item.sessionId);
        const status = member && humanStatus(member, shows).status;
        return (
          <InspectorRow
            key={key}
            icon={<Bot />}
            testId="inspector-crew"
            name={item.name}
            end={status && HUMAN_STATUS_LABELS[status]}
            title="Show it in a tab here"
            onClick={onOpenSurface && (() => onOpenSurface({ kind: 'session', target: { kind: 'agent', id: item.sessionId } }))}
          />
        );
      })}
      {docs.map(({ key, item }) => (
        <InspectorRow key={key} icon={<FileText />} testId="inspector-doc" name={docName(item.path)} end="hand-off" title={`${item.path}: opens in a Doc tab`} onClick={onOpenSurface && (() => onOpenSurface(docSurfaceOf(agent.sessionId, item.path)))} />
      ))}
      {documents.map((row) => (
        <InspectorRow
          key={row.key}
          icon={row.kind === 'plan' ? <ClipboardList /> : <FileText />}
          testId="inspector-document"
          name={row.name}
          end={`v${row.version}`}
          title={row.kind === 'plan' ? 'Open its Plan tab' : `${row.document.path}: opens in its Document tab`}
          onClick={onOpenSurface && (() => onOpenSurface(row.kind === 'plan' ? planSurfaceOf(agent.sessionId) : documentSurfaceOf(row.document)))}
        />
      ))}
      {pins.map(({ key, item }) => (
        <InspectorRow
          key={key}
          icon={item.target.kind === 'note' ? <StickyNote /> : item.target.kind === 'link' ? <Globe /> : <Pin />}
          testId="inspector-pin"
          name={item.name}
          title={item.target.kind === 'note' ? item.target.text : undefined}
          onClick={openPin(item)}
        />
      ))}
      {subagents.map(({ key, item }) => (
        <InspectorRow key={key} icon={<Workflow />} name={item.type} title={item.result ?? undefined} />
      ))}
      {badge && <InspectorRow icon={<Clock />} name="Schedule" end={badge.label} title={badge.title} />}
    </ul>
  );
}

/**
 * Its window's controls, as the Full sidebar's Controls and Panes sections have them: Interrupt, Pause or Wake, Stop,
 * then splitting the tab beside or below. Under Classic only (see `controls`).
 */
function WindowControls({ agent, live, onSplit, onProblem }: { agent: Agent; live: boolean; onSplit?(direction: SplitDirection): void; onProblem(problem: string | undefined): void }) {
  const { busy, error, run } = useAction();
  useEffect(() => onProblem(error), [error, onProblem]);
  return (
    <ul className="inspector-rows" aria-label="Controls">
      {sessionControls({ agent, live }).map((control) => (
        <InspectorRow
          key={control.id}
          icon={CONTROL_ICONS[control.id]}
          name={control.label}
          title={control.hint}
          disabled={!control.enabled || busy}
          onClick={() => run(controlAction(control.id, agent.sessionId, agent))}
        />
      ))}
      {onSplit && (
        <>
          <InspectorRow icon={PANE_ICONS.splitHorizontally} name="Split horizontally" title="Split inside the tab: a shell beside the focused pane" onClick={() => onSplit('horizontal')} />
          <InspectorRow icon={PANE_ICONS.splitVertically} name="Split vertically" title="Split inside the tab: a shell below the focused pane" onClick={() => onSplit('vertical')} />
        </>
      )}
    </ul>
  );
}
