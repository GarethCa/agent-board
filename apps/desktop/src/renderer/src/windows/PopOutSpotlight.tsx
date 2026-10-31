import { rowKeyOf, Spotlight, windowTargetOf } from '../chrome/Spotlight';
import type { BoardSubject } from '../chrome/spotlight-results';
import type { WindowTarget } from '../../../preload/api';
import { useLiveLists } from './use-live-lists';

/**
 * A popped-out window's ⌘K switcher: the same panel as the board's. ↵ shows the session picked in this window instead,
 * or brings forward the OS window it is out in already, the focus back where it was here. What the board does (a
 * zone, New agent) is asked of the board's window, which comes forward; so is a session picked in a tab window, which
 * has no session of its own to switch.
 */
export function PopOutSpotlight({ target, onSwitched }: { target: WindowTarget; onSwitched(to: WindowTarget): void }) {
  const { agents, shells, zones } = useLiveLists();
  const { windows } = window.agentBoard;

  const onPick = (from: WindowTarget, subject: BoardSubject): boolean | Promise<boolean> => {
    if (subject.kind === 'zone') {
      void windows.requestBoard({ kind: 'zone', zoneId: subject.zone.id });
      return true;
    }
    const to = windowTargetOf(subject)!;
    if (from.kind === 'tabs') {
      void windows.requestBoard({ kind: 'open', target: to });
      return true;
    }
    // Out in another OS window already, that one comes forward and the focus stays here.
    return windows.switchPopOut(to).then(
      (done) => {
        if (done === 'switched') onSwitched(to);
        return done === 'switched';
      },
      () => false,
    );
  };

  const zoneOf = ({ kind, id }: WindowTarget): string | null =>
    (kind === 'session' ? agents.find((agent) => agent.sessionId === id)?.zoneId : shells?.find((shell) => shell.id === id)?.zoneId) ?? null;

  return (
    <Spotlight
      agents={agents}
      shells={shells}
      zones={zones}
      placeOf={() => ({ context: target, mode: 'switch', current: rowKeyOf(target) })}
      onPick={onPick}
      canStartAgent={zones.some((zone) => zone.repoRoot !== null)}
      onNewAgent={(from, name) => void windows.requestBoard({ kind: 'newAgent', name, zoneId: zoneOf(from) })}
    />
  );
}
