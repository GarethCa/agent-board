import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { roleLabel, shortIssueId, TRACKER_PROVIDERS, type Agent, type GateRun, type NeedsYouShows, type PageBlock, type PageIcon, type PageLink, type PageTone, type PullRequest } from '@agent-board/daemon/protocol';
import { HUMAN_STATUS_LABELS, humanStatus, type HumanStatus } from '@agent-board/daemon/human-status';
import { shortCommit } from '@agent-board/daemon/gate-rules';
import { cronWords } from '@agent-board/daemon/cron';
import type { Surface } from '@agent-board/daemon/window-layout';
import {
  Activity,
  ArrowUpRight,
  BookOpen,
  Bot,
  CalendarClock,
  Check,
  ChevronDown,
  CircleAlert,
  CircleDot,
  ClipboardList,
  Clock,
  Copy,
  Cpu,
  FileStack,
  FileText,
  FolderGit2,
  FolderOpen,
  GitBranch,
  GitMerge,
  GitPullRequest,
  Globe,
  Maximize2,
  MessageCircleQuestionMark,
  Package,
  PanelLeftClose,
  PanelLeftOpen,
  Pin,
  RotateCw,
  Shield,
  ShieldCheck,
  ShieldX,
  StickyNote,
  UsersRound,
  Workflow,
  X,
  type LucideIcon,
} from 'lucide-react';
import { branchLine, shelvesSetupLine } from '../board/AgentSetup';
import { clockBadge } from '../board/schedule';
import { checksLabel } from '../board/tile-footer';
import { keyText } from '../keys/registry';
import { IconButton, Kbd, Tooltip } from '../ui';
import { shortWhen } from '../when';
import { PAGE_ICON_COMPONENTS } from './page-icons';
import { useShelfFold, type ShelfGroupId } from './shelf-folds';
import { clockMeta, crewNeedingYou, crewStatus, foldCue, type FoldCue, folderMeta, gateWords, ICON_TABS_BELOW, pageProgress, planMeta, pullRequestsToWatch, sentenceCase, startedBy, statusLine, shortFolder, subagentStatus, nowCard, shelfShown, shelfTabs, type ShelfId, type ShelfTab } from './shelves';
import { tildify } from './live-folder';
import { pinOpener, recordedWhen, RecordList, type RecordDeletes } from './RecordList';
import { crewSection, docSection, documentSection, isDocFile, pinSection, pullRequestSection, subagentSection, type PullRequestRow, type SidebarRow } from './sidebar-records';
import { docName, docSurfaceOf, documentSurfaceOf, planSurfaceOf } from './tabs';

/** What a shelf's rows do when clicked: where each opens, and the folder's copy and reveal. */
export interface ShelfActions {
  /** Opens a link in the OS browser: its linked issue. */
  openLink(url: string): void;
  /** Opens one of its pull requests, in a PR tab where it can. */
  openPullRequest(pr: Pick<PullRequest, 'url'>): void;
  /** Shows a surface as a tab of the window: a hand-off doc, a document, its plan, a Doc tab, or an agent of its crew. */
  openSurface?(surface: Surface): void;
  /** Shows a link in a web tab of the window. */
  openWeb(url: string): void;
  /** Shows a file in its folder. */
  revealFile(path: string): void;
  copyFolder(folder: string): void;
  revealFolder(folder: string): void;
  /** Runs its merge gate, for one that has one (Setup's Run again). */
  runGate?(): void;
}

/** What the shelves draw besides the agent: the board, and what the window reads live. */
interface ShelvesData {
  agent: Agent;
  /** Every agent on the board: its crew's, and who started it. */
  agents: readonly Agent[];
  shows: NeedsYouShows;
  /** Whether the technical layer shows: always under Classic, under the Simplified design with its switch. */
  technical: boolean;
  /** Its folder now, following `cd`. */
  folder: string;
  home: string | undefined;
  /** Its latest gate run, for one with a gate; null for one without (no gate rows). */
  gate: GateRun | undefined | null;
  now: Date;
  records: RecordDeletes;
  actions: ShelfActions;
}

interface ShelvesProps extends ShelvesData {
  /** The sidebar's width, which the window's handle sets: narrow, the tabs show only their icons. */
  width: number;
  /** Collapsed to the rail (⌘I), and how to change that. */
  collapsed: boolean;
  onCollapsed(collapsed: boolean): void;
  /** The shelf to open on; the page unless said (the gallery opens others). */
  initialShelf?: ShelfId;
  /** On the rail, a peek open as the window is drawn (the gallery's). */
  initialPeek?: ShelfId;
}

/**
 * An agent's sidebar: a row of shelves as icon tabs, opening on the agent's own page,
 * with Made, Crew and Setup a tab away and a two-line workspace footer. A shelf with nothing in it has no tab. The page's
 * tab has the name and icon the agent picked; until it writes a page, the tab is the board's Now.
 */
