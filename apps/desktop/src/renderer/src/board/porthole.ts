// How the Porthole design draws a glance tile's state: the ring round its round window and its word. Pure,
// so it is unit-tested; PortholeTile.tsx draws it.
import type { GlanceFace } from './glance-tile';

/** What a porthole reads of its glance face: its state and how loud it is (an exited agent is quiet, though failed). */
type PortholeFacts = Pick<GlanceFace, 'state' | 'level'>;

/** The ring round the porthole: colour fills it only for what wants the user (ask) or went wrong (problem). */
export type PortholeRing = 'plain' | 'work' | 'ask' | 'problem' | 'done';

export function portholeRing({ state, level }: PortholeFacts): PortholeRing {
  if (state === 'done') return 'done';
  return (['plain', 'work', 'ask', 'problem'] as const)[level];
}

/** How its state's word is drawn: a filled chip when it wants the user, else a word coloured for work, done or a limit. */
export type PortholeWordTone = 'chip' | 'work' | 'done' | 'limit' | 'quiet';

export function portholeWordTone({ state, level }: PortholeFacts): PortholeWordTone {
  if (level >= 2) return 'chip';
  if (level === 1) return 'work';
  return state === 'done' ? 'done' : state === 'limit' ? 'limit' : 'quiet';
}
