// The Characters setting, one choice for the app under either design: picked in Settings › General › Design or the board
// menu's Quick settings, and heard by every window.

import { useSyncExternalStore } from 'react';
import { storedValue } from '../stored-value';

/** Off, or how an agent's character is drawn. */
export const CHARACTER_STYLES = ['off', 'bean', 'pebble', 'pixel'] as const;
export type CharacterStyle = (typeof CHARACTER_STYLES)[number];
/** A style a character can be drawn in. */
export type DrawnStyle = Exclude<CharacterStyle, 'off'>;

const DEFAULT_STYLE: CharacterStyle = 'bean';

/** Each choice's name, as Settings shows it. */
export const CHARACTER_STYLE_LABELS: Record<CharacterStyle, string> = { off: 'Off', bean: 'Bean & Block', pebble: 'Pebble', pixel: 'Pixel' };

/** One dip as a character changes, or none. */
export const CHARACTER_MOTIONS = ['move', 'still'] as const;
export type CharacterMotion = (typeof CHARACTER_MOTIONS)[number];

const DEFAULT_MOTION: CharacterMotion = 'move';

export const CHARACTER_MOTION_LABELS: Record<CharacterMotion, string> = { move: 'Move on change', still: 'Still' };

const storedStyle = storedValue('agent-board.character-style');
const storedMotion = storedValue('agent-board.character-motion');

/** The stored style, or the default for none or one this version doesn't know. */
export function characterStyleOf(value: string | undefined): CharacterStyle {
  return CHARACTER_STYLES.find((style) => style === value) ?? DEFAULT_STYLE;
}

/** The stored motion, or the default for none or one this version doesn't know. */
export function characterMotionOf(value: string | undefined): CharacterMotion {
  return CHARACTER_MOTIONS.find((motion) => motion === value) ?? DEFAULT_MOTION;
}

export function setCharacterStyle(style: CharacterStyle): void {
  storedStyle.set(style);
}

export function setCharacterMotion(motion: CharacterMotion): void {
  storedMotion.set(motion);
}

/** The picked style, kept current as it is picked here or in another window. */
export function useCharacterStyle(): CharacterStyle {
  return useSyncExternalStore(storedStyle.subscribe, () => characterStyleOf(storedStyle.get()), () => DEFAULT_STYLE);
}

/** The picked motion, kept current as it is picked here or in another window. */
export function useCharacterMotion(): CharacterMotion {
  return useSyncExternalStore(storedMotion.subscribe, () => characterMotionOf(storedMotion.get()), () => DEFAULT_MOTION);
}

/** The motion now, for a character about to change: no need to hear every pick to read it once. */
export function characterMotionNow(): CharacterMotion {
  return characterMotionOf(storedMotion.get());
}
