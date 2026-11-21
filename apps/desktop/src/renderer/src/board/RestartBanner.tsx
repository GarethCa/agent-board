import { useEffect, useState, type ReactNode } from 'react';
import type { Agent, Shell } from '@agent-board/daemon/protocol';
import { Play, RotateCcw } from 'lucide-react';
import { VIEW_KEYS } from '../../../shared/view-saver';
import { Button, ToastView } from '../ui';
import {
  carryOn,
  cutOffBack,
  dismissedStill,
  restartBannerShown,
  restartIds,
  restartMessage,
  restartPassRunning,
  stoppedByRestart,
  undismissed,
  wakeAll,
} from './restart';
import type { TileActions } from './tile';

/** Whether the app runs on a Mac, for the banner's words. */
const MAC = navigator.userAgent.includes('Macintosh');

/**
 * The restart banner (a toast, chrome C), while there are sessions a restart stopped, or agents it cut off mid-turn
 * that the daemon's start brought back, that the user hasn't dismissed it for; or null. The daemon's start brings back
 * what its restart stopped, typing nothing to any: the banner says how many came back, how many of those were cut off
 * mid-turn and how many stayed stopped. Carry on, for the ones cut off, tells each to carry on from where it was (the
 * user's ask, never the app's), and nothing else: it puts away those told, and one that couldn't be told keeps its
 * Carry on. With none left to tell, Wake all wakes only the stopped agents that were mid-turn (and reopens the shells'
 * panes), of those not dismissed; the rest stay asleep, each with its own Wake. Wake all, or Dismiss, puts the banner
 * away, so either is pressed once. The board places it: on the board, or in the session window shown over it.
 */
export function useRestartBanner(
  agents: readonly Agent[],
  shells: readonly Shell[] | undefined,
  actions: Pick<TileActions, 'resumeAgent' | 'resumeShell' | 'carryOnAgent'>,
): ReactNode {
  /** Undefined until read back, so the banner doesn't flash up for sessions dismissed already. */
  const [dismissed, setDismissed] = useState<string[]>();
  /** The cut-off agents a Carry on is telling now: not offered it again until it has. */
  const [telling, setTelling] = useState<readonly string[]>([]);
  useEffect(() => {
    window.agentBoard.view.get(VIEW_KEYS.restartDismissed).then(
      (saved) => setDismissed(Array.isArray(saved) ? saved.filter((id): id is string => typeof id === 'string') : []),
      () => setDismissed([]),
    );
  }, []);
  const stopped = stoppedByRestart(agents, shells);
  const cutOff = cutOffBack(agents);
  const ids = restartIds(stopped, cutOff);
  const save = (next: string[]) => {
    setDismissed(next);
    window.agentBoard.view.set(VIEW_KEYS.restartDismissed, next).catch(() => {});
  };
  // Once the shells are listed too, so a pane isn't taken for resumed just because it isn't known yet.
  const stale = dismissed !== undefined && shells !== undefined && dismissedStill(dismissed, ids).length < dismissed.length;
  useEffect(() => {
    if (stale) save(dismissedStill(dismissed!, ids));
  });
  if (dismissed === undefined || restartPassRunning(agents)) return null;
  const hidden = [...dismissed, ...telling];
  if (!restartBannerShown(ids, hidden)) return null;
  const shown = undismissed(stopped, dismissed);
  const offered = cutOff.filter((agent) => !hidden.includes(agent.sessionId));
  const wakes = wakeAll(shown);
  const wake = () => {
    for (const agent of wakes?.agents ?? []) void actions.resumeAgent(agent.sessionId);
    for (const shell of wakes?.shells ?? []) void actions.resumeShell(shell);
  };
  return (
    <div
      className="restart-banner"
      data-testid="restart-banner"
      data-count={shown.ids.length}
      data-working={wakes?.agents.length ?? 0}
      data-cut-off={offered.length}
    >
      <ToastView
        message={restartMessage(shown, MAC, agents)}
        action={
          offered.length > 0
            ? {
                label: 'Carry on',
                icon: <Play />,
                keepsOpen: true,
                onClick() {
                  const asked = offered.map((agent) => agent.sessionId);
                  setTelling((now) => [...now, ...asked]);
                  void carryOn(offered, actions.carryOnAgent).then((told) => {
                    setDismissed((now) => {
                      const next = [...new Set([...(now ?? []), ...told])];
                      window.agentBoard.view.set(VIEW_KEYS.restartDismissed, next).catch(() => {});
                      return next;
                    });
                    setTelling((now) => now.filter((id) => !asked.includes(id)));
                  });
                },
              }
            : wakes === null
              ? undefined
              : { label: 'Wake all', icon: <Play />, onClick: wake }
        }
        onDismiss={() => save(ids)}
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
