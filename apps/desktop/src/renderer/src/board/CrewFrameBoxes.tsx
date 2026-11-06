// The dashed crew frames drawn in a zone, under its tiles: each part of each orchestrator's crew there, the first labelled.
import type { CrewFrame } from './crews';

export function CrewFrameBoxes({ frames }: { frames: readonly CrewFrame[] }) {
  return frames.map((frame) => (
    <div
      key={`${frame.orchestratorId} ${frame.members[0]}`}
      className="crew-frame"
      data-testid="crew-frame"
      data-orchestrator={frame.orchestratorId}
      data-members={frame.members.join(' ')}
      style={{ left: frame.x, top: frame.y, width: frame.width, height: frame.height }}
    >
      {frame.labelled && <span className="crew-frame-label">{frame.name}&apos;s crew</span>}
    </div>
  ));
}
