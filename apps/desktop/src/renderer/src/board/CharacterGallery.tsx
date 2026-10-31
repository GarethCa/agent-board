import type { Harness } from '@agent-board/daemon/protocol';
import { HARNESSES } from '../harness';
import { Captain, CAPTAIN_SIZES, Character, CHARACTER_POSES } from './Character';

const GALLERY_HARNESSES: Harness[] = ['claude', 'codex'];

const CAPTAIN_PLACES = Object.keys(CAPTAIN_SIZES) as (keyof typeof CAPTAIN_SIZES)[];

/**
 * Every character pose in every body, for checking how they look, and with `captain` (the Simplified design) the
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
        {CHARACTER_POSES.map((pose) => (
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