export function AgentShelves({ width, collapsed, onCollapsed, initialShelf = 'page', initialPeek, ...data }: ShelvesProps) {
  const { agent, agents, shows, technical, records } = data;
  const tabs = shelfTabs(agent, agents, shows, { technical, fading: records.fading });
  const [asked, setAsked] = useState<ShelfId>(initialShelf);
  const on = shelfShown(asked, tabs);
  // A shelf that lost its tab is let go: the page shows, and stays when the tab comes back.
  useEffect(() => {
    if (on !== asked) setAsked(on);
  }, [on, asked]);
  const iconsOnly = width < ICON_TABS_BELOW;
  const ids = useId();
  const tabId = (shelf: ShelfId) => `${ids}-tab-${shelf}`;
  if (collapsed) return <ShelvesRail {...data} tabs={tabs} initialPeek={initialPeek} onShowShelves={() => onCollapsed(false)} onOpen={(shelf) => (setAsked(shelf), onCollapsed(false))} />;
  return (
    <aside className="agent-shelves" aria-label="Agent sidebar" data-testid="agent-shelves" style={{ width }} data-icons-only={iconsOnly || undefined}>
      {/* A row of one tab has no choice to offer: the page shows under no tabs until a second shelf has something, its
          name and icon then a header of their own. */}
      {tabs.length > 1 ? (
        <ShelfTabRow tabs={tabs} on={on} iconsOnly={iconsOnly} onPick={setAsked} tabId={tabId} panelId={`${ids}-panel`} />
      ) : (
        agent.page !== null && <PageHeader name={agent.page.name} icon={agent.page.icon} />
      )}
      <div className="agent-shelves-body" {...(tabs.length > 1 ? { role: 'tabpanel', 'aria-labelledby': tabId(on) } : {})} id={`${ids}-panel`} data-shelf={on}>
        <ShelfBody {...data} shelf={on} narrow={iconsOnly} onShelf={setAsked} />
      </div>
      {technical && <WorkspaceFooter {...data} onCollapse={() => onCollapsed(true)} />}
    </aside>
  );
}

/** One shelf's rows, in the shelves or in a peek. */
function ShelfBody({ shelf, narrow, onShelf, ...data }: ShelvesData & { shelf: ShelfId; narrow: boolean; onShelf(shelf: ShelfId): void }) {
  switch (shelf) {
    case 'page':
      return <PageShelf {...data} narrow={narrow} onShelf={onShelf} />;
    case 'made':
      return <MadeShelf {...data} />;
    case 'crew':
      return <CrewShelf {...data} narrow={narrow} />;
    case 'setup':
      return <SetupShelf {...data} narrow={narrow} />;
  }
}

/** A shelf's icon: the page's the agent picked, else the board's Now's pulse; the others the board's fixed ones. */
function shelfIcon(tab: Pick<ShelfTab, 'id' | 'icon'>): LucideIcon {
  if (tab.id === 'page') return tab.icon === undefined ? Activity : PAGE_ICON_COMPONENTS[tab.icon];
  return tab.id === 'made' ? Package : tab.id === 'crew' ? UsersRound : FolderGit2;
}

/** The robot mark: the agent, not the board, picked or put this here. */
function AgentMark({ title = 'Put here by the agent' }: { title?: string }) {
  return (
    <span className="agent-shelves-agent-mark" title={title} aria-label={title} role="img">
      <Bot aria-hidden />
    </span>
  );
}

/** The page's name and icon as the agent picked them, with the robot mark: its tab's, drawn alone when it is the one shelf. */
function PageHeader({ name, icon }: { name: string; icon: PageIcon }) {
  const Icon = PAGE_ICON_COMPONENTS[icon];
  return (
    <h2 className="agent-shelves-page-head" data-testid="page-head">
      <Icon aria-hidden />
      <span className="agent-shelves-tab-label">{name}</span>
      <AgentMark title="Its icon and name, picked by the agent" />
    </h2>
  );
}

/** The tabs: each shelf's icon and name (only the icon when narrow, its name the tooltip), a count or a dot. */
function ShelfTabRow({ tabs, on, iconsOnly, onPick, tabId, panelId }: { tabs: readonly ShelfTab[]; on: ShelfId; iconsOnly: boolean; onPick(shelf: ShelfId): void; tabId(shelf: ShelfId): string; panelId: string }) {
  const row = useRef<HTMLDivElement>(null);
  const move = (event: ReactKeyboardEvent) => {
    const index = tabs.findIndex((tab) => tab.id === on);
    const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index - 1 + tabs.length) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : undefined;
    if (next === undefined) return;
    event.preventDefault();
    onPick(tabs[next]!.id);
    row.current?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus();
  };
  return (
    <div ref={row} className="agent-shelves-tabs" role="tablist" aria-label="Shelves" onKeyDown={move}>
      {tabs.map((tab) => {
        const Icon = shelfIcon(tab);
        const picked = tab.id === 'page' && tab.icon !== undefined;
        const name = [tab.label, tab.count === undefined ? undefined : String(tab.count), tab.needsYou ? 'one needs you' : undefined].filter(Boolean).join(', ');
        const button = (
          <button
            type="button"
            role="tab"
            id={tabId(tab.id)}
            aria-controls={panelId}
            className="agent-shelves-tab"
            aria-selected={tab.id === on}
            aria-label={name}
            tabIndex={tab.id === on ? 0 : -1}
            data-shelf={tab.id}
            onClick={() => onPick(tab.id)}
          >
            <Icon aria-hidden />
            {!iconsOnly && <span className="agent-shelves-tab-label">{tab.label}</span>}
            {tab.id === 'made' && tab.count !== undefined && <span className="agent-shelves-tab-count">{tab.count}</span>}
            {tab.needsYou && <span className="agent-shelves-dot" data-tone="needs-you" aria-hidden />}
            {picked && <AgentMark title="Its icon and name, picked by the agent" />}
          </button>
        );
        return iconsOnly ? (
          <Tooltip key={tab.id} content={name}>
            {button}
          </Tooltip>
        ) : (
          <span key={tab.id} className="agent-shelves-tab-slot">
            {button}
          </span>
        );
      })}
    </div>
  );
}

/** A tone the agent picked, as the CSS reads it: never orange or red, which are the board's. */
const toneOf = (tone: PageTone) => ({ 'data-tone': tone });

/** A page icon the agent picked, drawn; none for none. */
function PickedIcon({ icon }: { icon: PageIcon | null }) {
  if (icon === null) return null;
  const Icon = PAGE_ICON_COMPONENTS[icon];
  return <Icon className="page-icon" aria-hidden />;
}

