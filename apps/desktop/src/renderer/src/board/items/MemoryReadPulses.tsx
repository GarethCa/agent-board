import { memo, useEffect, useState, type CSSProperties } from 'react';
import { useStoreApi, ViewportPortal } from '@xyflow/react';
import { motionDuration, tokenNumber } from '../../theme';
import { rectIn } from '../ask/SuggestionGhosts';
import { readPulse, type ReadPulse } from './memory-read-pulse';

/**
 * As an agent reads a memory, one soft dot goes from the memory to the agent's tile, once, and is gone: a passing
 * effect that is never an edge. Reduced motion shows none. A reader or memory off this board sends none.
 */
export const MemoryReadPulses = memo(function MemoryReadPulses() {
  const store = useStoreApi();
  const [pulses, setPulses] = useState<ReadPulse[]>([]);
  useEffect(() => {
    let next = 0;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const stop = window.agentBoard.items.onMemoryReadBy(({ itemId, reader }) => {
      const lasts = motionDuration(tokenNumber('--motion-handoff'));
      if (lasts === 0) return;
      const state = store.getState();
      const pulse = readPulse(next++, rectIn(state, { type: 'item', id: itemId }), rectIn(state, { type: 'agent', id: reader.sessionId }));
      if (pulse === undefined) return;
      setPulses((now) => [...now, pulse]);
      const timer = setTimeout(() => {
        timers.delete(timer);
        setPulses((now) => now.filter((each) => each.key !== pulse.key));
      }, lasts);
      timers.add(timer);
    });
    return () => {
      stop();
      for (const timer of timers) clearTimeout(timer);
    };
  }, [store]);
  if (pulses.length === 0) return null;
  return (
    <ViewportPortal>
      {pulses.map(({ key, x, y, dx, dy }) => (
        <span
          key={key}
          className="memory-read-pulse"
          data-testid="memory-read-pulse"
          aria-hidden="true"
          style={{ '--pulse-x': `${x}px`, '--pulse-y': `${y}px`, '--pulse-dx': `${dx}px`, '--pulse-dy': `${dy}px` } as CSSProperties}
        />
      ))}
    </ViewportPortal>
  );
});
