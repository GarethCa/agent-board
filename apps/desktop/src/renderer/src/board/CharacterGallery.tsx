import { useState } from 'react';
import { AGENT_FACES, AGENT_PROPS } from '@agent-board/daemon/character';
import type { Harness } from '@agent-board/daemon/protocol';
import { useSimplified } from '../design';
import { HARNESSES } from '../harness';
import { Captain, CAPTAIN_SIZES, Character } from './Character';
import { CHARACTER_POSES, type CharacterPose } from './character-figures';
import { MARK_CHARACTER_HEIGHT } from './StatusMark';
import { TileCharacter } from './TileCharacter';
import { CHARACTER_STYLE_LABELS, type DrawnStyle } from './characters';

const GALLERY_HARNESSES: Harness[] = ['claude', 'codex'];

const CAPTAIN_PLACES = Object.keys(CAPTAIN_SIZES) as (keyof typeof CAPTAIN_SIZES)[];

const STYLES: DrawnStyle[] = ['bean', 'pebble', 'pixel'];

/** The poses `#gallery` shows, each a subagent can strike: every pose in every style has its own page. */
const SUBAGENT_POSES = CHARACTER_POSES.slice(0, 10);

/** Every pose in every style and body, at a tile's size: a page of its own at `#gallery-characters`. */
export function CharacterStylesGallery() {
  return (
    <table className="character-gallery" data-testid="character-styles">
      <thead>
        <tr>
          <th />
          {STYLES.map((style) => (
            <th key={style} colSpan={GALLERY_HARNESSES.length}>
              {CHARACTER_STYLE_LABELS[style]}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {CHARACTER_POSES.map((pose) => (
          <tr key={pose}>
            <th>{pose}</th>
            {STYLES.flatMap((style) =>
              GALLERY_HARNESSES.map((harness) => (
                <td key={`${style}/${harness}`}>
                  <Character harness={harness} pose={pose} style={style} height={34} />
                </td>
              )),
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * Every face and prop an agent may give its pose, in every style and body: the faces on reading, the props on writing.
 * On the same page as the poses, as `#gallery-characters`, at the size the design draws an agent's character: Simplified's
 * status mark is smaller than Classic's tile.
 */
export function CharacterLooksGallery() {
  const height = useSimplified() ? MARK_CHARACTER_HEIGHT : 34;
  const looks = [...AGENT_FACES.map((face) => ({ name: face, pose: 'reading' as const, face })), ...AGENT_PROPS.map((prop) => ({ name: prop, pose: 'writing' as const, prop }))];
  return (
    <table className="character-gallery" data-testid="character-looks">
      <tbody>
        {looks.map(({ name, ...look }) => (
          <tr key={name}>
            <th>{name}</th>
            {STYLES.flatMap((style) =>
              GALLERY_HARNESSES.map((harness) => (
                <td key={`${style}/${harness}`}>
                  <Character harness={harness} {...look} style={style} height={height} />
                </td>
              )),
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const DEMO_POSES: CharacterPose[] = ['thinking', 'running', 'waiting'];

/** A tile's character to change by hand, to see it hold and dip as the board's would. */
export function CharacterChangeDemo() {
  const [pose, setPose] = useState<CharacterPose>('thinking');
  const [shown, setShown] = useState(true);
  return (
    <div className="character-change-demo" data-testid="character-change-demo">
      {DEMO_POSES.map((each) => (
        <button key={each} type="button" onClick={() => setPose(each)}>
          {each}
        </button>
      ))}
      <button type="button" onClick={() => setShown(!shown)}>
        toggle
      </button>
      {shown && <TileCharacter harness="claude" pose={pose} style="bean" height={34} />}
    </div>
  );
}

/**
 * Every subagent's pose in every body, for checking how they look, and with `captain` (the Simplified design) the
 * Captain at each of its sizes. The app shows it at `#gallery`.
 */
export function CharacterGallery({ captain = false }: { captain?: boolean }) {
  return (
    <table className="character-gallery" data-testid="character-gallery">
      <thead>
        <tr>
          <th />
          {GALLERY_HARNESSES.map((harness) => (
            <th key={harness}>{HARNESSES[harness].label}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {SUBAGENT_POSES.map((pose) => (
          <tr key={pose}>
            <th>{pose}</th>
            {GALLERY_HARNESSES.map((harness) => (
              <td key={harness}>
                <Character harness={harness} pose={pose} />
              </td>
            ))}
          </tr>
        ))}
        {captain && (
          <tr>
            <th>captain</th>
            <td colSpan={GALLERY_HARNESSES.length}>
              {CAPTAIN_PLACES.map((place) => (
                <Captain key={place} size={place} />
              ))}
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}