/**
 * The page shelf: the agent's blocks, then its pins, then From the board, which adds only what needs the user or is failing. Until the
 * agent writes a page, the board's Now and a line saying what the page is for.
 */
function PageShelf(props: ShelvesData & { narrow: boolean; onShelf(shelf: ShelfId): void }) {
  const { agent, agents, shows } = props;
  const { page } = agent;
  return (
    <div className="page-shelf">
      {/* What the header's status word leaves out (its flag's reason, "Asks you", an exit code, "Waits for…"), and who started it and when. */}
      <StatusLine agent={agent} agents={agents} shows={shows} />
      {page === null ? <NowBlock agent={agent} actions={props.actions} /> : page.blocks.map((block, index) => <Block key={index} block={block} actions={props.actions} agent={agent} />)}
      <PinsBlock {...props} />
      <FromTheBoard {...props} />
      {page === null && (
        <p className="page-invite" data-testid="page-invite">
          This becomes the agent&rsquo;s own page once it writes one.
        </p>
      )}
    </div>
  );
}

/** The page's status line: what the header's status word leaves out, then who started it and when; its whole text the tooltip. */
function StatusLine({ agent, agents, shows }: Pick<ShelvesData, 'agent' | 'agents' | 'shows'>) {
  const line = statusLine(humanStatus(agent, shows).detail, startedBy(agent, agents), shortWhen(agent.createdAt));
  return (
    <p className="page-status-line" data-testid="page-status-line" title={line}>
      {line}
    </p>
  );
}

/** The board's Now: what it is doing and how far along, or else its last message; its linked issue. Who started it is the page's status line. */
function NowBlock({ agent, actions }: { agent: Agent; actions: ShelfActions }) {
  const card = nowCard(agent);
  return (
    <section className="page-block page-now" aria-label="Now" data-testid="page-now">
      {card.kind === 'status' ? (
        <>
          <p className="page-now-top">
            <span className="agent-shelves-face" data-tone="accent">
              <Activity aria-hidden />
            </span>
            <span className="page-now-summary">{card.summary}</span>
          </p>
          {card.progress !== null && <Progress value={card.progress} />}
        </>
      ) : card.kind === 'message' ? (
        <>
          <span className="page-label">
            <MessageCircleQuestionMark aria-hidden />
            Its last message
          </span>
          <p className="page-quote">{card.text}</p>
        </>
      ) : (
        <p className="page-quote">It hasn&rsquo;t said anything yet.</p>
      )}
      {card.kind === 'status' && card.progress !== null && (
        <p className="page-meta">
          <span className="page-pct">{card.progress}%</span>
        </p>
      )}
      {agent.issue !== null && (
        <button type="button" className="page-issue" title={`${agent.issue.title}: opens in your browser`} onClick={() => actions.openLink(agent.issue!.url)}>
          <span className="page-issue-id">{shortIssueId(agent.issue)}</span>
          <span className="page-issue-title">{agent.issue.title}</span>
          <ArrowUpRight aria-hidden />
        </button>
      )}
    </section>
  );
}

function Progress({ value }: { value: number }) {
  return (
    <span className="page-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={value}>
      <i style={{ width: `${value}%` }} />
    </span>
  );
}

/** A block's head: its icon and title, as the agent gave them. */
function BlockHead({ block }: { block: PageBlock }) {
  if (block.title === null) return null;
  return (
    <p className="page-block-head">
      <PickedIcon icon={block.icon} />
      {block.title}
    </p>
  );
}

/** One of the agent's blocks, in the board's own design, with the robot mark: the agent put it here. */
function Block({ block, actions, agent }: { block: PageBlock; actions: ShelfActions; agent: Agent }) {
  return (
    <section className="page-block" data-kind={block.kind} {...toneOf(block.tone)} aria-label={block.title ?? block.kind}>
      <AgentMark />
      <BlockBody block={block} actions={actions} agent={agent} />
    </section>
  );
}

function BlockBody({ block, actions, agent }: { block: PageBlock; actions: ShelfActions; agent: Agent }) {
  switch (block.kind) {
    case 'heading':
      return (
        <>
          <BlockHead block={block} />
          {block.text !== null && <p className="page-text">{block.text}</p>}
          {block.progress !== null && (
            <>
              <Progress value={block.progress} />
              <p className="page-meta">
                <span />
                <span className="page-pct">{block.progress}%</span>
              </p>
            </>
          )}
        </>
      );
    case 'figures':
      return (
        <>
          <BlockHead block={block} />
          <div className="page-figures">
            {block.figures.map((figure, index) => (
              <div key={index} className="page-figure" {...toneOf(figure.tone)}>
                <span className="page-figure-value">
                  <PickedIcon icon={figure.icon} />
                  {figure.value}
                </span>
                <span className="page-figure-label">{figure.label}</span>
              </div>
            ))}
          </div>
        </>
      );
    case 'checklist': {
      const done = block.items.filter((item) => item.state === 'done').length;
      return (
        <>
          {block.title !== null && (
            <p className="page-block-head">
              <PickedIcon icon={block.icon} />
              {block.title}
              <span className="page-count">
                {done} of {block.items.length}
              </span>
            </p>
          )}
          <ul className="page-checks">
            {block.items.map((item, index) => (
              <li key={index} className="page-check" data-state={item.state}>
                <span className="page-check-box" aria-hidden>
                  {item.state === 'done' && <Check />}
                </span>
                <span className="page-check-text">{item.text}</span>
                <span className="visually-hidden">{item.state === 'done' ? ', done' : item.state === 'doing' ? ', doing now' : ', to do'}</span>
              </li>
            ))}
          </ul>
        </>
      );
    }
    case 'callout':
      return (
        <div className="page-callout">
          {block.icon === null ? <CircleAlert className="page-icon" aria-hidden /> : <PickedIcon icon={block.icon} />}
          <span>
            {block.title !== null && <b>{block.title} </b>}
            {block.text}
          </span>
        </div>
      );
    case 'links':
      return (
        <>
          <BlockHead block={block} />
          <ul className="agent-shelves-rows">
            {block.links.map((link, index) => (
              <li key={index}>
                <LinkRow link={link} actions={actions} agent={agent} />
              </li>
            ))}
          </ul>
        </>
      );
    case 'note':
      return (
        <div className="page-note">
          <p className="page-block-head">
            {block.icon === null ? <StickyNote className="page-icon" aria-hidden /> : <PickedIcon icon={block.icon} />}
            {block.title}
          </p>
          <p className="page-text">{block.text}</p>
        </div>
      );
  }
}

