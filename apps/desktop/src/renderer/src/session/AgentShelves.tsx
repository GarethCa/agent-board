import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { shortIssueId, type Agent, type NeedsYouShows, type PageBlock, type PageIcon, type PageLink, type PageTone, type PullRequest } from '@agent-board/daemon/protocol';
import { HUMAN_STATUS_LABELS, humanStatus, type HumanStatus } from '@agent-board/daemon/human-status';
import type { Surface } from '@agent-board/daemon/window-layout';
import {
  Activity,
  ArrowUpRight,
  Bot,
  Check,
  CircleAlert,
  FileText,
  FolderGit2,
  Gauge,
  GitPullRequest,
  Globe,
  Lightbulb,
  Link,
  ListChecks,
  MessageCircleQuestionMark,
  Package,
  Pin,
  StickyNote,
  UsersRound,
  type LucideIcon,
} from 'lucide-react';
import { Tooltip } from '../ui';
import { shortWhen } from '../when';
import { PAGE_ICON_COMPONENTS } from './page-icons';
import { startedBy, statusLine } from './inspector';
import { crewNeedingYou, ICON_TABS_BELOW, nowCard, pullRequestsToWatch, shelfShown, shelfTabs, type ShelfId, type ShelfTab } from './shelves';
import { docSurfaceOf } from './tabs';

/** What the page's rows do when clicked: where each opens. */
export interface ShelfActions {
  /** Opens a link in the OS browser: its linked issue. */
  openLink(url: string): void;
  /** Opens one of its pull requests, in a PR tab where it can. */
  openPullRequest(pr: Pick<PullRequest, 'url'>): void;
  /** Shows a surface as a tab of the window: a Doc tab, or an agent of its crew. */
  openSurface?(surface: Surface): void;
  /** Shows a link in a web tab of the window. */
  openWeb(url: string): void;
  /** Shows a file in its folder. */
  revealFile(path: string): void;
}

/** What the shelves draw besides the agent: the board, and what each of Made, Crew and Setup holds. */
interface ShelvesData {
  agent: Agent;
  /** Every agent on the board: its crew's, and who started it. */
  agents: readonly Agent[];
  shows: NeedsYouShows;
  actions: ShelfActions;
}

interface ShelvesProps extends ShelvesData {
  /** The sidebar's width, which the window's handle sets: narrow, the tabs show only their icons. */
  width: number;
  /**
   * What Made, Crew and Setup hold, drawn by the window: for now, the rows the inspector had. Setup has a tab only when
   * it is given something; Made and Crew have one when the agent has something of theirs.
   */
  shelves: { made: ReactNode; crew: ReactNode; setup?: ReactNode };
  /** The shelf to open on; the page unless said (the gallery opens others). */
  initialShelf?: ShelfId;
}

/**
 * An agent's sidebar: a row of shelves as icon tabs, opening on the agent's own page,
 * with Made, Crew and Setup a tab away. A shelf with nothing in it has no tab. The page's tab has the name and icon the
 * agent picked; until it writes a page, the tab is the board's Now.
 */
export function AgentShelves({ agent, agents, shows, actions, width, shelves, initialShelf = 'page' }: ShelvesProps) {
  const tabs = shelfTabs(agent, agents, shows, { setup: shelves.setup !== undefined });
  const [asked, setAsked] = useState<ShelfId>(initialShelf);
  const on = shelfShown(asked, tabs);
  // A shelf that lost its tab is let go: the page shows, and stays when the tab comes back.
  useEffect(() => {
    if (on !== asked) setAsked(on);
  }, [on, asked]);
  const iconsOnly = width < ICON_TABS_BELOW;
  const data = { agent, agents, shows, actions };
  const ids = useId();
  const tabId = (shelf: ShelfId) => `${ids}-tab-${shelf}`;
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
        {on === 'page' ? <PageShelf {...data} narrow={iconsOnly} onShelf={setAsked} /> : shelves[on]}
      </div>
    </aside>
  );
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
 * The page shelf: the agent's blocks, then From the board, which adds only what needs the user or is failing. Until the
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
      <FromTheBoard {...props} />
      {page === null && (
        <p className="page-invite" data-testid="page-invite">
          <span className="page-invite-faces" aria-hidden>
            {[ListChecks, Gauge, Link, Lightbulb, Pin].map((Icon, index) => (
              <span key={index} className="agent-shelves-face" data-size="sm" data-tone="ghost">
                <Icon />
              </span>
            ))}
          </span>
          This shelf is the agent&rsquo;s page. It can name the tab, pick its icon, and fill it with its progress, a checklist, figures, notes and links.
          Until it does, the board shows what it is doing here.
        </p>
      )}
    </div>
  );
}

/** The page's status line: what the header's status word leaves out, then who started it and when; its whole text the tooltip. */
function StatusLine({ agent, agents, shows }: Pick<ShelvesData, 'agent' | 'agents' | 'shows'>) {
  const line = statusLine(humanStatus(agent, shows).detail, startedBy(agent, agents), shortWhen(agent.createdAt));
  return (
    <p className="page-status-line" data-testid="inspector-status-line" title={line}>
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

/** Whether a file opens in a Doc tab (Markdown or HTML) rather than in its folder. */
const DOC_FILE = /\.(md|markdown|html?)$/i;

/** A links block's row: a web page opens in a web tab, a Markdown or HTML file in a Doc tab, any other file in its folder. */
function LinkRow({ link, actions, agent }: { link: PageLink; actions: ShelfActions; agent: Agent }) {
  const { target } = link;
  if (target.kind === 'link') {
    const name = link.label ?? target.url.replace(/^https?:\/\//, '');
    return <ShelfRow icon={Globe} name={name} meta="opens in a web tab" title={target.url} onClick={() => actions.openWeb(target.url)} />;
  }
  const file = target.path.split(/[\\/]/).at(-1) ?? target.path;
  const doc = DOC_FILE.test(target.path);
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
function FromTheBoard({ agent, agents, shows, actions, narrow, onShelf }: ShelvesData & { narrow: boolean; onShelf(shelf: ShelfId): void }) {
  const asking = crewNeedingYou(agent, agents, shows);
  const watched = pullRequestsToWatch(agent);
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
              end={narrow ? <span className="agent-shelves-dot agent-shelves-dot-inline" data-tone="needs-you" aria-label="Needs you" role="img" /> : <HumanPill status="needs-you" />}
              title="Show it in a tab here"
              onClick={actions.openSurface ? () => actions.openSurface!({ kind: 'session', target: { kind: 'agent', id: member.sessionId } }) : () => onShelf('crew')}
            />
          </li>
        ))}
        {watched.map((pr) => (
          <li key={pr.url}>
            <ShelfRow
              icon={GitPullRequest}
              // Its checks as a dot on its face, in the board's checks colours: never green while they wait or fail.
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

/** A status as its pill: Needs you in orange, the rest in their colours. */
function HumanPill({ status }: { status: HumanStatus }) {
  return (
    <span className="agent-shelves-pill" data-status={status}>
      {HUMAN_STATUS_LABELS[status]}
    </span>
  );
}
