import { Fragment, useEffect, useId, useImperativeHandle, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type Ref } from 'react';
import * as RadixDialog from '@radix-ui/react-dialog';
import type { Agent, Shell, Zone } from '@agent-board/daemon/protocol';
import { Plus, Search } from 'lucide-react';
import { SESSION_SURFACES } from '../board/board-shortcuts';
import { HarnessMark } from '../board/HarnessMark';
import { agentTitle, shellTitle } from '../board/use-board-windows';
import { inOverlay } from '../keys';
import { keysText, keyText, pressed } from '../keys/registry';
import { agentPill, STATE_LABELS, TILE_STATE_LABELS } from '../states';
import { useNeedsYouShows } from '../needs-you-setting';
import { Kbd, StatusPill, Tag } from '../ui';
import type { WindowTarget } from '../../../preload/api';
import { spotlightGroups, type SpotlightRow, type SpotlightSubject } from './spotlight-results';

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
  /** Where ⌘K was pressed: `at`, the element it was pressed in (the page's host, for a web tab's page). */
  placeOf(at: Element | null): SpotlightPlace<C>;
  /**
   * Does what ↵ (with `open`, ⌘↵) asks of the subject. False (now, or once it has asked the main process) if it showed
   * nothing here, and the focus goes back.
   */
  onPick(context: C, subject: SpotlightSubject, open: boolean): boolean | Promise<boolean>;
  /** Whether a new agent can start from here: "New agent named …" is offered only then. */
  canStartAgent: boolean;
  onNewAgent(context: C, name: string): void;
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
function focusKeeper(at: Element | null): () => void {
  const page = at?.closest('[data-web-tab]')?.getAttribute('data-web-tab');
  if (page != null) return () => void window.agentBoard.webTabs.focus(page).catch(() => {});
  const element = at instanceof HTMLElement ? at : null;
  return () => {
    if (element?.isConnected) element.focus();
  };
}

/**
 * ⌘K, a Spotlight-style switcher over any window of the app: a search field over the sessions and
 * zones, grouped before anything is typed and ranked once something is, live as they change. It opens wherever the
 * focus is, a terminal or a web tab's page too, and Esc gives the focus back where it was. What ↵ does is the
 * window's: the board's shows the tile or switches the view in focus (`BoardSpotlight`), a popped-out window switches
 * its session (`PopOutSpotlight`).
 */
export function Spotlight<C>({ ref, agents, shells, zones, placeOf, onPick, canStartAgent, onNewAgent }: SpotlightProps<C>) {
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
  const groups = useMemo(() => spotlightGroups(query, { agents, shells: shells ?? [], zones, shows }), [query, agents, shells, zones, shows]);
  const rows = groups.flatMap((group) => group.rows);
  // Kept by key as the rows change under it; the first once it has gone.
  const active = rows.find((row) => row.key === activeKey) ?? rows[0];
  const place = opened?.place;
  const newName = query.trim();
  const offerNew = rows.length === 0 && newName !== '' && canStartAgent;

  /** Closes it, the focus back where it was. */
  function dismiss(from: Opened<C>) {
    setOpened(undefined);
    requestAnimationFrame(from.restore);
  }

  function pick(row: SpotlightRow, open: boolean) {
    if (opened === undefined) return;
    if (row.key === opened.place.current) return dismiss(opened);
    setOpened(undefined);
    void Promise.resolve(onPick(opened.place.context, row.subject, open)).then((shown) => shown || requestAnimationFrame(opened.restore));
  }

  function startNew() {
    if (opened === undefined) return;
    setOpened(undefined);
    onNewAgent(opened.place.context, newName);
  }

  const onKeyDown = (event: ReactKeyboardEvent) => {
    const index = active === undefined ? -1 : rows.indexOf(active);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (rows.length === 0) return;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActiveKey(rows[(index + step + rows.length) % rows.length]!.key);
    } else if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (active !== undefined) pick(active, event.metaKey || event.ctrlKey);
      else if (offerNew) startNew();
    }
  };

  const showing = place?.mode === 'show';
  const where = showing ? 'show on board' : 'switch here';
  return (
    <RadixDialog.Root open={opened !== undefined} onOpenChange={(open) => !open && opened !== undefined && dismiss(opened)}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="spotlight-scrim" />
        <RadixDialog.Content
          className="spotlight"
          aria-label="Jump to a session or zone"
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
          <RadixDialog.Title className="visually-hidden">Jump to a session or zone</RadixDialog.Title>
          <div className="spotlight-field">
            <Search aria-hidden />
            <input
              className="spotlight-input"
              role="combobox"
              aria-label="Jump to a session or zone"
              aria-expanded
              aria-controls={listId}
              aria-activedescendant={active === undefined ? undefined : `${listId}-${active.key}`}
              aria-autocomplete="list"
              placeholder="Jump to a session or zone…"
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
          <div className="spotlight-list" id={listId} role="listbox" aria-label="Sessions and zones">
            {groups.map((group, index) => (
              <Fragment key={group.label ?? index}>
                {group.label !== undefined && (
                  <div className="spotlight-group" role="presentation">
                    {group.label}
                    {group.label === 'Needs you' && ` · ${group.rows.length}`}
                  </div>
                )}
                {group.rows.map((row) => (
                  <Row key={row.key} id={`${listId}-${row.key}`} row={row} active={row === active} onHover={() => setActiveKey(row.key)} onPick={() => pick(row, false)} />
                ))}
              </Fragment>
            ))}
            {rows.length === 0 &&
              (offerNew ? (
                <div
                  className="spotlight-row"
                  role="option"
                  aria-selected
                  data-active
                  data-testid="spotlight-new-agent"
                  onClick={startNew}
                >
                  <span className="spotlight-mark" aria-hidden>
                    <Plus />
                  </span>
                  <span className="spotlight-main">
                    <span className="spotlight-name">New agent named ‘{newName}’</span>
                  </span>
                </div>
              ) : (
                <p className="spotlight-empty">{newName === '' ? 'Nothing on the board yet' : 'Nothing matches'}</p>
              ))}
          </div>
          <div className="spotlight-foot" aria-hidden>
            <span>
              {keysText('dialog.move').map((key) => (
                <Kbd key={key}>{key}</Kbd>
              ))}{' '}
              move
            </span>
            <span>
              <Kbd>{keyText('dialog.pick')}</Kbd> {showing ? 'show' : 'switch'}
            </span>
            {showing && (
              <span>
                <Kbd>{keyText('dialog.openFromSwitcher')}</Kbd> open
              </span>
            )}
            <span>
              <Kbd>{keyText('dialog.close')}</Kbd> back to where you were
            </span>
          </div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

function Row({ id, row, active, onHover, onPick }: { id: string; row: SpotlightRow; active: boolean; onHover(): void; onPick(): void }) {
  const { subject } = row;
  const shows = useNeedsYouShows();
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
        {subject.kind === 'zone' ? (
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
        <span className="spotlight-sub">{row.sub}</span>
      </span>
      {subject.kind === 'agent' ? (
        <StatusPill {...agentPill(subject.agent, shows, TILE_STATE_LABELS)} title={STATE_LABELS[subject.agent.state]} />
      ) : subject.kind === 'shell' ? (
        <Tag>shell</Tag>
      ) : (
        <span className="spotlight-act">show zone</span>
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
