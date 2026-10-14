import type { Agent, AgentState } from '@agent-board/daemon/protocol';
import { APP_NAME } from '../shared/brand';
import { unseenCount } from '../shared/needs-you';

/**
 * The whole app's state, which the mark shows (brand/BRAND.md, "States"): `needs` while an agent waits for input or
 * permission, `working` while one is mid-turn and none waits, `quiet` otherwise.
 */
export type AppState = 'needs' | 'working' | 'quiet';

/** The mark's colourway: desk blue, or dark in dark mode. */
export type Colourway = 'blue' | 'dark';

/** A dock icon in brand/png/dock-states/, without its `-1024.png`. */
export type DockIcon = `dock-${Colourway}-${AppState}`;

/**
 * States a live agent counts as working in: mid-turn, a rate-limited one included, as it carries on by itself. An
 * idle or scheduled agent sits at its prompt and is quiet.
 */
const WORKING: ReadonlySet<AgentState> = new Set<AgentState>(['running', 'thinking', 'rate-limited', 'handing-off']);

/** The app's state, and how many agents wait for the user (the needs-you inbox's unseen asks). */
export interface AppStatus {
  state: AppState;
  waiting: number;
}

/** The app's status over `agents`. */
export function appStateOf(agents: readonly Agent[]): AppStatus {
  const waiting = unseenCount(agents);
  if (waiting > 0) return { state: 'needs', waiting };
  const working = agents.some((agent) => agent.endedAt === null && WORKING.has(agent.state));
  return { state: working ? 'working' : 'quiet', waiting };
}

/** What the OS shows of the app's state: the same rule for the dock icon, its badge, the menu-bar dot and the tooltip. */
export interface AppIndicator {
  dockIcon: DockIcon;
  /** The number of agents waiting: the badge, which 0 clears. */
  badge: number;
  /** Whether the red dot shows beside the menu-bar icon. */
  menuBarDot: boolean;
  tooltip: string;
}

export function appIndicator({ state, waiting }: AppStatus, colourway: Colourway): AppIndicator {
  const tooltip = {
    needs: `${APP_NAME}: ${waiting === 1 ? '1 agent needs' : `${waiting} agents need`} you`,
    working: `${APP_NAME}: agents working`,
    quiet: `${APP_NAME}: nothing running`,
  }[state];
  return { dockIcon: `dock-${colourway}-${state}`, badge: waiting, menuBarDot: state === 'needs', tooltip };
}
