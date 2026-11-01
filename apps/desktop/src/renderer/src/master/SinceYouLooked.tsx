import { Check, ChevronRight } from 'lucide-react';
import type { Agent } from '@agent-board/daemon/protocol';
import { Button } from '../ui';
import { Captain } from '../board/Character';
import { clockTime } from '../board/items/agent-note';
import { useNeedsYouShows } from '../needs-you-setting';
import { useSinceLastLooked } from '../session/mark-seen';
import { askingIds, isEmptyDigest, lookedAt, MAX_DONE_ROWS, sinceLastLooked } from './digest';

/**
 * The Simplified pane's digest, under the Needs-you list: what finished since the user last had the list in view (the
 * app's own record, so it is always true), and the Captain's line on what comes next. Nothing needs the user here;
 * that is the list above. With nothing to report it is not drawn.
 */
export function SinceYouLooked({ agents, onOpenAgent }: { agents: readonly Agent[]; onOpenAgent(agent: Agent): void }) {
  const { since, markSeen } = useSinceLastLooked();
  const asking = askingIds(agents, useNeedsYouShows());
  const digest = sinceLastLooked(agents, since, asking);
  if (isEmptyDigest(digest)) return null;
  const shown = digest.done.slice(0, MAX_DONE_ROWS);
  const more = digest.done.length - shown.length;
  return (
    <section className="since-looked" data-testid="since-looked" aria-label="Since you last looked">
      <header className="since-looked-head">
        <Captain size="avatar" />
        <div>
          <h3>Since you last looked</h3>
          <small>Last looked {lookedAt(since)}</small>
        </div>
        <Button size="sm" variant="ghost" data-testid="since-looked-seen" onClick={markSeen}>
          Mark as seen
        </Button>
      </header>
      {shown.length > 0 && (
        <>
          <h4 className="since-looked-group">
            <Check aria-hidden />
            Done <small>{digest.done.length} · from the app</small>
          </h4>
          <ul className="since-looked-done">
            {shown.map(({ agent, finishedAt, summary }) => (
              <li key={agent.sessionId} data-testid="since-looked-done">
                <button type="button" className="since-looked-row" aria-label={`Open ${agent.name}`} onClick={() => onOpenAgent(agent)}>
                  <b title={agent.name}>{agent.name}</b>
                  <time>{clockTime(finishedAt)}</time>
                  <span>{summary ?? 'Finished.'}</span>
                </button>
              </li>
            ))}
          </ul>
          {more > 0 && <p className="since-looked-more">and {more} more</p>}
        </>
      )}
      {digest.upNext !== null && (
        <>
          <h4 className="since-looked-group">
            <ChevronRight aria-hidden />
            Up next <small>from the Captain · {clockTime(digest.upNext.at)}</small>
          </h4>
          <p className="since-looked-next" data-testid="since-looked-next">
            {digest.upNext.text}
          </p>
        </>
      )}
    </section>
  );
}
