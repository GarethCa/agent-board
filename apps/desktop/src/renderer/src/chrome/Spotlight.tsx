import { Fragment, useEffect, useId, useImperativeHandle, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type Ref } from 'react';
import * as RadixDialog from '@radix-ui/react-dialog';
import type { Agent, Shell, Zone } from '@agent-board/daemon/protocol';
import { MessageCircleDashed, Plus, Search, Settings, LibraryBig, ListFilter } from 'lucide-react';
import { CrewFaces } from '../crews/icons';
import { usePrefabs } from '../crews/prefab-store';
import { SESSION_SURFACES } from '../board/board-shortcuts';
import { HarnessMark } from '../board/HarnessMark';
import { agentTitle, shellTitle } from '../board/use-board-windows';
import { inOverlay } from '../keys';
import { openParkThought } from '../keys/park-thought';
import { keysText, keyText, pressed } from '../keys/registry';
import { agentPill, STATE_LABELS, TILE_STATE_LABELS } from '../states';
import { useNeedsYouShows } from '../needs-you-setting';
import { useSimplified } from '../design';
import { useDock } from '../dock';
import { Kbd, StatusPill, Tag, useToast } from '../ui';
import type { WindowTarget } from '../../../preload/api';
import { errorMessage } from '../../../shared/errors';
import { outOfDock, type SessionWindows } from '../windows/session-windows';
import {
  ACTIONS_GROUP,
  CREWS_GROUP,
  NEEDS_YOU_GROUP,
  newAgentLeads,
  RECENT_GROUP,
  SETTINGS_GROUP,
  sideBySide,
  spotlightGroups,
  spotlightStep,
  type BoardSubject,
  type SpotlightGroup,
  type SpotlightRow,
  type SpotlightStep,
  type SpotlightSubject,
} from './spotlight-results';

/**
 * Where ⌘K was pressed, as the window it opens in reads it: what ↵ does there, and the session that view shows already.
 * `context` is the window's own, handed back with each pick.
 */
export interface SpotlightPlace<C> {
  context: C;
  /** `show`: ↵ shows the tile on the board and ⌘↵ opens it. `switch`: ↵ switches the view to the session. */
  mode: 'show' | 'switch';
  /** The row key of the session the view shows already (`agent:<session id>`, `shell:<id>`): picking it only closes. */
  current?: string;
}

/** The key of the "New agent named …" row, among the rows' keys as ↑↓ move through them. */
const NEW_AGENT_KEY = 'new-agent';

/** Opens the switcher from a control, such as the board menu's Find, as ⌘K does. */
export interface SpotlightHandle {
  open(): void;
}

export interface SpotlightProps<C> {
  ref?: Ref<SpotlightHandle>;
  agents: readonly Agent[];
  /** Undefined until they are listed. */
  shells: readonly Shell[] | undefined;
  zones: readonly Zone[];
  /** The board's session windows, listed first under the Simplified design; the other windows have none. */
  windows?: SessionWindows;
  /** Where ⌘K was pressed: `at`, the element it was pressed in (the page's host, for a web tab's page). */
  placeOf(at: Element | null): SpotlightPlace<C>;
  /**
   * Does what ↵ (with `open`, ⌘↵) asks of the subject. False (now, or once it has asked the main process) if it showed
   * nothing here, and the focus goes back. `windowed`: the row is one of the Windows group's, which brings its window
   * back whatever `open` says. A setting is the switcher's own to open, from every window.
   */
  onPick(context: C, subject: BoardSubject, open: boolean, windowed: boolean): boolean | Promise<boolean>;
  /** Whether a new agent can start from here: "New agent named …" is offered only then. */
  canStartAgent: boolean;
  onNewAgent(context: C, name: string): void;
  /** Opens the prompt box of a crew from the prefab named, or with none, the crew library. */
  onCrew(context: C, prefab: string | null): void;
}

interface Opened<C> {
  place: SpotlightPlace<C>;
  /** Gives the focus back to what had it as it opened: a terminal, a field, a tile, a web tab's page. */
  restore(): void;
}

/** The row key of a window's session, as `SpotlightRow.key` has it; undefined for a tab window. */
export const rowKeyOf = ({ kind, id }: WindowTarget): string | undefined => (kind === 'session' ? `agent:${id}` : kind === 'shell' ? `shell:${id}` : undefined);

