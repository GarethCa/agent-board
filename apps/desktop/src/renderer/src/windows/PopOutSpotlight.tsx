import { rowKeyOf, Spotlight, surfaceOfSubject, windowTargetOf } from '../chrome/Spotlight';
import type { BoardSubject } from '../chrome/spotlight-results';
import type { WindowTarget } from '../../../preload/api';
import { requestTab } from '../session/tab-request';
import { useLiveLists } from './use-live-lists';

/**
 * A popped-out window's ⌘K switcher: the same panel as the board's. ↵ shows the session picked in this window instead,
 * or brings forward the OS window it is out in already, the focus back where it was here. What the board does (a
 * zone, New agent) is asked of the board's window, which comes forward; so is a session picked in a tab window, which
 * has no session of its own to switch. A pull request or page opens as a tab here; ⇧↵ opens a session, pull request
 * or page beside what this window shows, in a pane of its own.
 */
export function PopOutSpotlight({ target, onSwitched }: { target: WindowTarget; onSwitched(to: WindowTarget): void }) {
  const { agents, shells, zones } = useLiveLists();
  const { windows } = window.agentBoard;

  const onPick = (from: WindowTarget, subject: BoardSubject, _open: boolean, _windowed: boolean, beside: boolean): boolean | Promise<boolean> => {
    if (subject.kind === 'zone') {
      void windows.requestBoard({ kind: 'zone', zoneId: subject.zone.id });
      return true;
    }
    const surface = surfaceOfSubject(subject);
    if (surface !== undefined && (beside || subject.kind === 'pr' || subject.kind === 'web' || subject.kind === 'document')) {
      requestTab(from.id, surface, { beside });
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
      onCrew={(from, prefab, describe) => void windows.requestBoard({ kind: 'crew', prefab, zoneId: zoneOf(from), ...(describe === true ? { describe } : {}) })}
    />
  );
}
