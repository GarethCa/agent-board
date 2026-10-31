import { HUMAN_STATUSES } from '@agent-board/daemon/human-status';
import { StatusMark } from './StatusMark';
import { STATUS_LOOK_LABELS, STATUS_LOOKS } from './status-look';

/** Every status in both looks, side by side, whichever is picked: the Simplified design's gallery shows it. */
export function StatusMarkGallery() {
  return (
    <table className="status-mark-gallery" data-testid="status-marks">
      <thead>
        <tr>
          {STATUS_LOOKS.map((look) => (
            <th key={look}>{STATUS_LOOK_LABELS[look]}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {HUMAN_STATUSES.map((status) => (
          <tr key={status}>
            {STATUS_LOOKS.map((look) => (
              <td key={look}>
                <StatusMark status={status} look={look} />
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
