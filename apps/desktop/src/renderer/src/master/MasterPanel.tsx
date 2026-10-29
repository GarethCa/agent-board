import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { ChevronDown, ChevronRight, Crosshair, SquareArrowOutUpRight, X } from 'lucide-react';
import { NEW_AGENT_SIZE } from '@agent-board/daemon/board-layout';
import type { Agent, BoardItem, Zone } from '@agent-board/daemon/protocol';
import { Button, ErrorText, StatusPill, Tag, ToolButton } from '../ui';
import { useAction } from '../use-action';
import { agentPill, TILE_STATE_LABELS } from '../states';
import { useNeedsYouShows } from '../needs-you-setting';
import { heldPrompts, needsYouEntries } from '../../../shared/needs-you';
import { PermissionRow } from '../inbox/PermissionRow';
import { useNow } from '../inbox/use-now';
import { KIND_TAGS } from '../inbox/kind-tags';
import { ChatView } from '../session/ChatView';
import { ChatStyleButton } from '../session/ChatStyleSwitch';
import { Composer } from '../session/Composer';
import { Markdown } from '../session/Markdown';
import { canRestart, exitText, RestartAgent } from '../session/RestartAgent';
import type { RunsChoice } from '../session/chat';
import { clockTime } from '../board/items/agent-note';
import { askLine, boardMaster, latestDigest, usageHolds, watchRows, type UsageHoldEntry } from './master-view';
import { upperFirst } from '../upper-first';
import { PanelHandle } from './PanelHandle';
import { usePanelRoom } from './use-panel-room';
import {
  clampForYouHeight,
  clampPanelWidth,
  DEFAULT_PANEL_WIDTH,
  maxForYouHeight,
  maxPanelWidth,
  MIN_FOR_YOU_HEIGHT,
  MIN_PANEL_WIDTH,
  setForYouHeight,
  setPanelWidth,
  useFolded,
  useForYouHeight,
  usePanelWidth,
  type PanelSection,
} from './panel-layout';

interface MasterPanelProps {
  agents: readonly Agent[];
  zones: readonly Zone[];
  items: readonly BoardItem[];
  /** Grows each time ⌘⇧M asks for the message box. */
  focusRequest: number;
  onClose(): void;
  /** Shows the agent's tile on the board. */
  onShowAgent(sessionId: string): void;
  onShowZone(zoneId: string): void;
  /** Opens the agent's session window. */
  onOpenAgent(agent: Agent): void;
  /** Opens the agent's plans, in its session window. */
  onOpenPlan(agent: Agent): void;
  onOpenLink(url: string): void;
}

/** The chat's runs of tool calls open as they do by default: the newest while it runs. */
const RUNS: RunsChoice = { mode: 'auto', at: 0 };

/**
 * The Captain's docked panel (ADR-0019): the zones it watches, what needs you with its digest, and its chat. One
 * of two views of the master, beside its tile: closing it stops nothing. With no master yet it offers to start one,
 * which only this click does.
 */
