import { useEffect, useReducer, type CSSProperties } from 'react';
import type { Harness, Subagent } from '@agent-board/daemon/protocol';
import { Character } from './Character';
import { useCharacterStyle } from './characters';
import { LEAVE_MS, perch, poseOf } from './perch';

/** How tall a perched subagent is drawn, in px. */
const PERCHED_HEIGHT = 22;

/**
 * An agent's subagents as characters perched on its tile's top edge, in the picked style (Off keeps the bean and block).
 * A new one pops in; a finished one drops its result and fades; past the cap (see `perch`) the rest show as an overflow
 * count.
 */
export function SubagentPerch({ harness, subagents }: { harness: Harness; subagents: readonly Subagent[] }) {
  // Redraws once the next leaving character is gone.
  const picked = useCharacterStyle();
  const [, redraw] = useReducer((count: number) => count + 1, 0);
  const { perched, overflow, nextChangeInMs } = perch(subagents, Date.now());
  useEffect(() => {
    if (nextChangeInMs === undefined) return;
    const timer = setTimeout(redraw, nextChangeInMs);
    return () => clearTimeout(timer);
  }, [nextChangeInMs]);

  if (perched.length === 0 && overflow === 0) return null;
  return (
    <div className="subagent-perch" data-testid="subagent-perch" style={{ '--leave-ms': `${LEAVE_MS}ms` } as CSSProperties}>
      {perched.map((subagent) => (
        <span
          key={subagent.id}
          className="subagent"
          data-leaving={subagent.endedAt !== null ? 'true' : undefined}
          title={subagent.result === null ? subagent.type : `${subagent.type}: ${subagent.result}`}
        >
          <Character harness={harness} pose={poseOf(subagent)} label={subagent.type} style={picked === 'off' ? 'bean' : picked} height={PERCHED_HEIGHT} />
        </span>
      ))}
      {overflow > 0 && (
        <span className="subagent-overflow" data-testid="subagent-overflow" title={`${overflow} more subagents`}>
          +{overflow}
        </span>
      )}
    </div>
  );
}
