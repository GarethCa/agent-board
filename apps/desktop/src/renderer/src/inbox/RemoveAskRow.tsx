import { useState } from 'react';
import type { Agent, RemoveAsk } from '@agent-board/daemon/protocol';
import { Timer } from 'lucide-react';
import { Button, Checkbox, ErrorText } from '../ui';
import { useAction } from '../use-action';
import { waitLeft } from '../../../shared/needs-you';
import { allowWords, heldIds, removeAskList } from './remove-ask';

/**
 * An orchestrator's ask to remove tiles it didn't start: one Deny and one Allow for the whole list. The first
 * few names show, then "… N more" opens the rest. A tile still running, with a live agent it started, or with a
 * reviewer that stays, is listed apart under why (said once for the tiles it holds, cut to the first few as the rest
 * are), and goes only if ticked: one by one, or all with "Include all". Nothing is removed until Allow is pressed, and
 * Return presses nothing.
 */
export function RemoveAskRow({ agent, ask, now }: { agent: Agent; ask: RemoveAsk; now: number }) {
  const { busy, error, run } = useAction();
  const [open, setOpen] = useState(false);
  const [heldOpen, setHeldOpen] = useState(false);
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const list = removeAskList(ask, open, heldOpen);
  const allHeld = heldIds(ask);
  const tick = (sessionId: string, on: boolean) => {
    const next = new Set(ticked);
    if (on) next.add(sessionId);
    else next.delete(sessionId);
    setTicked(next);
  };
  const decide = (allow: boolean) => run(() => window.agentBoard.agents.decideRemove(agent.sessionId, ask.id, allow, allow ? [...ticked] : []));
  return (
    <div className="inbox-prompt inbox-remove-ask" data-testid="inbox-remove-ask">
      <p className="inbox-item-tool">{list.heading}, each with its worktree and branch:</p>
      {list.shown.length > 0 && (
        <ul className="inbox-remove-tiles" aria-label="Removed on Allow">
          {list.shown.map((tile) => (
            <li key={tile.sessionId} data-testid="inbox-remove-tile">
              {tile.name}
            </li>
          ))}
        </ul>
      )}
      {list.more > 0 && (
        <Button size="sm" variant="ghost" className="inbox-item-expand" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? 'Show less' : `… ${list.more} more`}
        </Button>
      )}
      {list.heldCount > 0 && (
        <div className="inbox-remove-held" aria-label="Kept unless ticked">
          {list.heldCount > 1 && (
            <Checkbox
              label={`Include all ${list.heldCount} held back`}
              checked={allHeld.every((id) => ticked.has(id))}
              disabled={busy}
              onChange={(event) => setTicked(new Set(event.target.checked ? allHeld : []))}
            />
          )}
          {list.held.map((group) => (
            <div key={group.why} className="inbox-remove-group">
              <p className="inbox-remove-why">Kept unless ticked: {group.why}</p>
              <ul>
                {group.tiles.map((tile) => (
                  <li key={tile.sessionId} data-testid="inbox-remove-held">
                    <Checkbox label={tile.name} checked={ticked.has(tile.sessionId)} disabled={busy} onChange={(event) => tick(tile.sessionId, event.target.checked)} />
                  </li>
                ))}
              </ul>
            </div>
          ))}
          {list.heldMore > 0 && (
            <Button size="sm" variant="ghost" className="inbox-item-expand" aria-expanded={heldOpen} onClick={() => setHeldOpen(!heldOpen)}>
              {heldOpen ? 'Show fewer held back' : `… ${list.heldMore} more held back`}
            </Button>
          )}
        </div>
      )}
      <div className="inbox-item-actions">
        <Button size="sm" variant="danger" disabled={busy} aria-label={`Deny ${agent.name}'s ask to remove tiles`} onClick={() => decide(false)}>
          Deny
        </Button>
        <Button size="sm" variant="primary" disabled={busy} aria-label={`Allow ${agent.name} to remove them`} onClick={() => decide(true)}>
          {allowWords(ask, ticked)}
        </Button>
      </div>
      <p className="inbox-ask-timer">
        <Timer aria-hidden />
        <span>Waits {waitLeft(ask.expiresAt, now)}; no answer removes nothing</span>
      </p>
      {error && <ErrorText>{error}</ErrorText>}
    </div>
  );
}
