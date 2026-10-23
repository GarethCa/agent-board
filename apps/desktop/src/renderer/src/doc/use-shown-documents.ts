import { useEffect, useRef } from 'react';
import type { Agent, DocumentSummary } from '@agent-board/daemon/protocol';
import { newlyShown } from './doc-view';

/** Calls `onShown` for each document an agent shows (or shows again) while the board is open, once each time. */
export function useShownDocuments(agents: readonly Agent[], onShown: (agent: Agent, document: DocumentSummary) => void): void {
  const seen = useRef<ReadonlyMap<string, string>>(undefined);
  const latest = useRef(onShown);
  latest.current = onShown;
  useEffect(() => {
    // Not before the board has heard of its agents: an empty first list would make every document new.
    if (agents.length === 0 && seen.current === undefined) return;
    const next = newlyShown(seen.current, agents);
    seen.current = next.seen;
    for (const { agent, document } of next.shown) latest.current(agent, document);
  }, [agents]);
}
