import { useCallback, useEffect, useRef, useState } from 'react';
import type { Agent, Shell, Zone } from '@agent-board/daemon/protocol';
import type { Node } from '@xyflow/react';
import { VIEW_KEYS } from '../../../shared/view-saver';
import { buildMismatch, BuildMismatch, useDaemonStatus } from '../DaemonStatus';
import { isTyping } from '../board/use-tile-moves';
import { pressed } from '../keys/registry';
import { BoardMenu, type BoardMenuState } from './BoardMenu';
import { CreateToolbar, type CreateToolbarProps } from './CreateToolbar';
import { EmptyBoard } from './EmptyBoard';
import { NeedsYou } from './NeedsYou';
import { BoardSpotlight } from './BoardSpotlight';
import type { SpotlightHandle } from './Spotlight';
import { Onboarding } from '../onboarding/Onboarding';
import { onboardingState, shouldOpenOnboarding, type OnboardingState } from '../onboarding/first-run';
import { SampleBoard } from '../onboarding/SampleBoard';
import { ZoneJump } from './ZoneJump';
import { ZoomControls } from './ZoomControls';
import type { ZoneSource } from './zones';
import type { ClickOpens } from '../board/click-opens';
import type { ConnectionsView } from '../board/connections-view';
import type { CrewLook } from '../board/crew-view';
import type { AgentNoteLook } from '../board/items/agent-note-look';

export interface BoardChromeProps extends CreateToolbarProps {
  /** Whether the board has loaded: until then only the board menu shows, with the daemon's status. */
  loaded: boolean;
  /**
   * Whether the board holds nothing at all, for the empty board's welcome: nothing, not just no zones, so the welcome
   * never sits over a note or a shell.
   */
  empty: boolean;
  /**
   * Whether the board held nothing at all when it loaded, counting sessions, which `empty` only sees once they are laid
   * out: what decides a first run.
   */
  loadedEmpty: boolean;
  zones: readonly Zone[];
  agents: readonly Agent[];
  /** The Captain's panel: whether it is open, and the Captain button's toggle. */
  masterOpen: boolean;
  onMaster(): void;
  /** Undefined until the board has listed them. */
  shells: readonly Shell[] | undefined;
  /** Opens Add zone in the middle of the view, on the source's tab (GitHub without one). */
  onAddZone(source?: ZoneSource): void;
  /** Lays the zones out in rows and gathers the loose tiles below them. */
  onArrangeBoard(): void;
  onJump(zone: Zone): void;
  /** The zone last brought into view, which the zones pill marks and keeps in view. */
  currentZone?: string;
  /** Opens the keyboard cheat sheet. */
  onKeyboardHelp(): void;
  onOpenAgent(agent: Agent): void;
  onOpenShell(shell: Shell): void;
  onError(action: string): (error: unknown) => void;
  minimapColor(node: Node): string;
  /** Whether a drag snaps to the grid, and turns that on or off. */
  grid: boolean;
  onGrid(): void;
  /** Runs a command in a new shell tile loose on the board, and shows its window: onboarding's sign-ins. */
  onRunInShell(command: string): Promise<string | undefined>;
  /** Closes a session window, leaving its tile on the board. */
  onCloseWindow(id: string): void;
  /** What a double-click on an agent's or shell tile opens, for Settings, and picks it. */
  clickOpens: ClickOpens;
  onClickOpens(value: ClickOpens): void;
  crewLook: CrewLook;
  onCrewLook(value: CrewLook): void;
  agentNoteLook: AgentNoteLook;
  onAgentNoteLook(value: AgentNoteLook): void;
  connections: ConnectionsView;
  onConnections(value: ConnectionsView): void;
  /** When something on the board last asked for Settings (a zone's menu): the board menu opens on it each time it changes. */
  settingsAsked?: number;
}

/**
 * The app's chrome, floating over the full-bleed board: the board menu top left,
 * the creation toolbar top centre, the Needs-you pill top right, the zones bottom left, zoom and the minimap bottom
 * right. On macOS the traffic lights sit left of the board menu, and the window drags by the thin strip along the top
 * and the board menu's empty space (DecU, U2).
 */
