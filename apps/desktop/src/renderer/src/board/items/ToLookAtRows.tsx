// The user's queues in the Captain's For you (and beside the Simplified design's Needs-you list): "To look at · 4",
// with Go through ▸ opening the focus view. The queues' own Needs-you rows stay where they are; the count includes them, as
// the queue's card does.
import { Inbox } from 'lucide-react';
import type { Agent, BoardItem } from '@agent-board/daemon/protocol';
import { Button } from '../../ui';
import { needsYouEntries } from '../../../../shared/needs-you';
import { useNeedsYouShows } from '../../needs-you-setting';
import { openFocus } from './queue-board';
import { queueData } from './queue-card';
import { lookCount, needsInScope } from './to-look-at';

/** A row for each of the user's queues with something to look at. */
export function ToLookAtRows({ items, agents }: { items: readonly BoardItem[]; agents: readonly Agent[] }) {
  const entries = needsYouEntries(agents, useNeedsYouShows());
  const rows = items.flatMap((item) => {
    if (item.kind !== 'queue') return [];
    const data = queueData(item.data);
    const count = data.audience === 'user' ? lookCount(data.count, needsInScope(entries, item.zoneId)) : 0;
    return count === 0 ? [] : [{ item, title: data.title, count }];
  });
  if (rows.length === 0) return null;
  return (
    <ul className="to-look-at-rows" aria-label="Your queues">
      {rows.map(({ item, title, count }) => (
        <li key={item.id} className="to-look-at-row" data-testid="to-look-at-row">
          <Inbox aria-hidden className="to-look-at-mark" />
          <b>
            {title} · {count}
          </b>
          <Button size="sm" variant="primary" onClick={() => openFocus(item.id)}>
            Go through ▸
          </Button>
        </li>
      ))}
    </ul>
  );
}
