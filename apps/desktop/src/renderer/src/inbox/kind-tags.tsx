import type { ReactNode } from 'react';
import type { NeedsYouKind } from '@agent-board/daemon/protocol';
import { Flag, ShieldAlert } from 'lucide-react';

/** Each kind of request's tag on its row: in the needs-you inbox and the master's For you. */
export const KIND_TAGS: Record<NeedsYouKind, { label: string; icon?: ReactNode }> = {
  asks: { label: 'asks' },
  plan: { label: 'plan' },
  permission: { label: 'permission', icon: <ShieldAlert aria-hidden /> },
  flagged: { label: 'flagged', icon: <Flag aria-hidden /> },
  turn: { label: 'turn ended' },
};
