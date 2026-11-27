import type { AgentAlert } from '@agent-board/daemon/protocol';
import { ExternalLink } from 'lucide-react';
import { Button, useToast } from '../ui';
import { errorMessage } from '../../../shared/errors';
import { markSeen } from '../session/mark-seen';

/** An alert's line in its Done row, with how many alerts before it, still unread, it stands in place of. */
export function AlertLine({ alert, className }: { alert: AgentAlert; className: string }) {
  return (
    <p className={className} data-testid="inbox-done-line">
      {alert.line}
      {alert.folded > 0 && <span> (and {alert.folded} earlier)</span>}
    </p>
  );
}

/** Opens an alert's link in the browser, saying so when it can't. */
export function OpenAlertLink({ link, primary = false }: { link: string; primary?: boolean }) {
  const toast = useToast();
  const open = () => void window.agentBoard.trackers.openLink(link).catch((error: unknown) => toast.show({ tone: 'error', message: `Could not open the link: ${errorMessage(error)}` }));
  return (
    <Button size="sm" {...(primary ? { variant: 'primary' as const } : {})} icon={<ExternalLink />} onClick={open} tooltip={link}>
      Open link
    </Button>
  );
}

/** What a Done row's Open does: reads the alert, wherever the agent is shown already, then opens the agent. */
export function openAlerted(sessionId: string, onOpen: () => void): void {
  markSeen(sessionId, true);
  onOpen();
}
