import type { Harness } from '@agent-board/daemon/protocol';
import { HARNESSES } from '../harness';

const SHELL = { label: 'Shell', color: 'var(--harness-shell)' };

/**
 * A stand-in for the harness's mark, in its colour, until the official marks land: plain shapes
 * that don't imitate either vendor's. A ringed dot for Claude, a filled terminal block for Codex (the Components mock),
 * and an outlined one for a plain shell.
 */
export function HarnessMark({ harness, className }: { harness: Harness | 'shell'; className?: string }) {
  const { label, color } = harness === 'shell' ? SHELL : HARNESSES[harness];
  return (
    <svg className={className} viewBox="-8 -8 16 16" width="14" height="14" role="img" aria-label={label}>
      <g style={{ stroke: color }} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none">
        {harness === 'claude' && (
          <>
            <circle r="6" />
            <circle r="2" style={{ fill: color }} stroke="none" />
          </>
        )}
        {harness === 'codex' && (
          <>
            <rect x="-7" y="-7" width="14" height="14" rx="4" style={{ fill: color }} stroke="none" />
            <path d="M -3.2 -2 L -0.8 0 L -3.2 2 M 0.6 2.5 L 3.4 2.5" style={{ stroke: 'var(--figure-paper)' }} strokeWidth="1.5" />
          </>
        )}
        {harness === 'shell' && (
          <>
            <rect x="-6.5" y="-6.5" width="13" height="13" rx="3" strokeWidth="1.6" />
            <path d="M -3.5 -2 L -1 0.5 L -3.5 3 M 0.5 3 L 3.5 3" strokeWidth="1.6" />
          </>
        )}
      </g>
    </svg>
  );
}
