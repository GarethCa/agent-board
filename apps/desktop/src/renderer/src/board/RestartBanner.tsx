import { useEffect, useState, type ReactNode } from 'react';
import type { Agent, Shell } from '@agent-board/daemon/protocol';
import { RotateCcw } from 'lucide-react';
import { VIEW_KEYS } from '../../../shared/view-saver';
import { Button, ToastView } from '../ui';
import { dismissedStill, restartBannerShown, restartMessage, stoppedByRestart } from './restart';
import type { TileActions } from './tile';

/** Whether the app runs on a Mac, for the banner's words. */
const MAC = navigator.userAgent.includes('Macintosh');

/**
 * The restart banner (a toast, chrome C), while a restart has stopped sessions the user hasn't dismissed it for, or
 * null: how many it stopped, with Resume all and Dismiss. Nothing starts again, and no tokens are spent, until the user
 * picks; each stopped tile has its own Resume. Either button puts it away, so Resume all is pressed once. The board
 * places it: on the board, or in the session window shown over it.
 */
export function useRestartBanner(
  agents: readonly Agent[],
  shells: readonly Shell[] | undefined,
  actions: Pick<TileActions, 'resumeAgent' | 'resumeShell'>,
): ReactNode {
  /** Undefined until read back, so the banner doesn't flash up for sessions dismissed already. */
  const [dismissed, setDismissed] = useState<string[]>();
  useEffect(() => {
    window.agentBoard.view.get(VIEW_KEYS.restartDismissed).then(
      (saved) => setDismissed(Array.isArray(saved) ? saved.filter((id): id is string => typeof id === 'string') : []),
      () => setDismissed([]),
    );
  }, []);
  const stopped = stoppedByRestart(agents, shells);
  const save = (ids: string[]) => {
    setDismissed(ids);
    window.agentBoard.view.set(VIEW_KEYS.restartDismissed, ids).catch(() => {});
  };
  // Once the shells are listed too, so a pane isn't taken for resumed just because it isn't known yet.
  const stale = dismissed !== undefined && shells !== undefined && dismissedStill(dismissed, stopped.ids).length < dismissed.length;
  useEffect(() => {
    if (stale) save(dismissedStill(dismissed!, stopped.ids));
  });
  if (dismissed === undefined || !restartBannerShown(stopped.ids, dismissed)) return null;
  return (
    <div className="restart-banner" data-testid="restart-banner" data-count={stopped.ids.length}>
      <ToastView
        message={restartMessage(stopped.ids.length, MAC)}
        action={{
          label: 'Resume all',
          onClick() {
            for (const agent of stopped.agents) void actions.resumeAgent(agent.sessionId);
            for (const shell of stopped.shells) void actions.resumeShell(shell);
          },
        }}
        onDismiss={() => save(stopped.ids)}
      />
    </div>
  );
}

/**
 * Resume, for a session a restart stopped (or `label`, e.g. Restart shell for one that exited): pressed once, it waits
 * for the resume to land or fail.
 */
export function ResumeButton({
  onResume,
  className,
  label = 'Resume',
  testId = 'resume',
}: {
  onResume(): Promise<unknown>;
  className?: string;
  label?: string;
  testId?: string;
}) {
  const [pending, setPending] = useState(false);
  return (
    <Button
      size="xs"
      variant="primary"
      icon={<RotateCcw />}
      className={className}
      data-testid={testId}
      disabled={pending}
      onClick={() => {
        setPending(true);
        void onResume().finally(() => setPending(false));
      }}
    >
      {label}
    </Button>
  );
}