export function MasterPanel({ agents, zones, items, focusRequest, onClose, onShowAgent, onShowZone, onOpenAgent, onOpenPlan, onOpenLink }: MasterPanelProps) {
  const master = boardMaster(agents);
  const panel = useRef<HTMLElement>(null);
  // The board it sits on bounds its width; the width is the user's, kept across reloads.
  const chosen = usePanelWidth();
  const { board, taken } = usePanelRoom(panel);
  const width = board === 0 ? chosen : clampPanelWidth(chosen, board, taken);
  // The islands at the bottom right and the dock make room for it (`:root:has(.master-panel)`), whatever its width.
  useLayoutEffect(() => {
    document.documentElement.style.setProperty('--master-panel-width', `${width}px`);
    return () => {
      document.documentElement.style.removeProperty('--master-panel-width');
    };
  }, [width]);
  // Esc in the panel closes it, as it does a popover; the chat's own keys come first.
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    event.preventDefault();
    onClose();
  };
  // Opened by ⌘⇧M with no master yet: the focus goes to its Start, so Enter starts one.
  useEffect(() => {
    if (focusRequest > 0 && master === undefined) panel.current?.querySelector<HTMLButtonElement>('[data-testid="master-start"]')?.focus();
  }, [focusRequest, master]);
  return (
    <aside ref={panel} className="master-panel" data-testid="master-panel" aria-label="Captain" style={{ width }} onKeyDown={onKeyDown}>
      <PanelHandle
        orientation="vertical"
        label="Resize the Captain’s panel"
        testId="master-panel-handle"
        value={width}
        min={MIN_PANEL_WIDTH}
        max={board === 0 ? DEFAULT_PANEL_WIDTH : maxPanelWidth(board, taken)}
        grow={-1}
        onChange={(next) => setPanelWidth(clampPanelWidth(next, board, taken))}
        onReset={() => setPanelWidth(undefined)}
      />
      <header className="master-panel-head">
        <span className="master-glyph" aria-hidden>
          C
        </span>
        <h2>Captain</h2>
        {/* Short of room, its scope gives way before its model, and then the model is cut too. */}
        <small className="master-panel-scope">
          {master === undefined ? (
            <span className="master-panel-scope-what">not started</span>
          ) : (
            <>
              <span className="master-panel-scope-what">board scope</span>
              <span className="master-panel-scope-model"> · {master.model ?? master.harness}</span>
            </>
          )}
        </small>
        <span className="master-panel-actions">
          {master !== undefined && <ChatStyleButton />}
          {master !== undefined && <ToolButton size="sm" icon={<Crosshair />} label="Show on board" onClick={() => onShowAgent(master.sessionId)} />}
          {master !== undefined && <ToolButton size="sm" icon={<SquareArrowOutUpRight />} label="Open its session window" onClick={() => onOpenAgent(master)} />}
          <ToolButton size="sm" icon={<X />} label="Close" hint="Close the panel: the Captain keeps running" onClick={onClose} />
        </span>
      </header>
      {master === undefined ? (
        <StartMaster />
      ) : (
        <>
          <Watching agents={agents} zones={zones} onShowAgent={onShowAgent} onShowZone={onShowZone} />
          <ForYou panel={panel} agents={agents} zones={zones} items={items} master={master} onOpenAgent={onOpenAgent} onOpenLink={onOpenLink} />
          {/* Dark in every theme, as a session window's chat is. */}
          <section className="master-panel-chat" data-surface="window" aria-label="Chat with the Captain">
            {canRestart(master) && (
              <div className="agent-exit-banner" role="status">
                {exitText(master)}
                <RestartAgent agent={master} label="Restart the Captain" testId="master-restart" />
              </div>
            )}
            <div className="session-chat-view">
              <ChatView agent={master} active onShowTerminal={() => onOpenAgent(master)} runs={RUNS} onOpenLink={onOpenLink} onOpenPlan={() => onOpenPlan(master)} />
            </div>
            <Composer agent={master} placeholder="Ask the Captain…" focusRequest={focusRequest} />
          </section>
        </>
      )}
    </aside>
  );
}

/** With no master yet: what it does, and the one way to start it. */
function StartMaster() {
  const { busy, error, run } = useAction();
  return (
    <section className="master-panel-section master-panel-start">
      <p>
        The Captain is one agent for the whole board. Tell it what you want; it hands the work to the right zone’s orchestrator, starting one if the zone has
        none, and keeps a digest of what needs you.
      </p>
      <p className="master-panel-muted">It never answers a permission prompt, approves or merges for you.</p>
      <Button
        variant="primary"
        data-testid="master-start"
        loading={busy}
        onClick={() => run(() => window.agentBoard.agents.startMaster({ harness: 'claude', ...NEW_AGENT_SIZE }))}
      >
        Start the Captain
      </Button>
      <p className="master-panel-muted">Claude · Opus, at board scope, in a folder of its own.</p>
      {error && <ErrorText>{error}</ErrorText>}
    </section>
  );
}