/** A links block's row: a web page opens in a web tab, a Markdown or HTML file in a Doc tab, any other file in its folder. */
function LinkRow({ link, actions, agent }: { link: PageLink; actions: ShelfActions; agent: Agent }) {
  const { target } = link;
  if (target.kind === 'link') {
    const name = link.label ?? target.url.replace(/^https?:\/\//, '');
    return <ShelfRow icon={Globe} name={name} meta="opens in a web tab" title={target.url} onClick={() => actions.openWeb(target.url)} />;
  }
  const file = target.path.split(/[\\/]/).at(-1) ?? target.path;
  const doc = isDocFile(target.path);
  const open = doc ? actions.openSurface && (() => actions.openSurface!(docSurfaceOf(agent.sessionId, target.path))) : () => actions.revealFile(target.path);
  return <ShelfRow icon={FileText} name={link.label ?? file} meta={doc ? 'opens in a Doc tab' : 'shows it in its folder'} title={target.path} onClick={open} />;
}

/** A plain row of a shelf: a small face, a name and a line under it, and something at its end. */
function ShelfRow({
  icon: Icon,
  tone,
  dot,
  name,
  meta,
  end,
  title,
  onClick,
  testId,
}: {
  icon: LucideIcon;
  tone?: string;
  /** A dot on its face: a pull request's checks. */
  dot?: 'pending' | 'failing';
  name: ReactNode;
  meta?: ReactNode;
  end?: ReactNode;
  title?: string;
  onClick?: () => void;
  testId?: string;
}) {
  const body = (
    <>
      <span className="agent-shelves-face" data-size="sm" data-tone={tone}>
        <Icon aria-hidden />
        {dot && <span className="agent-shelves-dot" data-tone={dot} aria-hidden />}
      </span>
      <span className="agent-shelves-row-text">
        <span className="agent-shelves-row-name">{name}</span>
        {meta !== undefined && <span className="agent-shelves-row-meta">{meta}</span>}
      </span>
      {end !== undefined && <span className="agent-shelves-row-end">{end}</span>}
    </>
  );
  return onClick ? (
    <button type="button" className="agent-shelves-row" title={title} onClick={onClick} data-testid={testId}>
      {body}
    </button>
  ) : (
    <div className="agent-shelves-row" title={title} data-testid={testId}>
      {body}
    </div>
  );
}

/** From the board, under the page: only a crew member that needs you, and a pull request with failing or pending checks. */
function FromTheBoard({ agent, agents, shows, records, actions, narrow, onShelf }: ShelvesData & { narrow: boolean; onShelf(shelf: ShelfId): void }) {
  const asking = crewNeedingYou(agent, agents, shows);
  const watched = pullRequestsToWatch(agent, records.fading);
  if (asking.length === 0 && watched.length === 0) return null;
  return (
    <section className="page-from-board" aria-label="From the board" data-testid="page-from-board">
      <p className="page-label">
        <CircleAlert aria-hidden />
        From the board
      </p>
      <ul className="agent-shelves-rows">
        {asking.map((member) => (
          <li key={member.sessionId}>
            <ShelfRow
              icon={Bot}
              tone="needs-you"
              name={member.name}
              // Narrow, the name keeps the room: an orange dot says Needs you in place of the pill.
              meta={narrow ? undefined : 'in its crew'}
              end={<StatusMarker status="needs-you" narrow={narrow} />}
              title="Show it in a tab here"
              onClick={actions.openSurface ? () => actions.openSurface!({ kind: 'session', target: { kind: 'agent', id: member.sessionId } }) : () => onShelf('crew')}
            />
          </li>
        ))}
        {watched.map((pr) => (
          <li key={pr.url}>
            <ShelfRow
              icon={GitPullRequest}
              // Its checks as a dot on its face: red while they fail, the accent while they wait, never green, nor orange as Needs you is.
              dot={pr.checks}
              name={`#${pr.number}${pr.title === null ? '' : ` ${pr.title}`}`}
              meta={narrow ? `checks ${pr.checks}` : `checks ${pr.checks} · open the PR`}
              title="Open it in a PR tab"
              onClick={() => actions.openPullRequest(pr)}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** A status where a row has room for it: its pill, or narrow a dot, so the row's name keeps the room. */
function StatusMarker({ status, narrow }: { status: HumanStatus; narrow: boolean }) {
  if (!narrow) return <HumanPill status={status} />;
  return <span className="agent-shelves-dot agent-shelves-dot-inline" data-tone={status} aria-label={HUMAN_STATUS_LABELS[status]} title={HUMAN_STATUS_LABELS[status]} role="img" />;
}

/** A status as its pill: Needs you in orange, the rest in their colours. */
function HumanPill({ status }: { status: HumanStatus }) {
  return (
    <span className="agent-shelves-pill" data-status={status}>
      {HUMAN_STATUS_LABELS[status]}
    </span>
  );
}

/** A face for a row drawn by `RecordList`: the same small face as a shelf row's. */
function face(Icon: LucideIcon, tone?: string) {
  return (
    <span className="agent-shelves-face" data-size="sm" data-tone={tone}>
      <Icon aria-hidden />
    </span>
  );
}

/**
 * A labelled group of a shelf's rows, which folds to its heading: as the user left it, in every window and tile. Folded, the
 * heading says how many rows it holds, and wears a dot when what it holds needs the user or has failed, so folding hides
 * nothing urgent in silence. The rows stay mounted, so a deleted one's Undo outlives the fold.
 */
function Group({ id, label, count, cue, children }: { id: ShelfGroupId; label: string; count?: number; cue?: FoldCue; children: ReactNode }) {
  const [folded, setFolded] = useShelfFold(id);
  const body = `${useId()}-${id}`;
  return (
    <section className="agent-shelves-group" aria-label={label} data-testid={id} data-folded={folded || undefined}>
      <button type="button" className="agent-shelves-group-head" aria-expanded={!folded} aria-controls={body} onClick={() => setFolded(!folded)}>
        <ChevronDown className="agent-shelves-group-chevron" aria-hidden />
        <span className="agent-shelves-group-label">{label}</span>
        {folded && count !== undefined && count > 0 && <span className="agent-shelves-group-count">{count}</span>}
        {folded && cue && <span className="agent-shelves-dot agent-shelves-dot-inline" data-tone={cue} role="img" aria-label={cue === 'failing' ? 'Failed' : 'Needs you'} title={cue === 'failing' ? 'Failed' : 'Needs you'} />}
      </button>
      <div id={body} className="agent-shelves-group-body" hidden={folded}>
        {children}
      </div>
    </section>
  );
}

/** The agent's pins, as a block of its page: each a record, with its × and Undo, a note showing all it says. */
function PinsBlock({ agent, records, actions }: ShelvesData) {
  const pins = pinSection(agent, records.fading);
  if (pins.rows.length === 0 && pins.hidden.length === 0) return null;
  const open = pinOpener(agent.sessionId, actions);
  return (
    <section className="page-block page-pins" aria-label="Pinned" data-testid="page-pins">
      <AgentMark title="Pinned by the agent" />
      <p className="page-block-head">
        <Pin className="page-icon" aria-hidden />
        Pinned
      </p>
      <RecordList
        section={pins}
        records={records}
        what={(row) => row.item.name}
        row={(each) => {
          const { target, from } = each.item;
          return {
            name: each.item.name,
            meta: target.kind === 'note' ? <span className="details-pin-note">{target.text}</span> : [from === null ? undefined : `from ${from.name}`, target.kind === 'link' ? 'opens in a web tab' : each.item.opens === 'doc' ? 'opens in a Doc tab' : 'shows it in its folder'].filter(Boolean).join(' · '),
            mark: face(target.kind === 'note' ? StickyNote : target.kind === 'link' ? Globe : FileText),
            title: target.kind === 'note' ? target.text : target.kind === 'link' ? target.url : target.path,
            onClick: open(each.item),
            testId: 'details-pin',
          };
        }}
      />
    </section>
  );
}

/** A gate's icon by how its run went: a tick only for a pass, a cross only for a failure. */
const gateIcon = (gate: GateRun | undefined): LucideIcon => (gate?.status === 'passed' ? ShieldCheck : gate?.status === 'failed' ? ShieldX : Shield);

function GateMark({ gate }: { gate: GateRun }) {
  const Icon = gateIcon(gate);
  return <Icon aria-hidden />;
}

/** A pull request's face: merged in its colour, closed muted, else open. */
const prTone = (pr: PullRequest | undefined) => (pr === undefined ? undefined : pr.state === 'merged' ? 'merged' : pr.state === 'closed' ? undefined : pr.checks === 'failing' ? 'failing' : 'open');

/**
 * Made: its pull requests (the newest open one as a card with its checks, gate and linked issue), what it showed you
 * (its plan and documents) and its hand-off docs, each row saying which it is.
 */
function MadeShelf({ agent, agents, shows, technical, records, actions, gate }: ShelvesData) {
  const cues = { agent, agents, shows, gate: technical ? gate : null };
  const pulls = pullRequestSection(agent, records.fading);
  const docs = docSection(agent, records.fading);
  const documents = documentSection(agent);
  const card = pulls.rows.find((row) => (row.item.pr?.state === 'open' || row.item.pr?.state === 'draft') && !(row.source === 'recorded' && row.gone));
  const rest = { ...pulls, rows: pulls.rows.filter((row) => row !== card) };
  return (
    <>
      {card && <PullRequestCard row={card} agent={agent} gate={technical ? gate : null} records={records} actions={actions} />}
      {(rest.rows.length > 0 || rest.hidden.length > 0) && (
        <RecordList
          section={rest}
          records={records}
          what={(row) => `#${row.item.number}`}
          row={(each) => ({
            name: `#${each.item.number}${each.item.title === null ? '' : ` ${each.item.title}`}`,
            meta: [each.item.pr && `${each.item.pr.state} · ${checksLabel(each.item.pr)}`, recordedWhen(each)].filter(Boolean).join(' · '),
            guess: each.item.pr ? `${each.item.pr.state} · from gh` : 'from gh',
            mark: face(each.item.pr?.state === 'merged' ? GitMerge : GitPullRequest, prTone(each.item.pr)),
            title: 'Open it in a PR tab',
            onClick: () => actions.openPullRequest(each.item),
          })}
        />
      )}
      {documents.length > 0 && (
        <Group id="made-shown" label="Shown to you" count={documents.length} cue={foldCue('made-shown', cues)}>
          <ul className="agent-shelves-rows">
            {documents.map((row) => (
              <li key={row.key} data-testid="details-document">
                <ShelfRow
                  icon={row.kind === 'plan' ? ClipboardList : BookOpen}
                  tone={row.kind === 'plan' ? 'open' : undefined}
                  name={row.kind === 'plan' ? `Plan v${row.version}` : row.name}
                  meta={row.kind === 'plan' && agent.plan !== null ? planMeta(agent.plan, shortWhen) : `v${row.version} · shown ${shortWhen(row.at)}`}
                  title={row.kind === 'plan' ? `${row.name}: open its Plan tab` : `${row.document.path}: opens in its Document tab`}
                  onClick={actions.openSurface && (() => actions.openSurface!(row.kind === 'plan' ? planSurfaceOf(agent.sessionId) : documentSurfaceOf(row.document)))}
                />
              </li>
            ))}
          </ul>
        </Group>
      )}
      {(docs.rows.length > 0 || docs.hidden.length > 0) && (
        <Group id="made-handoff" label="Hand-off" count={docs.rows.length}>
          <RecordList
            section={docs}
              records={records}
            what={(row) => docName(row.item.path)}
            row={(each) => ({
              name: docName(each.item.path),
              meta: [each.item.from === null ? 'its own' : `from ${each.item.from.name}`, recordedWhen(each)].filter(Boolean).join(' · '),
              guess: 'its worktree’s handover',
              mark: face(FileStack),
              title: `${each.item.path}: opens in a Doc tab`,
              onClick: actions.openSurface && (() => actions.openSurface!(docSurfaceOf(agent.sessionId, each.item.path))),
            })}
          />
        </Group>
      )}
    </>
  );
}

/** The open pull request as a card: its number and title, then its checks, its gate and its linked issue as facts. */
function PullRequestCard({ row, agent, gate, records, actions }: { row: SidebarRow<PullRequestRow>; agent: Agent; gate: GateRun | undefined | null; records: RecordDeletes; actions: ShelfActions }) {
  const { item } = row;
  const checks = item.pr?.checks;
  return (
    <div className="made-pr" data-source={row.source} data-testid="made-pr">
      <button type="button" className="made-pr-top" title="Open it in a PR tab" onClick={() => actions.openPullRequest(item)}>
        {face(GitPullRequest, prTone(item.pr))}
        <span className="made-pr-title">
          #{item.number}
          {item.title === null ? '' : ` ${item.title}`}
        </span>
      </button>
      <p className="made-pr-facts">
        {checks !== undefined && (
          <span className="made-fact" data-tone={checks === 'failing' ? 'failing' : checks === 'pending' ? 'pending' : checks === 'passing' ? 'passing' : undefined}>
            {checks === 'pending' ? <Clock aria-hidden /> : checks === 'failing' ? <X aria-hidden /> : checks === 'passing' ? <Check aria-hidden /> : null}
            {checksLabel(item.pr!)}
          </span>
        )}
        {gate !== null && gate !== undefined && (
          <span className="made-fact" data-tone={gate.status === 'passed' ? 'passing' : gate.status === 'failed' ? 'failing' : gate.status === 'running' ? 'pending' : undefined}>
            <GateMark gate={gate} />
            {gateWords(gate)}
          </span>
        )}
        {agent.issue !== null && (
          <span className="made-fact">
            <CircleDot aria-hidden />
            {shortIssueId(agent.issue)}
          </span>
        )}
        {row.source === 'guessed' && (
          <span className="made-fact">
            <em className="details-guessed">guessed</em> from gh
          </span>
        )}
      </p>
      {row.source === 'recorded' && (
        <IconButton className="details-record-delete" icon={<X />} size="sm" variant="danger" aria-label="Delete record" tooltip="Delete record" onClick={() => records.remove(row.record, `#${item.number}`)} />
      )}
    </div>
  );
}

/** Crew: the agents it started, each opening in a tab here, and its subagents, from hooks. */
function CrewShelf({ agent, agents, shows, records, actions, narrow }: ShelvesData & { narrow: boolean }) {
  const cues = { agent, agents, shows, gate: null };
  const crew = crewSection(agent, agents, records.fading);
  const subagents = subagentSection(agent);
  const byId = new Map(agents.map((each) => [each.sessionId, each]));
  return (
    <>
      {(crew.rows.length > 0 || crew.hidden.length > 0) && (
        <Group id="crew-agents" label="Agents it started" count={crew.rows.length} cue={foldCue('crew-agents', cues)}>
          <RecordList
            section={crew}
            records={records}
            what={(row) => row.item.name}
            row={({ item }) => {
              const member = byId.get(item.sessionId);
              const status = member && crewStatus(member, shows);
              return {
                name: item.name,
                meta: roleLabel(item) ?? undefined,
                mark: face(Bot, status === 'needs-you' ? 'needs-you' : undefined),
                end: status && <StatusMarker status={status} narrow={narrow} />,
                title: 'Show it in a tab here',
                onClick: actions.openSurface && (() => actions.openSurface!({ kind: 'session', target: { kind: 'agent', id: item.sessionId } })),
              };
            }}
          />
        </Group>
      )}
      {subagents.rows.length > 0 && (
        <Group id="crew-subagents" label="Subagents" count={subagents.rows.length} cue={foldCue('crew-subagents', cues)}>
          <RecordList
            section={subagents}
            records={records}
            what={(row) => row.item.type}
            row={({ item }) => ({
              name: item.type,
              guess: 'from hooks',
              mark: face(Workflow),
              end: <StatusMarker status={subagentStatus(item.state)} narrow={narrow} />,
              title: item.result ?? undefined,
              testId: 'session-subagent',
            })}
          />
        </Group>
      )}
    </>
  );
}

/**
 * Setup: where it works (its folder now, its branch, its AI, model and role) and what is around it (its issue, clock and
 * gate). Under the Simplified design, where it works and its gate wait for Show technical details.
 */
function SetupShelf({ agent, agents, shows, technical, folder, home, gate, now, actions, narrow }: ShelvesData & { narrow: boolean }) {
  const cues = { agent, agents, shows, gate: technical ? gate : null };
  const { issue, schedule } = agent;
  const badge = schedule && clockBadge(schedule, agent.endedAt !== null, now);
  return (
    <>
      {technical && (
        <Group id="setup-where" label="Where it works">
          <ul className="agent-shelves-rows">
            <li>
              <ShelfRow
                icon={FolderOpen}
                name={
                  // Cut from its start, so the end of the path, which differs, survives.
                  <span className="agent-shelves-mono agent-shelves-folder">
                    <bdi>{shortFolder(tildify(folder, home))}</bdi>
                  </span>
                }
                meta={folderMeta(folder, agent.worktree)}
                title={folder}
                testId="setup-folder"
                // Its reveal is the footer's, just below; narrow, its copy is too.
                end={narrow ? undefined : <IconButton icon={<Copy />} size="sm" aria-label="Copy folder" tooltip="Copy the folder's path" onClick={() => actions.copyFolder(folder)} />}
              />
            </li>
            <li>
              <ShelfRow icon={GitBranch} name={<span className="agent-shelves-mono">{branchLine(agent)}</span>} meta="branch" title={agent.worktree} testId="setup-branch" />
            </li>
            <li>
              <ShelfRow icon={Cpu} name={shelvesSetupLine(agent)} meta="AI, model and role" />
            </li>
          </ul>
        </Group>
      )}
      {(issue !== null || badge || (technical && gate !== null)) && (
        <Group id="setup-around" label="Around it" cue={foldCue('setup-around', cues)}>
          <ul className="agent-shelves-rows">
            {issue !== null && (
              <li>
                <ShelfRow
                  icon={CircleDot}
                  tone="accent"
                  name={`${shortIssueId(issue)} ${issue.title}`}
                  meta={`${TRACKER_PROVIDERS[issue.provider].name} · opens in your browser`}
                  end={<ArrowUpRight aria-hidden className="agent-shelves-row-arrow" />}
                  onClick={() => actions.openLink(issue.url)}
                />
              </li>
            )}
            {badge && (
              <li>
                <ShelfRow icon={CalendarClock} tone="scheduled" name={cronWords(schedule.cron)} meta={clockMeta(badge.label)} title={badge.title} />
              </li>
            )}
            {technical && gate !== null && (
              <li>
                <ShelfRow
                  icon={gateIcon(gate)}
                  tone={gate?.status === 'passed' ? 'passing' : gate?.status === 'failed' ? 'failing' : undefined}
                  name={gate === undefined ? 'Gate not run' : sentenceCase(gateWords(gate))}
                  meta={gate === undefined ? 'runs only when you ask' : `on ${shortCommit(gate.commit)}`}
                  testId="setup-gate"
                  end={
                    actions.runGate && (
                      <IconButton icon={<RotateCw />} size="sm" aria-label={gate === undefined ? 'Run gate' : 'Run gate again'} tooltip="Run its zone's gate command in its worktree" disabled={gate?.status === 'running'} onClick={actions.runGate} />
                    )
                  }
                />
              </li>
            )}
          </ul>
        </Group>
      )}
    </>
  );
}

/** The workspace, two lines at the foot of every shelf: its branch, with copy and reveal of its folder and Collapse; its AI and model. */
function WorkspaceFooter({ agent, folder, actions, onCollapse }: ShelvesData & { onCollapse(): void }) {
  return (
    <footer className="agent-shelves-footer" data-testid="shelves-footer">
      <p className="agent-shelves-footer-top">
        <FolderGit2 className="agent-shelves-footer-lead" aria-hidden />
        <span className="agent-shelves-footer-branch" title={folder}>
          {branchLine(agent)}
        </span>
        <IconButton icon={<Copy />} size="sm" aria-label="Copy folder" tooltip="Copy the folder's path" onClick={() => actions.copyFolder(folder)} />
        <IconButton icon={<FolderOpen />} size="sm" aria-label="Reveal folder in Finder" tooltip="Reveal in Finder" onClick={() => actions.revealFolder(folder)} />
        <IconButton
          icon={<PanelLeftClose />}
          size="sm"
          aria-label="Collapse to the rail"
          tooltip={
            <>
              Collapse to an icon rail<Kbd>{keyText('window.details')}</Kbd>
            </>
          }
          onClick={onCollapse}
        />
      </p>
      <p className="agent-shelves-footer-sub">{shelvesSetupLine(agent)}</p>
    </footer>
  );
}

/** The page icon in a ring of how far along it is: orange and full while it needs you. */
function ProgressRing({ value, needsYou, children }: { value: number | null; needsYou: boolean; children: ReactNode }) {
  const circumference = 2 * Math.PI * 16;
  const shown = needsYou ? 100 : (value ?? 0);
  return (
    <span className="agent-shelves-ring" data-needs-you={needsYou || undefined}>
      <svg viewBox="0 0 36 36" aria-hidden>
        <circle className="agent-shelves-ring-track" cx="18" cy="18" r="16" />
        {(needsYou || value !== null) && <circle className="agent-shelves-ring-fill" cx="18" cy="18" r="16" style={{ strokeDasharray: `${(circumference * shown) / 100} ${circumference}` } as CSSProperties} />}
      </svg>
      {children}
    </span>
  );
}

/** How far a peek keeps from the top and foot of the window's body. */
const PEEK_MARGIN = 8;

/**
 * The shelves collapsed (⌘I): a rail of their icons, the page's in a ring of its progress, Made's and Crew's with their
 * counts. Clicking one opens that shelf as a peek over the terminal, which Esc, a click outside or another icon closes;
 * the peek's first button opens the shelves on it.
 */
function ShelvesRail({ tabs, initialPeek, onShowShelves, onOpen, ...data }: ShelvesData & { tabs: ShelfTab[]; initialPeek?: ShelfId; onShowShelves(): void; onOpen(shelf: ShelfId): void }) {
  const { agent, agents, shows, records } = data;
  const [peek, setPeek] = useState<{ shelf: ShelfId; top: number } | undefined>(initialPeek && { shelf: initialPeek, top: 8 });
  const root = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const open = peek && tabs.find((tab) => tab.id === peek.shelf);
  // A shelf that lost its tab takes its peek with it, which doesn't come back with the tab.
  useEffect(() => {
    if (peek !== undefined && open === undefined) setPeek(undefined);
  }, [peek, open]);
  // Beside its icon, as far down as its own height leaves room for, and with the keyboard in it.
  const card = useRef<HTMLDivElement>(null);
  const openShelf = open?.id;
  useLayoutEffect(() => {
    const element = card.current;
    if (element === null || peek === undefined) return;
    const room = (element.offsetParent?.clientHeight ?? 0) - element.offsetHeight - PEEK_MARGIN;
    element.style.setProperty('--peek-top', `${Math.max(PEEK_MARGIN, Math.min(peek.top, room))}px`);
  }, [peek, openShelf]);
  useEffect(() => {
    if (openShelf !== undefined) card.current?.focus({ preventScroll: true });
  }, [openShelf]);
  const shown = peek !== undefined;
  useEffect(() => {
    if (!shown) return;
    const onKeyDown = (event: KeyboardEvent) => {
      // A menu opened from the peek closes first, on its own Esc.
      if (event.key !== 'Escape' || document.querySelector('[data-radix-popper-content-wrapper] [role="menu"]') !== null) return;
      // Before anything else's Esc, and back to the icon it was opened from.
      event.preventDefault();
      event.stopPropagation();
      setPeek(undefined);
      opener.current?.focus();
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      // A click in a menu, toast or tooltip from the peek is in it, though portalled out.
      if (!(target instanceof Element) || root.current?.contains(target) || target.closest('[data-radix-popper-content-wrapper], .ui-toast')) return;
      setPeek(undefined);
    };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [shown]);
  const asks = humanStatus(agent, shows).status === 'needs-you' && agent.page === null;
  const watched = pullRequestsToWatch(agent, records.fading)[0]?.checks;
  const needing = crewNeedingYou(agent, agents, shows).length;
  const item = (tab: ShelfTab) => {
    const Icon = shelfIcon(tab);
    const label = [tab.label, tab.count === undefined ? undefined : String(tab.count), tab.needsYou ? `${needing} needs you` : undefined, tab.id === 'made' && watched ? `checks ${watched}` : undefined].filter(Boolean).join(', ');
    return (
      <button
        key={tab.id}
        type="button"
        className="agent-shelves-rail-item"
        aria-label={label}
        aria-expanded={peek?.shelf === tab.id}
        title={label}
        data-shelf={tab.id}
        onClick={(event) => {
          const button = event.currentTarget;
          opener.current = button;
          setPeek((now) => (now?.shelf === tab.id ? undefined : { shelf: tab.id, top: button.offsetTop }));
        }}
      >
        {tab.id === 'page' ? (
          <ProgressRing value={pageProgress(agent)} needsYou={asks}>
            <span className="agent-shelves-face" data-tone={asks ? 'needs-you' : 'accent'}>
              {asks ? <MessageCircleQuestionMark aria-hidden /> : <Icon aria-hidden />}
            </span>
          </ProgressRing>
        ) : (
          <span className="agent-shelves-face">
            <Icon aria-hidden />
          </span>
        )}
        {tab.count !== undefined && tab.count > 0 && (
          // One figure on each icon, in the colour of what most wants a look: orange for Needs you, a pull request's checks.
          <span className="agent-shelves-rail-badge" data-tone={tab.needsYou ? 'needs-you' : tab.id === 'made' ? watched : undefined}>
            {tab.needsYou ? needing : tab.count}
          </span>
        )}
      </button>
    );
  };
  const OpenIcon = open && shelfIcon(open);
  return (
    <div ref={root} className="agent-shelves-rail-wrap">
      <nav className="agent-shelves-rail" aria-label="Agent sidebar" data-testid="agent-shelves-rail">
        {tabs.filter((tab) => tab.id !== 'setup').map(item)}
        <span className="agent-shelves-rail-fill" />
        {tabs.filter((tab) => tab.id === 'setup').map(item)}
        <IconButton
          icon={<PanelLeftOpen />}
          size="sm"
          aria-label="Show the shelves"
          tooltip={
            <>
              Show the shelves<Kbd>{keyText('window.details')}</Kbd>
            </>
          }
          onClick={onShowShelves}
        />
      </nav>
      {open && OpenIcon && (
        <div ref={card} tabIndex={-1} className="agent-shelves-peek" role="dialog" aria-label={open.label} data-testid="agent-shelves-peek" data-shelf={open.id}>
          <p className="agent-shelves-peek-head">
            <span className="agent-shelves-face" data-size="sm" data-tone={open.id === 'page' ? 'accent' : undefined}>
              <OpenIcon aria-hidden />
            </span>
            <b>{open.label}</b>
            <IconButton icon={<Maximize2 />} size="sm" aria-label="Open as shelves" tooltip="Open as shelves" onClick={() => onOpen(open.id)} />
            <IconButton
              icon={<X />}
              size="sm"
              aria-label="Close"
              tooltip="Close (Esc)"
              onClick={() => {
                setPeek(undefined);
                opener.current?.focus();
              }}
            />
          </p>
          <div className="agent-shelves-body" data-shelf={open.id}>
            <ShelfBody {...data} shelf={open.id} narrow={false} onShelf={(shelf) => setPeek((now) => now && { ...now, shelf })} />
          </div>
        </div>
      )}
    </div>
  );
}
