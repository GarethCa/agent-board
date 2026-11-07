import { HUMAN_STATUSES, type HumanStatus } from '@agent-board/daemon/human-status';
import type { CharacterPose } from './character-figures';
import { StatusMark } from './StatusMark';

/** A pose to show each status by. */
const STATUS_POSES: Record<HumanStatus, CharacterPose> = {
  'needs-you': 'waiting',
  working: 'running',
  done: 'done',
  paused: 'hibernated',
  scheduled: 'on-command',
  problem: 'failed',
};

/** Every status as its glyph and as a character, side by side: the Simplified design's gallery shows it. */
export function StatusMarkGallery() {
  return (
    <table className="status-mark-gallery" data-testid="status-marks">
      <thead>
        <tr>
          <th>Icons and words</th>
          <th>Characters</th>
        </tr>
      </thead>
      <tbody>
        {HUMAN_STATUSES.map((status) => (
          <tr key={status}>
            <td>
              <StatusMark status={status} />
            </td>
            <td>
              <StatusMark status={status} character={{ harness: 'claude', pose: STATUS_POSES[status] }} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
