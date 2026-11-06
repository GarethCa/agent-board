// A shelved zone's shelves, drawn under its tiles (`shelves.ts` lays them out): a heading per shelf, a card per stack on
// To do and Doing, a row per stack on Waiting, and Done's one line, then its chips once shown. A click on a stack fans
// its tiles out over the board, as Stage Manager does; another, or Esc, folds them back. Nothing on the board moves.
import { createContext, memo, useContext, type CSSProperties, type MouseEvent, type PointerEvent } from 'react';
import { Check, Clock3, Layers, Pin, StickyNote } from 'lucide-react';
import { HUMAN_STATUS_LABELS } from '@agent-board/daemon/human-status';
import { MAX_MEMBER_LINES, needsUser, SHELF_NAMES, type ShelfStage } from '@agent-board/daemon/shelf-layout';
import type { Agent, NeedsYouShows } from '@agent-board/daemon/protocol';
import { calmFace } from './calm-tile';
import { roleText } from './AgentSetup';
import { StatusGlyph } from './StatusMark';
import type { ClusterView, DrawnStack, ShelfView } from './shelves';

/** What the shelves do: fan a stack out or fold it back, show or fold Done's chips. */
export interface ShelvesActions {
  toggleStack(zoneId: string, key: string): void;
  toggleDone(zoneId: string): void;
  shows: NeedsYouShows;
}

export const ShelvesContext = createContext<ShelvesActions>({ toggleStack: () => {}, toggleDone: () => {}, shows: 'explicit' });

/** How far above a pinned lead's tile its "Pinned" cue sits: in the room over every tile. */
const PIN_ABOVE = 20;

const place = (box: { x: number; y: number; width: number; height: number }): CSSProperties => ({ left: box.x, top: box.y, width: box.width, height: box.height });

/** A press or click on the shelves is theirs: it neither drags the zone nor selects it. */
const keep = (event: MouseEvent | PointerEvent) => event.stopPropagation();
const theirs = (act: () => void) => (event: MouseEvent) => {
  event.stopPropagation();
  act();
};

/**
 * An agent's line on its stack's card: its role (or its name, unless the card's title is it), its status in a word, and
 * what it asks or is doing, unless that only says the word again.
 */
function MemberLine({ agent, title, stage, shows }: { agent: Agent; title: string; stage: ShelfStage; shows: NeedsYouShows }) {
  const face = calmFace(agent, shows);
  // On To do, an agent at its prompt with no turn ended hasn't started, though the six words would call it Done.
  const notStarted = stage === 'todo' && face.status === 'done' && agent.finishedAt === null && agent.endedAt === null;
  // Needs you only as the Needs-you pill counts it: a question asked in words at its prompt waits there, quietly.
  const atPrompt = face.status === 'needs-you' && !needsUser(agent, shows);
  const status = notStarted || atPrompt ? 'paused' : face.status;
  const word = notStarted ? 'Not started' : atPrompt ? 'At its prompt' : HUMAN_STATUS_LABELS[face.status];
  const who = agent.role === null ? (agent.name === title ? null : agent.name) : roleText(agent.role, agent.roleName);
  const line = face.line === null || face.line.toLowerCase() === word.toLowerCase() ? null : face.line;
  return (
    <div className="shelf-member" data-status={status}>
      <StatusGlyph status={status} className="shelf-member-glyph" />
      {who !== null && <span className="shelf-member-who">{who}</span>}
      <span className="shelf-member-word">{word}</span>
      {line !== null && <span className="shelf-member-line">{line}</span>}
    </div>
  );
}

/** The pull request a stack's card names: its agents' first. */
const prOf = (stack: DrawnStack) => stack.agents.flatMap((agent) => agent.pullRequests)[0];

/** What a waiting stack waits on, in a few words: its pull request's checks while they run, else its review. */
function waitingOn(stack: DrawnStack): string {
  const pr = prOf(stack);
  if (pr === undefined) return 'Waiting';
  return `#${pr.number} · ${pr.checks === 'pending' ? 'checks running' : pr.checks === 'failing' ? 'checks failing' : pr.state === 'draft' ? 'draft' : 'review'}`;
}