/** The session window a session row shows; undefined for a zone. */
export const windowTargetOf = (subject: SpotlightSubject): WindowTarget | undefined =>
  subject.kind === 'agent'
    ? { kind: 'session', id: subject.agent.sessionId, title: agentTitle(subject.agent) }
    : subject.kind === 'shell'
      ? { kind: 'shell', id: subject.shell.id, title: shellTitle(subject.shell) }
      : undefined;

/**
 * How to give the focus back to what had it at `at`. A web tab's (or a plan's) page is another web contents, so the
 * window's own focus is on its body: the page is asked to take the keyboard again.
 */
export function focusKeeper(at: Element | null): () => void {
  const page = at?.closest('[data-web-tab]')?.getAttribute('data-web-tab');
  if (page != null) return () => void window.agentBoard.webTabs.focus(page).catch(() => {});
  const element = at instanceof HTMLElement ? at : null;
  return () => {
    if (element?.isConnected) element.focus();
  };
}

/**
 * ⌘K, a Spotlight-style switcher over any window of the app: a search field over the sessions and
 * zones, grouped before anything is typed and ranked once something is, live as they change, with the settings that
 * match under them; a setting picked opens the Settings window at its section. It opens wherever the
 * focus is, a terminal or a web tab's page too, and Esc gives the focus back where it was. What ↵ does is the
 * window's: the board's shows the tile or switches the view in focus (`BoardSpotlight`), a popped-out window switches
 * its session (`PopOutSpotlight`).
 */
