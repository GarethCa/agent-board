import type { ReactNode } from 'react';
import type { NeedsYouKind } from '@agent-board/daemon/protocol';
import { CircleCheck, ClipboardList, Flag, ListTodo, MessageCircleQuestion, ShieldAlert } from 'lucide-react';

/** Each kind of request's tag on its row: in the needs-you inbox and the master's For you. */
export const KIND_TAGS: Record<NeedsYouKind, { label: string; icon?: ReactNode }> = {
  asks: { label: 'asks', icon: <MessageCircleQuestion aria-hidden /> },
  plan: { label: 'plan', icon: <ClipboardList aria-hidden /> },
  steps: { label: 'steps', icon: <ListTodo aria-hidden /> },
  todo: { label: 'to-do', icon: <CircleCheck aria-hidden /> },
  permission: { label: 'permission', icon: <ShieldAlert aria-hidden /> },
  flagged: { label: 'flagged', icon: <Flag aria-hidden /> },
  turn: { label: 'turn ended' },
};