/** Each zone, and the lead the master watches there: its state and crew, or none. A click shows it on the board. */
function Watching({ agents, zones, onShowAgent, onShowZone }: Pick<MasterPanelProps, 'agents' | 'zones' | 'onShowAgent' | 'onShowZone'>) {
  const shows = useNeedsYouShows();
  const rows = watchRows(zones, agents);
  const watched = rows.filter((row) => row.lead !== undefined).length;
  const [folded] = useFolded('watching');
  return (
    <section className="master-panel-section" aria-label="Watching">
      <FoldHeading section="watching" title="Watching">
        {watched} orchestrator{watched === 1 ? '' : 's'} · {zones.length} zone{zones.length === 1 ? '' : 's'}
      </FoldHeading>
      {folded ? null : rows.length === 0 ? (
        <p className="master-panel-muted">No zones yet.</p>
      ) : (
        <ul className="master-watch">
          {rows.map(({ zone, lead, crew }) => (
            <li key={zone.id}>
              <button
                type="button"
                className="master-watch-row"
                data-testid="master-watch-row"
                style={{ '--zone-color': zone.color } as React.CSSProperties}
                onClick={() => (lead === undefined ? onShowZone(zone.id) : onShowAgent(lead.sessionId))}
              >
                <span className="master-watch-dot" aria-hidden />
                <b title={zone.name}>{zone.name}</b>
                {lead === undefined ? (
                  <span className="master-watch-state master-panel-muted">no orchestrator</span>
                ) : (
                  <span className="master-watch-state">
                    <StatusPill {...agentPill(lead, shows, TILE_STATE_LABELS)} />
                    {crew} agent{crew === 1 ? '' : 's'}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** What needs you, the Needs-you list's rows, then the master's latest digest note. */
function ForYou({ panel, agents, zones, items, master, onOpenAgent, onOpenLink }: Pick<MasterPanelProps, 'agents' | 'zones' | 'items' | 'onOpenAgent' | 'onOpenLink'> & { panel: RefObject<HTMLElement | null>; master: Agent }) {
  const entries = needsYouEntries(agents, useNeedsYouShows());
  const now = useNow(entries.some((entry) => heldPrompts(entry.agent).length > 0));
  const digest = latestDigest(items, master.sessionId);
  const [digestFolded, toggleDigest] = useFolded('digest');
  const [folded] = useFolded('for-you');
  const chosen = useForYouHeight();
  const section = useRef<HTMLElement>(null);
  // How tall it may be dragged (what the header, the other sections and a chat's least leave it), and how tall it is now.
  const measure = () => {
    const aside = panel.current;
    const own = section.current;
    if (!aside || !own) return { max: MIN_FOR_YOU_HEIGHT, now: MIN_FOR_YOU_HEIGHT };
    const others = [...aside.querySelectorAll<HTMLElement>(':scope > .master-panel-head, :scope > .master-panel-section')].reduce((sum, child) => (child === own ? sum : sum + child.offsetHeight), 0);
    return { max: maxForYouHeight(aside.clientHeight, others), now: own.offsetHeight };
  };
  const [room, setRoom] = useState({ max: MIN_FOR_YOU_HEIGHT, now: MIN_FOR_YOU_HEIGHT });
  useLayoutEffect(() => {
    const aside = panel.current;
    const own = section.current;
    if (!aside || !own) return;
    setRoom(measure());
    const observer = new ResizeObserver(() => setRoom(measure()));
    observer.observe(aside);
    observer.observe(own);
    return () => observer.disconnect();
  }, [panel, folded, chosen]);
  // Longer than the panel has room for, the CSS gives it back down to the least.
  const height = chosen === undefined || folded ? undefined : Math.max(MIN_FOR_YOU_HEIGHT, chosen);
  return (
    <>
    <section
      ref={section}
      className="master-panel-section master-panel-for-you"
      aria-label="For you"
      data-sized={height === undefined ? undefined : ''}
      style={height === undefined ? undefined : ({ '--for-you-height': `${height}px` } as CSSProperties)}
    >
      <FoldHeading section="for-you" title="For you">
        {entries.length === 0 ? 'nothing' : `${entries.length} in Needs you`}
      </FoldHeading>
      {!folded && entries.length > 0 && (
        <ul className="master-for-you">
          {entries.map(({ agent, kind }) => {
            const tag = KIND_TAGS[kind];
            const zone = zones.find((each) => each.id === agent.zoneId);
            return (
              <li key={agent.sessionId} className="master-for-you-item" data-testid="master-for-you-item" data-kind={kind}>
                <div className="master-for-you-head">
                  <Tag className="inbox-kind" data-kind={kind}>
                    {tag.icon}
                    {tag.label}
                  </Tag>
                  <b title={agent.name}>{agent.name}</b>
                  {zone && <small title={zone.name}>{zone.name}</small>}
                </div>
                {kind === 'permission' && agent.permissions.length > 0 ? (
                  agent.permissions.map((prompt) => <PermissionRow key={prompt.id} agent={agent} prompt={prompt} now={now} />)
                ) : (
                  <p>{askLine(agent, kind)}</p>
                )}
                <Button size="sm" variant="ghost" icon={<SquareArrowOutUpRight />} aria-label={`Open ${agent.name}`} onClick={() => onOpenAgent(agent)}>
                  Open
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      {!folded && <UsageHolds zones={zones} agents={agents} />}
      {folded ? null : digest === undefined ? (
        <p className="master-panel-muted">No digest yet: the Captain writes one in a note beside its tile.</p>
      ) : (
        <div className="master-digest" data-testid="master-digest">
          <button type="button" className="master-digest-head" aria-expanded={!digestFolded} onClick={toggleDigest}>
            Digest <small>{clockTime(digest.writtenAt)}</small>
          </button>
          {!digestFolded && <Markdown text={digest.text} onOpenLink={onOpenLink} />}
        </div>
      )}
    </section>
    {!folded && (
      <PanelHandle
        orientation="horizontal"
        label="Resize the For you list"
        testId="master-for-you-handle"
        value={room.now}
        min={MIN_FOR_YOU_HEIGHT}
        max={room.max}
        grow={1}
        onChange={(next) => setForYouHeight(clampForYouHeight(next, measure().max))}
        onReset={() => setForYouHeight(undefined)}
      />
    )}
    </>
  );
}

/**
 * The budget holds on the board, each with why and Override: a zone held for usage (Override lifts the hold) and an
 * agent paused for it (Override wakes it). They are the user's to undo, wherever the Captain put them.
 */
function UsageHolds({ zones, agents }: Pick<MasterPanelProps, 'zones' | 'agents'>) {
  const holds = usageHolds(zones, agents);
  const [pending, setPending] = useState<string>();
  if (holds.length === 0) return null;
  const override = (hold: UsageHoldEntry) => {
    setPending(hold.id);
    const done = hold.kind === 'zone' ? window.agentBoard.orchestrators.release(hold.id) : window.agentBoard.agents.resume(hold.id);
    void done.catch(() => {}).finally(() => setPending(undefined));
  };
  return (
    <ul className="master-for-you master-usage-holds" aria-label="Held for usage">
      {holds.map((hold) => (
        <li key={hold.id} className="master-for-you-item" data-testid="master-usage-hold" data-kind={hold.kind}>
          <div className="master-for-you-head">
            <Tag className="inbox-kind" data-kind="held">
              held
            </Tag>
            <b title={hold.name}>{hold.name}</b>
            {hold.zone !== null && <small title={hold.zone}>{hold.zone}</small>}
          </div>
          <p>
            {upperFirst(hold.what)}: {hold.reason}
          </p>
          <Button size="sm" variant="ghost" disabled={pending === hold.id} aria-label={`Override the hold on ${hold.name}`} onClick={() => override(hold)}>
            Override
          </Button>
        </li>
      ))}
    </ul>
  );
}

/** A section's heading, which folds the section to it and back (the fold outlasts a reload). */
function FoldHeading({ section, title, children }: { section: PanelSection; title: string; children: ReactNode }) {
  const [folded, toggle] = useFolded(section);
  return (
    <h3>
      <button type="button" className="master-fold" aria-expanded={!folded} aria-label={`${folded ? 'Unfold' : 'Fold'} ${title}`} data-testid={`master-fold-${section}`} onClick={toggle}>
        {folded ? <ChevronRight aria-hidden /> : <ChevronDown aria-hidden />}
        {title}
      </button>
      <small>{children}</small>
    </h3>
  );
}
