// What first-run onboarding decides, apart from how it draws: when it opens, what each Connect row says, and where
// the quick tour's callouts go.
import type { ToolCheck } from '@agent-board/daemon/protocol';
import type { Rect } from '../geometry';

/** What the app keeps about onboarding in the daemon's view state (`VIEW_KEYS.onboarding`). */
export interface OnboardingState {
  /** It was finished or skipped, so it doesn't open by itself again. */
  finished: boolean;
  /** The board menu's Help section offers Getting started; the app menu's Help always does. */
  showInMenu: boolean;
}

/** What was saved, or how it starts when nothing was. */
export function onboardingState(saved: unknown): OnboardingState {
  const value = (typeof saved === 'object' && saved !== null ? saved : {}) as Partial<Record<keyof OnboardingState, unknown>>;
  return { finished: value.finished === true, showInMenu: value.showInMenu !== false };
}

/** Onboarding opens by itself on a first run: never finished or skipped, and nothing on the board yet. */
export function shouldOpenOnboarding(saved: unknown, boardEmpty: boolean): boolean {
  return boardEmpty && !onboardingState(saved).finished;
}

/** The onboarding steps, in order. */
export const ONBOARDING_STEPS = ['welcome', 'connect', 'tour', 'finish'] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

/** How onboarding ends: on the board, in the Add zone menu, or on the sample board. */
export type OnboardingEnd = 'board' | 'zone' | 'sample';

export const STEP_LABELS: Record<OnboardingStep, string> = { welcome: 'Welcome', connect: 'Connect', tour: 'Quick tour', finish: 'Finish' };

/** How far along a Connect row is: its badge. */
export type RowStatus = 'ready' | 'action' | 'missing' | 'checking';

/** What a CLI's row shows: its status and the one line beside its name. */
export function toolRow(check: ToolCheck | undefined): { status: RowStatus; detail: string } {
  if (check === undefined) return { status: 'checking', detail: 'checking…' };
  if (!check.found) return { status: 'missing', detail: 'not found' };
  const found = check.version === undefined ? 'found' : `found v${check.version}`;
  if (check.problem !== undefined) return { status: 'action', detail: `${found}, ${check.problem}` };
  if (check.signedIn === undefined) return { status: 'ready', detail: found };
  return check.signedIn ? { status: 'ready', detail: `${found}, signed in` } : { status: 'action', detail: check.version === undefined ? 'not signed in' : `${found}, not signed in` };
}

/** The Connect step's progress ring: how many rows are ready, and how many of the rest are required or optional. */
export function readySummary(rows: readonly { status: RowStatus; required: boolean }[]): {
  ready: number;
  total: number;
  title: string;
  detail: string;
} {
  const ready = rows.filter((row) => row.status === 'ready').length;
  const total = rows.length;
  if (ready === total) return { ready, total, title: 'All set', detail: 'Everything is connected' };
  const left = rows.filter((row) => row.status !== 'ready');
  const required = left.filter((row) => row.required).length;
  const optional = `${left.length - required} optional left`;
  return { ready, total, title: `${ready} of ${total} ready`, detail: required === 0 ? optional : `${required} required · ${optional}` };
}

/** Between a callout and its target, and the least between a callout and the window's edge. */
const CALLOUT_GAP = 20;
const EDGE = 16;

/**
 * Where a tour callout goes: under its target, or over it when there isn't room below, centred on it but inside the
 * window; `beak` is how far from the callout's left its pointer sits, under the target's middle. With no target (one
 * that isn't on the board), in the middle of the window.
 */
export function placeCallout(
  target: Rect | undefined,
  viewport: { width: number; height: number },
  size: { width: number; height: number },
): { side: 'below' | 'above' | 'centre'; left: number; top: number; beak: number | undefined } {
  if (target === undefined) {
    return { side: 'centre', left: (viewport.width - size.width) / 2, top: (viewport.height - size.height) / 2, beak: undefined };
  }
  const middle = target.x + target.width / 2;
  const left = Math.max(EDGE, Math.min(middle - size.width / 2, viewport.width - EDGE - size.width));
  const below = target.y + target.height + CALLOUT_GAP;
  const fitsBelow = below + size.height <= viewport.height - EDGE;
  return {
    side: fitsBelow ? 'below' : 'above',
    left,
    top: fitsBelow ? below : target.y - CALLOUT_GAP - size.height,
    beak: middle - left,
  };
}