export function BoardChrome({ loaded, empty, loadedEmpty, zones, agents, masterOpen, onMaster, shells, onAddZone, onArrangeBoard, onJump, currentZone, onKeyboardHelp, onOpenAgent, onOpenShell, onError, minimapColor, grid, onGrid, onRunInShell, onCloseWindow, clickOpens, onClickOpens, crewLook, onCrewLook, connections, onConnections, agentNoteLook, onAgentNoteLook, settingsAsked, ...toolbar }: BoardChromeProps) {
  const status = useDaemonStatus();
  const [menu, setMenu] = useState<BoardMenuState>({ open: false });
  useEffect(() => {
    if (settingsAsked !== undefined) setMenu({ open: true, at: 'settings', asked: settingsAsked });
  }, [settingsAsked]);
  const onboarding = useOnboarding(loaded, loadedEmpty, onError);

  const spotlight = useRef<SpotlightHandle>(null);

  // ⌘\ opens the board menu on its search field, and closes it (⌘K is the switcher's, which opens anywhere). Never while
  // typing: in a field, a note, a dialog or a session window's terminal, the key is the text's.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!pressed('move.boardMenu', event) || isTyping(event)) return;
      if ((event.target as Element | null)?.closest?.('.xterm')) return;
      event.preventDefault();
      setMenu((current) => (current.open ? { open: false } : { open: true, at: 'search', asked: event.timeStamp }));
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <>
      <div className="window-drag-strip" aria-hidden />
      <div className="window-drag-corner" aria-hidden />
      <BoardMenu
        menu={menu}
        onMenu={setMenu}
        status={status}
        zones={loaded ? zones : undefined}
        agents={agents}
        shells={shells}
        onJump={onJump}
        onAddZone={() => onAddZone()}
        onArrangeBoard={onArrangeBoard}
        onOpenAgent={onOpenAgent}
        onOpenShell={onOpenShell}
        onError={onError}
        clickOpens={clickOpens}
        onClickOpens={onClickOpens}
        crewLook={crewLook}
        onCrewLook={onCrewLook}
        agentNoteLook={agentNoteLook}
        onAgentNoteLook={onAgentNoteLook}
        connections={connections}
        onConnections={onConnections}
        onGettingStarted={onboarding.state?.showInMenu ? onboarding.reopen : undefined}
        onFind={() => spotlight.current?.open()}
      />
      {loaded && <BoardSpotlight ref={spotlight} agents={agents} shells={shells} zones={zones} />}
      {buildMismatch(status) && <BuildMismatch app={status.build} health={status.health} />}
      {loaded && (
        <>
          <CreateToolbar {...toolbar} />
          <NeedsYou agents={agents} onOpen={onOpenAgent} onSettings={() => setMenu({ open: true, at: 'settings', asked: performance.now() })} onMaster={onMaster} masterOpen={masterOpen} />
          <ZoneJump zones={zones} current={currentZone} onJump={onJump} onKeyboardHelp={onKeyboardHelp} />
          <ZoomControls nodeColor={minimapColor} grid={grid} onGrid={onGrid} connections={connections} onConnections={onConnections} crewLook={crewLook} onCrewLook={onCrewLook} />
          {empty && !onboarding.open && <EmptyBoard onAddZone={onAddZone} />}
          {onboarding.open && onboarding.state !== undefined && (
            <Onboarding
              showInMenu={onboarding.state.showInMenu}
              onShowInMenu={(showInMenu) => onboarding.save({ ...onboarding.state!, showInMenu })}
              onSignIn={onRunInShell}
              onSignedIn={onCloseWindow}
              onOpenLink={(url) => void window.agentBoard.trackers.openLink(url).catch(onError('open the link'))}
              onEnd={(end) => {
                onboarding.end();
                if (end === 'zone') onAddZone();
                if (end === 'sample') onboarding.setSample(true);
              }}
            />
          )}
          {onboarding.sample && <SampleBoard onLeave={() => onboarding.setSample(false)} />}
        </>
      )}
    </>
  );
}

/** Whether this window may open onboarding by itself: not when the main process says no (`?onboarding=off`, for tests). */
const ONBOARDING_ALLOWED = new URLSearchParams(window.location.search).get('onboarding') !== 'off';

/**
 * Onboarding's state: opened by itself on a first run (an empty board that never finished it) once the board has
 * loaded, reopened from Help › Getting started, and what the Finish step saved.
 */
function useOnboarding(loaded: boolean, empty: boolean, onError: (action: string) => (error: unknown) => void) {
  const [state, setState] = useState<OnboardingState>();
  const [open, setOpen] = useState(false);
  const [sample, setSample] = useState(false);

  // Once, when the board has loaded: whether it is empty is only asked then, so emptying it later opens nothing.
  const [asked, setAsked] = useState(false);
  useEffect(() => {
    if (!loaded || asked) return;
    setAsked(true);
    window.agentBoard.view.get(VIEW_KEYS.onboarding).then(
      (saved) => {
        setState(onboardingState(saved));
        if (ONBOARDING_ALLOWED && shouldOpenOnboarding(saved, empty)) setOpen(true);
      },
      (error: unknown) => {
        setState(onboardingState(null));
        onError('read whether onboarding was done')(error);
      },
    );
  }, [loaded, asked, empty, onError]);

  const save = useCallback(
    (next: OnboardingState) => {
      setState(next);
      window.agentBoard.view.set(VIEW_KEYS.onboarding, next).catch(onError('save onboarding'));
    },
    [onError],
  );

  const reopen = useCallback(() => {
    setSample(false);
    setOpen(true);
  }, []);
  useEffect(() => window.agentBoard.setup.onGettingStarted(reopen), [reopen]);

  return {
    state,
    open: open && state !== undefined,
    sample,
    setSample,
    save,
    reopen,
    /** Finished or skipped: it doesn't open by itself again. */
    end: () => {
      setOpen(false);
      save({ ...(state ?? onboardingState(null)), finished: true });
    },
  };
}