export function Spotlight<C>({ ref, agents, shells, zones, windows, placeOf, onPick, canStartAgent, onNewAgent, onCrew }: SpotlightProps<C>) {
  const prefabs = usePrefabs();
  const [opened, setOpened] = useState<Opened<C>>();
  const [query, setQuery] = useState('');
  const [activeKey, setActiveKey] = useState<string>();
  const listId = useId();

  /** Opens it over `at` (what has the focus, or the web tab's page a key came from). */
  const openRef = useRef<(at: Element | null) => void>(() => {});
  openRef.current = (at) => {
    setQuery('');
    setActiveKey(undefined);
    setOpened({ place: placeOf(at), restore: focusKeeper(at) });
  };
  useImperativeHandle(ref, () => ({ open: () => openRef.current(document.activeElement) }), []);

  // Before the terminal and the board's keys, wherever the focus is. Pressed again while open, it closes.
  const openedRef = useRef(opened);
  openedRef.current = opened;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!pressed('move.spotlight', event)) return;
      const opened = openedRef.current;
      // Another dialog or menu keeps its keys; a session window, a dialog too, is one of the views it switches.
      if (opened === undefined && inOverlay() && document.activeElement?.closest(SESSION_SURFACES) == null) return;
      event.preventDefault();
      event.stopPropagation();
      if (opened !== undefined) dismiss(opened);
      // A key handed over from a web tab's page is dispatched on the page's host; any other is the focus's.
      else openRef.current(event.target instanceof Element ? event.target : document.activeElement);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);

  const shows = useNeedsYouShows();
  const simplified = useSimplified();
  // Under Classic the Windows group lists the windows the dock leaves out (Settings › Board › Opening tiles › Dock); the Simplified design lists them all.
  const dock = useDock();
  const listedWindows = useMemo(() => (simplified || windows === undefined ? windows : outOfDock(windows, dock)), [simplified, windows, dock]);
  // The id of the session the view shows already, from its row key (`agent:<id>`, `shell:<id>`).
  const current = opened?.place.current?.replace(/^(agent|shell):/, '');
  const groups = useMemo(
    () => spotlightGroups(query, { agents, shells: shells ?? [], zones, shows, windows: listedWindows, current, canStartAgent, prefabs, simplified, windowsListed: simplified || dock !== 'all' }),
    [query, agents, shells, zones, shows, listedWindows, current, canStartAgent, prefabs, simplified, dock],
  );
  const rows = groups.flatMap((group) => group.rows);
  const place = opened?.place;
  const newName = query.trim();
  // Offered whenever no session or zone matches, settings and actions or not: first, so ↵ still starts it. Not beside
  // the New agent action, which matches it: that one is first then, and starts a blank one.
  const offerNew = newName !== '' && canStartAgent && groups.every((group) => group.label === SETTINGS_GROUP || group.label === ACTIONS_GROUP || group.label === CREWS_GROUP) && !rows.some((row) => row.key === 'action:newAgent');
  const newLeads = newAgentLeads(groups);
  const keys = [...(offerNew && newLeads ? [NEW_AGENT_KEY] : []), ...rows.map((row) => row.key), ...(offerNew && !newLeads ? [NEW_AGENT_KEY] : [])];
  // Kept by key as the rows change under it; the first once it has gone.
  const activeKeyNow = activeKey !== undefined && keys.includes(activeKey) ? activeKey : keys[0];
  const active = rows.find((row) => row.key === activeKeyNow);
  const columns = sideBySide(groups);
  const toasts = useToast();
  const columnsRef = useRef<HTMLDivElement>(null);
  // The Needs you column scrolls on its own: the row the keys reach is brought into its view. Not one the pointer
  // reaches, or the list would slide under it.
  const movedByKeys = useRef(false);
  useEffect(() => {
    if (!movedByKeys.current) return;
    movedByKeys.current = false;
    if (activeKeyNow !== undefined) document.getElementById(`${listId}-${activeKeyNow}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [activeKeyNow, listId]);

  /** Closes it, the focus back where it was. */
  function dismiss(from: Opened<C>) {
    setOpened(undefined);
    requestAnimationFrame(from.restore);
  }

  function pick(row: SpotlightRow, open: boolean) {
    if (opened === undefined) return;
    const { subject } = row;
    // A filter is taken into the field, in place of the colon typed, for its value to follow.
    if (subject.kind === 'filter') {
      setQuery(subject.prefix);
      setActiveKey(undefined);
      return;
    }
    const target = windowTargetOf(subject);
    const sessionKey = (target && rowKeyOf(target)) ?? row.key;
    if (sessionKey === opened.place.current) return dismiss(opened);
    setOpened(undefined);
    // The Settings window comes forward with the focus; if it can't, it says so and the focus goes back here.
    if (subject.kind === 'action' && subject.action === 'newAgent') return onNewAgent(opened.place.context, '');
    // The field opens over where ⌘K was pressed, and gives the focus back there.
    if (subject.kind === 'action' && subject.action === 'parkThought') return openParkThought(opened.restore);
    if (subject.kind === 'crew') return onCrew(opened.place.context, subject.prefab);
    const shown =
      subject.kind === 'setting' || subject.kind === 'action'
        ? window.agentBoard.setup.openSettings(subject.kind === 'setting' ? subject.pane : undefined).then(
            () => true,
            (error: unknown) => {
              toasts.show({ id: 'open Settings', tone: 'error', message: `Could not open Settings: ${errorMessage(error)}` });
              return false;
            },
          )
        : onPick(opened.place.context, subject, open, row.window !== undefined);
    void Promise.resolve(shown).then((done) => done || requestAnimationFrame(opened.restore));
  }

  function startNew() {
    if (opened === undefined) return;
    setOpened(undefined);
    onNewAgent(opened.place.context, newName);
  }

  const onKeyDown = (event: ReactKeyboardEvent) => {
    const index = activeKeyNow === undefined ? -1 : keys.indexOf(activeKeyNow);
    const step = ARROW_STEPS[event.key];
    if (columns && step !== undefined) {
      // Nothing is typed while the columns show, so ← → have no caret to move.
      event.preventDefault();
      movedByKeys.current = true;
      setActiveKey(spotlightStep(groups, activeKeyNow, step, columnsStacked(columnsRef.current)));
    } else if (event.key === 'Tab' && !event.shiftKey && active?.subject.kind === 'filter') {
      event.preventDefault();
      pick(active, false);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (keys.length === 0) return;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      movedByKeys.current = true;
      setActiveKey(keys[(index + step + keys.length) % keys.length]!);
    } else if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (active !== undefined) pick(active, event.metaKey || event.ctrlKey);
      else if (activeKeyNow === NEW_AGENT_KEY) startNew();
    }
  };

  const showing = place?.mode === 'show';
  // A crew's row opens its prompt box, wherever ⌘K was pressed.
  const opensCrew = active?.subject.kind === 'crew';
  const filtering = active?.subject.kind === 'filter';
  const where = filtering ? 'filter' : opensCrew ? 'open' : showing ? 'show on board' : 'switch here';
  const newAgentRow = offerNew && (
    <div
      id={`${listId}-${NEW_AGENT_KEY}`}
      className="spotlight-row"
      role="option"
      aria-selected={activeKeyNow === NEW_AGENT_KEY}
      data-active={activeKeyNow === NEW_AGENT_KEY || undefined}
      data-testid="spotlight-new-agent"
      onPointerMove={activeKeyNow === NEW_AGENT_KEY ? undefined : () => setActiveKey(NEW_AGENT_KEY)}
      onPointerDown={(event) => event.preventDefault()}
      onClick={startNew}
    >
      <span className="spotlight-mark" aria-hidden>
        <Plus />
      </span>
      <span className="spotlight-main">
        <span className="spotlight-name">New agent named ‘{newName}’</span>
      </span>
    </div>
  );
  return (
    <RadixDialog.Root open={opened !== undefined} onOpenChange={(open) => !open && opened !== undefined && dismiss(opened)}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="spotlight-scrim" />
        <RadixDialog.Content
          className="spotlight"
          aria-label="Jump to a session, zone or setting"
          aria-describedby={undefined}
          data-testid="spotlight"
          data-mode={place?.mode}
          onEscapeKeyDown={(event) => {
            // Not on to the board's own Esc, which would collapse the expanded tile or clear the selection.
            event.stopPropagation();
          }}
          // The focus is given back by hand: to where it was on Esc, to the session picked otherwise.
          onCloseAutoFocus={(event) => event.preventDefault()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <RadixDialog.Title className="visually-hidden">Jump to a session, zone or setting</RadixDialog.Title>
          <div className="spotlight-field">
            <Search aria-hidden />
            <input
              className="spotlight-input"
              role="combobox"
              aria-label="Jump to a session, zone or setting"
              aria-expanded
              aria-controls={listId}
              aria-activedescendant={activeKeyNow === undefined ? undefined : `${listId}-${activeKeyNow}`}
              aria-autocomplete="list"
              placeholder="Jump to a session, zone or setting…"
              spellCheck={false}
              autoComplete="off"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActiveKey(undefined);
              }}
              onKeyDown={onKeyDown}
            />
            <span className="spotlight-where" data-testid="spotlight-where">
              ↵ {where}
            </span>
          </div>
          <div className="spotlight-list" id={listId} role="listbox" aria-label="Sessions, zones and settings">
            {newLeads && newAgentRow}
            {groups.map((group, index) => {
              // In a column a row is compact: no pill or action beside it, for its name to have the room.
              const rowsOf = (shown: SpotlightGroup, compact = false) => (
                <Fragment key={shown.label ?? index}>
                  {shown.label !== undefined && (
                    <div className="spotlight-group" role="presentation" data-group={shown.label}>
                      {shown.label}
                      {shown.label === NEEDS_YOU_GROUP && ` · ${shown.rows.length}`}
                    </div>
                  )}
                  {shown.rows.map((row) => (
                    <Row key={row.key} id={`${listId}-${row.key}`} row={row} active={row.key === activeKeyNow} compact={compact} onHover={() => setActiveKey(row.key)} onPick={() => pick(row, false)} />
                  ))}
                </Fragment>
              );
              // Side by side, Recent is drawn in the Needs you group's place, beside it.
              if (columns && group.label === RECENT_GROUP) return null;
              if (!columns || group.label !== NEEDS_YOU_GROUP) return rowsOf(group);
              const recent = groups.find((other) => other.label === RECENT_GROUP)!;
              return (
                <div key="columns" ref={columnsRef} className="spotlight-columns" role="presentation" data-testid="spotlight-columns">
                  <div className="spotlight-column" role="presentation" data-column="needs-you">
                    {rowsOf(group, true)}
                  </div>
                  <div className="spotlight-column" role="presentation" data-column="recent">
                    {rowsOf(recent, true)}
                  </div>
                </div>
              );
            })}
            {!newLeads && newAgentRow}
            {rows.length === 0 && !offerNew && <p className="spotlight-empty">{newName === '' ? 'Nothing on the board yet' : 'Nothing matches'}</p>}
          </div>
          <div className="spotlight-foot" aria-hidden>
            <span>
              {keysText('dialog.move').map((key) => (
                <Kbd key={key}>{key}</Kbd>
              ))}{' '}
              move
            </span>
            {columns && (
              <span>
                {keysText('dialog.column').map((key) => (
                  <Kbd key={key}>{key}</Kbd>
                ))}{' '}
                column
              </span>
            )}
            <span>
              {/* ↵ or ⇥ takes a filter into the field. */}
              <Kbd>{keyText('dialog.pick')}</Kbd>
              {filtering && <Kbd>⇥</Kbd>} {filtering ? 'take' : opensCrew ? 'open' : showing ? 'show' : 'switch'}
            </span>
            {showing && !opensCrew && !filtering && (
              <span>
                <Kbd>{keyText('dialog.openFromSwitcher')}</Kbd> open
              </span>
            )}
            <span>
              <Kbd>{keyText('dialog.close')}</Kbd> {columns ? 'back' : 'back to where you were'}
            </span>
          </div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

/** Whether the two columns sit one above the other, as a narrow window lays them out. */
function columnsStacked(columns: HTMLElement | null): boolean {
  const [left, right] = columns?.children ?? [];
  return left !== undefined && right !== undefined && right.getBoundingClientRect().top > left.getBoundingClientRect().top;
}

/** The arrow keys, as the moves `spotlightStep` makes. */
const ARROW_STEPS: Partial<Record<string, SpotlightStep>> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };

function Row({ id, row, active, compact = false, onHover, onPick }: { id: string; row: SpotlightRow; active: boolean; compact?: boolean; onHover(): void; onPick(): void }) {
  const { subject } = row;
  const shows = useNeedsYouShows();
  const prefabs = usePrefabs();
  const crewMembers = subject.kind === 'crew' ? prefabs.find((prefab) => prefab.name === subject.prefab)?.members : undefined;
  return (
    <div
      id={id}
      className="spotlight-row"
      role="option"
      aria-selected={active}
      data-active={active || undefined}
      data-testid="spotlight-row"
      data-kind={subject.kind}
      onPointerMove={active ? undefined : onHover}
      // Not the field's focus: the pick happens on the click.
      onPointerDown={(event) => event.preventDefault()}
      onClick={onPick}
    >
      <span className="spotlight-mark" aria-hidden>
        {subject.kind === 'filter' ? (
          <ListFilter />
        ) : subject.kind === 'crew' ? (
          crewMembers === undefined ? (
            <LibraryBig />
          ) : (
            <CrewFaces members={crewMembers} most={3} />
          )
        ) : subject.kind === 'setting' || subject.kind === 'action' ? (
          subject.kind === 'action' && subject.action === 'newAgent' ? <Plus /> : subject.kind === 'action' && subject.action === 'parkThought' ? <MessageCircleDashed /> : <Settings />
        ) : subject.kind === 'zone' ? (
          // A zone's colour is its data, not a theme token.
          <span className="spotlight-zone-ring" style={{ '--zone-color': subject.zone.color } as CSSProperties} />
        ) : (
          <HarnessMark harness={subject.kind === 'agent' ? subject.agent.harness : 'shell'} />
        )}
      </span>
      <span className="spotlight-main">
        <span className="spotlight-name">
          <Marked text={row.name} marks={row.marks} />
        </span>
        {row.snippet === undefined ? (
          <span className="spotlight-sub" data-purpose={row.purpose || undefined}>
            {row.sub}
          </span>
        ) : (
          <span className="spotlight-sub" data-testid="spotlight-snippet">
            <span className="spotlight-field-label" data-field={row.snippet.label}>
              {row.snippet.label}
            </span>
            <Marked text={row.snippet.text} marks={row.snippet.marks} />
          </span>
        )}
      </span>
      {compact ? null : subject.kind === 'agent' ? (
        <StatusPill {...agentPill(subject.agent, shows, TILE_STATE_LABELS)} title={STATE_LABELS[subject.agent.state]} />
      ) : subject.kind === 'shell' ? (
        <Tag>shell</Tag>
      ) : subject.kind === 'zone' ? (
        <span className="spotlight-act">show zone</span>
      ) : subject.kind === 'action' ? (
        <span className="spotlight-act">run</span>
      ) : subject.kind === 'filter' ? (
        <span className="spotlight-act">filter</span>
      ) : (
        <span className="spotlight-act">{subject.kind === 'crew' ? 'open' : 'open setting'}</span>
      )}
    </div>
  );
}

/** The text with the matched letters marked, a run of them as one mark. */
function Marked({ text, marks }: { text: string; marks: readonly number[] }) {
  if (marks.length === 0) return text;
  const marked = new Set(marks);
  const parts: { text: string; mark: boolean }[] = [];
  for (let index = 0; index < text.length; index++) {
    const letter = text[index]!;
    const mark = marked.has(index);
    const last = parts.at(-1);
    if (last?.mark === mark) last.text += letter;
    else parts.push({ text: letter, mark });
  }
  return parts.map((part, index) => (part.mark ? <mark key={index}>{part.text}</mark> : <Fragment key={index}>{part.text}</Fragment>));
}
