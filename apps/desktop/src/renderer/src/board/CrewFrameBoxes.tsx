// The dashed crew frames drawn in a zone, under its tiles: each part of each orchestrator's crew there, the first
// labelled. Each is always there but shows only while its orchestrator is focused (`data-focused`).
import { useFocusedCrews } from './crew-view';
import type { CrewFrame } from './crews';

export function CrewFrameBoxes({ frames }: { frames: readonly CrewFrame[] }) {
  const focused = useFocusedCrews();
  return frames.map((frame) => (
    <div
      key={`${frame.orchestratorId} ${frame.members[0]}`}
      className="crew-frame"
      data-testid="crew-frame"
      data-orchestrator={frame.orchestratorId}
      data-members={frame.members.join(' ')}
      data-focused={focused.has(frame.orchestratorId) || undefined}
      style={{ left: frame.x, top: frame.y, width: frame.width, height: frame.height }}
    >
      {frame.labelled && <span className="crew-frame-label">{frame.name}&apos;s crew</span>}
    </div>
  ));
}
