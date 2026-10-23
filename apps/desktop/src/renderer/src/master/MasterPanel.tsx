import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Crosshair, SquareArrowOutUpRight, X } from 'lucide-react';
import { NEW_AGENT_SIZE } from '@agent-board/daemon/board-layout';
import type { Agent, BoardItem, Zone } from '@agent-board/daemon/protocol';
import { Button, ErrorText, StatusPill, Tag, ToolButton } from '../ui';
import { useAction } from '../use-action';
import { agentPill, TILE_STATE_LABELS } from '../states';
import { useNeedsYouShows } from '../needs-you-setting';
import { needsYouEntries } from '../../../shared/needs-you';
import { KIND_TAGS } from '../inbox/kind-tags';
import { ChatView } from '../session/ChatView';
import { Composer } from '../session/Composer';
import { Markdown } from '../session/Markdown';
import { canRestart, exitText, RestartAgent } from '../session/RestartAgent';
import type { RunsChoice } from '../session/chat';
import { clockTime } from '../board/items/agent-note';
import { askLine, boardMaster, latestDigest, watchRows } from './master-view';

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
  onOpenLink(url: string): void;
}

/** The chat's runs of tool calls open as they do by default: the newest while it runs. */
const RUNS: RunsChoice = { mode: 'auto', at: 0 };

/**
 * The board master's docked panel (ADR-0019): the zones it watches, what needs you with its digest, and its chat. One
 * of two views of the master, beside its tile: closing it stops nothing. With no master yet it offers to start one,
 * which only this click does.
 */
export function MasterPanel({ agents, zones, items, focusRequest, onClose, onShowAgent, onShowZone, onOpenAgent, onOpenLink }: MasterPanelProps) {
  const master = boardMaster(agents);
  const panel = useRef<HTMLElement>(null);
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
    <aside ref={panel} className="master-panel" data-testid="master-panel" aria-label="Board master" onKeyDown={onKeyDown}>
      <header className="master-panel-head">
        <span className="master-glyph" aria-hidden>
          M
        </span>
        <h2>Master</h2>
        <small className="master-panel-scope">{master === undefined ? 'not started' : `board scope · ${master.model ?? master.harness}`}</small>
        <span className="master-panel-actions">
          {master !== undefined && <ToolButton size="sm" icon={<Crosshair />} label="Show on board" onClick={() => onShowAgent(master.sessionId)} />}
          {master !== undefined && <ToolButton size="sm" icon={<SquareArrowOutUpRight />} label="Open its session window" onClick={() => onOpenAgent(master)} />}
          <ToolButton size="sm" icon={<X />} label="Close" hint="Close the panel: the master keeps running" onClick={onClose} />
        </span>
      </header>
      {master === undefined ? (
        <StartMaster />
      ) : (
        <>
          <Watching agents={agents} zones={zones} onShowAgent={onShowAgent} onShowZone={onShowZone} />
          <ForYou agents={agents} zones={zones} items={items} master={master} onOpenAgent={onOpenAgent} onOpenLink={onOpenLink} />
          {/* Dark in every theme, as a session window's chat is. */}
          <section className="master-panel-chat" data-surface="window" aria-label="Chat with the master">
            {canRestart(master) && (
              <div className="agent-exit-banner" role="status">
                {exitText(master)}
                <RestartAgent agent={master} label="Restart the master" testId="master-restart" />
              </div>
            )}
            <div className="session-chat-view">
              <ChatView agent={master} active onShowTerminal={() => onOpenAgent(master)} runs={RUNS} onOpenLink={onOpenLink} />
            </div>
            <Composer agent={master} placeholder="Ask the master…" focusRequest={focusRequest} />
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
        The master is one agent for the whole board. Tell it what you want; it hands the work to the right zone’s orchestrator, starting one if the zone has
        none, and keeps a digest of what needs you.
      </p>
      <p className="master-panel-muted">It never answers a permission prompt, approves or merges for you.</p>
      <Button
        variant="primary"
        data-testid="master-start"
        loading={busy}
        onClick={() => run(() => window.agentBoard.agents.startMaster({ harness: 'claude', ...NEW_AGENT_SIZE }))}
      >
        Start the master
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
  return (
    <section className="master-panel-section" aria-label="Watching">
      <h3>
        Watching
        <small>
          {watched} orchestrator{watched === 1 ? '' : 's'} · {zones.length} zone{zones.length === 1 ? '' : 's'}
        </small>
      </h3>
      {rows.length === 0 ? (
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
                <b>{zone.name}</b>
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
function ForYou({ agents, zones, items, master, onOpenAgent, onOpenLink }: Pick<MasterPanelProps, 'agents' | 'zones' | 'items' | 'onOpenAgent' | 'onOpenLink'> & { master: Agent }) {
  const entries = needsYouEntries(agents, useNeedsYouShows());
  const digest = latestDigest(items, master.sessionId);
  const [digestOpen, setDigestOpen] = useState(true);
  return (
    <section className="master-panel-section master-panel-for-you" aria-label="For you">
      <h3>
        For you
        <small>{entries.length === 0 ? 'nothing' : `${entries.length} in Needs you`}</small>
      </h3>
      {entries.length > 0 && (
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
                  <b>{agent.name}</b>
                  {zone && <small>{zone.name}</small>}
                </div>
                <p>{askLine(agent, kind)}</p>
                <Button size="sm" variant="ghost" icon={<SquareArrowOutUpRight />} aria-label={`Open ${agent.name}`} onClick={() => onOpenAgent(agent)}>
                  Open
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      {digest === undefined ? (
        <p className="master-panel-muted">No digest yet: the master writes one in a note beside its tile.</p>
      ) : (
        <div className="master-digest" data-testid="master-digest">
          <button type="button" className="master-digest-head" aria-expanded={digestOpen} onClick={() => setDigestOpen(!digestOpen)}>
            Digest <small>{clockTime(digest.writtenAt)}</small>
          </button>
          {digestOpen && <Markdown text={digest.text} onOpenLink={onOpenLink} />}
        </div>
      )}
    </section>
  );
}