function StackCard({ stack, open, onToggle, shows }: { stack: DrawnStack; open: boolean; onToggle: () => void; shows: NeedsYouShows }) {
  const pr = prOf(stack);
  const more = stack.agents.length - MAX_MEMBER_LINES;
  return (
    <button
      type="button"
      className="shelf-card nodrag nopan"
      data-testid="shelf-stack"
      data-stack={stack.key}
      data-stage={stack.stage}
      data-needs-you={stack.needsYou || undefined}
      aria-expanded={open}
      aria-label={`${stack.title}: ${stack.agents.length} agent${stack.agents.length === 1 ? '' : 's'}, ${open ? 'open' : 'click to fan out'}`}
      style={place(stack)}
      onPointerDown={keep} onMouseDown={keep}
      onClick={theirs(onToggle)}
    >
      <span className="shelf-card-head">
        {stack.ticket !== null && <span className="shelf-ticket">{stack.ticket}</span>}
        <span className="shelf-card-title">{stack.title}</span>
        {stack.agents.length > 1 && (
          <span className="shelf-card-count" data-testid="shelf-stack-count" title={`${stack.agents.length} agents in this stack: click to fan them out`}>
            <Layers aria-hidden="true" />
            {stack.agents.length}
          </span>
        )}
      </span>
      {stack.agents.slice(0, more > 0 ? MAX_MEMBER_LINES : undefined).map((agent) => (
        <MemberLine key={agent.sessionId} agent={agent} title={stack.title} stage={stack.stage} shows={shows} />
      ))}
      {more > 0 && <span className="shelf-more">+{more} more</span>}
      {(pr !== undefined || stack.notes > 0) && (
        <span className="shelf-card-foot">
          {pr !== undefined && <span>PR #{pr.number}</span>}
          {stack.notes > 0 && (
            <span>
              <StickyNote aria-hidden="true" /> {stack.notes} note{stack.notes === 1 ? '' : 's'}
            </span>
          )}
        </span>
      )}
    </button>
  );
}

function WaitingRow({ stack, open, onToggle }: { stack: DrawnStack; open: boolean; onToggle: () => void }) {
  return (
    <button type="button" className="shelf-row nodrag nopan" data-testid="shelf-stack" data-stack={stack.key} data-stage={stack.stage} aria-expanded={open} style={place(stack)} onPointerDown={keep} onMouseDown={keep} onClick={theirs(onToggle)}>
      <Clock3 aria-hidden="true" />
      <span className="shelf-row-text">
        <span className="shelf-card-head">
          {stack.ticket !== null && <span className="shelf-ticket">{stack.ticket}</span>}
          <span className="shelf-card-title">{stack.title}</span>
        </span>
        <span className="shelf-row-why">{waitingOn(stack)}</span>
      </span>
    </button>
  );
}

function DoneChip({ stack, open, onToggle }: { stack: DrawnStack; open: boolean; onToggle: () => void }) {
  return (
    <button type="button" className="shelf-chip nodrag nopan" data-testid="shelf-stack" data-stack={stack.key} data-stage={stack.stage} data-needs-you={stack.needsYou || undefined} aria-expanded={open} style={place(stack)} onPointerDown={keep} onMouseDown={keep} onClick={theirs(onToggle)}>
      <Check aria-hidden="true" />
      {stack.ticket !== null && <span className="shelf-ticket">{stack.ticket}</span>}
      <span className="shelf-card-title">{stack.title}</span>
    </button>
  );
}

/** A lead pinned in the head row says so, and how to free it: on shelves and in clusters alike. */
function HeadPins({ head }: { head: ShelfView['head'] }) {
  return head
    .filter((place) => place.key.startsWith('agent:'))
    .map((pinned) => (
      <span key={pinned.key} className="shelf-pin" data-testid="shelf-pin" style={{ left: pinned.x, top: pinned.y - PIN_ABOVE }} title="Pinned top-left: right-click it to free it">
        <Pin aria-hidden="true" />
        Pinned
      </span>
    ));
}

/** A shelved zone's shelves, relative to the zone. */
export const ShelvesView = memo(function ShelvesView({ zoneId, view }: { zoneId: string; view: ShelfView }) {
  const { toggleStack, toggleDone, shows } = useContext(ShelvesContext);
  // The agents on Doing that need you, as the Needs-you pill counts them.
  const needYou = view.stacks.filter((stack) => stack.stage === 'doing').flatMap((stack) => stack.agents).filter((agent) => needsUser(agent, shows)).length;
  return (
    <div className="shelves" data-testid="shelves" data-open={view.open !== null || undefined}>
      {view.shelves.map((shelf) => (
        <div key={shelf.stage} className="shelf-column" data-testid="shelf" data-stage={shelf.stage} style={place(shelf)}>
          <div className="shelf-heading">
            {SHELF_NAMES[shelf.stage]}
            <span className="shelf-count">{shelf.count}</span>
            {shelf.stage === 'doing' && needYou > 0 && <span className="shelf-needs">{needYou} need you</span>}
          </div>
        </div>
      ))}
      <HeadPins head={view.head} />
      {/* With a stack fanned out, the rest of the zone steps back, as Stage Manager does; a click on it folds the stack. */}
      {view.open !== null && (
        <div className="shelf-scrim nodrag nopan" data-testid="shelf-scrim" onPointerDown={keep} onMouseDown={keep} onClick={theirs(() => toggleStack(zoneId, view.open!))} />
      )}
      {view.stacks
        .filter((stack) => stack.placed)
        .map((stack) => {
          const open = view.open === stack.key;
          const onToggle = () => toggleStack(zoneId, stack.key);
          if (stack.stage === 'waiting') return <WaitingRow key={stack.key} stack={stack} open={open} onToggle={onToggle} />;
          if (stack.stage === 'done') return <DoneChip key={stack.key} stack={stack} open={open} onToggle={onToggle} />;
          return <StackCard key={stack.key} stack={stack} open={open} onToggle={onToggle} shows={shows} />;
        })}
      {view.doneLine !== null && (
        <button type="button" className="shelf-done-line nodrag nopan" data-testid="shelf-done" aria-expanded={view.doneLine.shown} style={place(view.doneLine)} onPointerDown={keep} onMouseDown={keep} onClick={theirs(() => toggleDone(zoneId))}>
          <span>{view.doneLine.count} done</span>
          <span className="shelf-done-toggle">{view.doneLine.shown ? 'Hide' : 'Show'}</span>
        </button>
      )}
    </div>
  );
});

/**
 * A zone in clusters' outlines, under its tiles: a dashed box round each unit of work's tiles, headed by its ticket,
 * title and stage (and the notes folded into it), orange round one that needs you; a lone tile is its own group, with no
 * box. Then Done's one line, which shows its clusters.
 */
export const ClustersView = memo(function ClustersView({ zoneId, view }: { zoneId: string; view: ClusterView }) {
  const { toggleDone } = useContext(ShelvesContext);
  return (
    <div className="shelves" data-testid="clusters">
      <HeadPins head={view.head} />
      {view.clusters
        .filter((cluster) => cluster.placed)
        .map((cluster) => (
          <div
            key={cluster.key}
            className="zone-cluster"
            data-testid="zone-cluster"
            data-cluster={cluster.key}
            data-stage={cluster.stage}
            data-needs-you={cluster.needsYou || undefined}
            data-solo={cluster.solo || undefined}
            style={place(cluster)}
          >
            {!cluster.solo && (
              <span className="zone-cluster-label">
                {cluster.ticket !== null && <span className="shelf-ticket">{cluster.ticket}</span>}
                <span className="zone-cluster-title">{cluster.title}</span>
                <span className="zone-cluster-stage">{cluster.needsYou ? 'Needs you' : SHELF_NAMES[cluster.stage]}</span>
                {cluster.notes > 0 && (
                  <span className="zone-cluster-notes" title={`${cluster.notes} agent note${cluster.notes === 1 ? '' : 's'} folded in`}>
                    <StickyNote aria-hidden="true" /> {cluster.notes}
                  </span>
                )}
              </span>
            )}
          </div>
        ))}
      {view.doneLine !== null && (
        <button type="button" className="shelf-done-line nodrag nopan" data-testid="shelf-done" aria-expanded={view.doneLine.shown} style={place(view.doneLine)} onPointerDown={keep} onMouseDown={keep} onClick={theirs(() => toggleDone(zoneId))}>
          <span>{view.doneLine.count} done</span>
          <span className="shelf-done-toggle">{view.doneLine.shown ? 'Hide' : 'Show'}</span>
        </button>
      )}
    </div>
  );
});
