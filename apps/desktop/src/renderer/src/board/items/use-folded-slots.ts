import { useSyncExternalStore } from 'react';
import { type Fold, type FoldedSlot } from '../../board-colors';
import { token } from '../../theme';

const subscribe = (notify: () => void) => {
  const watch = new MutationObserver(notify);
  watch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-design'] });
  return () => watch.disconnect();
};

/** The look shown now: its theme, and its design, as the Simplified design's light shares the theme `light`. */
const themeNow = () => `${document.documentElement.dataset.theme ?? ''}|${document.documentElement.dataset.design ?? ''}`;

/** Each fold's result for each look, read once: a look's tokens never change while the app runs. */
const folded = new WeakMap<Fold<string>, Map<string, FoldedSlot<string>[]>>();

/** `fold` in the theme shown now, for the board's context menu (built when it opens) and anything else outside a render. */
export function foldedNow<S extends string>(fold: Fold<S>, theme: string = themeNow()): FoldedSlot<S>[] {
  const themes = folded.get(fold) ?? new Map<string, FoldedSlot<string>[]>();
  folded.set(fold, themes);
  const known = themes.get(theme);
  if (known !== undefined) return known as FoldedSlot<S>[];
  const made = fold((name) => token(name as `--${string}`));
  themes.set(theme, made);
  return made;
}

/** A picker row's slots with the ones that paint alike in the theme shown folded into the first, as it changes. */
export function useFoldedSlots<S extends string>(fold: Fold<S>): FoldedSlot<S>[] {
  return foldedNow(fold, useSyncExternalStore(subscribe, themeNow));
}
