import type { Harness } from '@agent-board/daemon/protocol';
import { HARNESSES } from '../harness';
import { Character, CHARACTER_POSES } from './Character';

const GALLERY_HARNESSES: Harness[] = ['claude', 'codex'];

/** Every character pose in every body, for checking how they look. The app shows it at `#gallery`. */
export function CharacterGallery() {
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
      </tbody>
    </table>
  );
}
