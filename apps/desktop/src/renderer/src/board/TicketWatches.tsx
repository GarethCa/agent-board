import { useContext, useState, type ReactNode } from 'react';
import { Check, Eye, GitMerge, Play, UserRound } from 'lucide-react';
import { TICKET_WATCH_EVERY_MINUTES, TICKET_WATCH_KINDS, type Agent, type TicketWatch, type TicketWatchChange, type TicketWatchEvery, type TicketWatchKind } from '@agent-board/daemon/protocol';
import { Button, Popover, Segmented, Switch } from '../ui';
import { TileActionsContext } from './tile';
import { TileButton } from './tile-parts';
import { LABELLED_WATCHES, WATCH_ROWS, type WatchIcon } from './ticket-watch-view';

const WATCH_KIND_ICONS: Record<TicketWatchKind, ReactNode> = {
  reviews: <UserRound aria-hidden />,
  approvals: <Check aria-hidden />,
  merge: <GitMerge aria-hidden />,
  checks: <Play aria-hidden />,
};

const EVERY_OPTIONS = TICKET_WATCH_EVERY_MINUTES.map((minutes) => ({ id: String(minutes) as `${TicketWatchEvery}`, label: `${minutes} min` }));

/**
 * The ticket's watches that are on, as icons at the right of its middle row: grey, blue with news, green or orange. Its
 * tooltip says it all; past two watches none has a word (`watchIcons`), and the row draws them tighter.
 */
export function WatchIcons({ icons }: { icons: readonly WatchIcon[] }) {
  if (icons.length === 0) return null;
  return (
    <span className="ticket-tile-watches" data-testid="ticket-watches" data-crowded={icons.length > LABELLED_WATCHES || undefined}>
      {icons.map((icon) => (
        <span key={icon.kind} className="ticket-tile-watch-icon" data-testid="ticket-watch-icon" data-kind={icon.kind} data-tone={icon.tone} role="img" title={icon.title} aria-label={icon.title}>
          {WATCH_KIND_ICONS[icon.kind]}
          {icon.label !== undefined && <span className="ticket-tile-watch-label">{icon.label}</span>}
        </span>
      ))}
    </span>
  );
}

interface WatchesMenuProps {
  /** What it calls the ticket: its short id, else its title. */
  name: string;
  watch: TicketWatch;
  onChange(change: TicketWatchChange): void;
  onRead(): void;
}

const anyOn = (watch: TicketWatch) => TICKET_WATCH_KINDS.some((kind) => watch.settings[kind].tile || watch.settings[kind].chat);

/** The eye on a ticket's tile, at rest or opened: its chat's Watches menu, changed and read through the tile's actions. */
export function TicketWatchesMenu({ chat, name }: { chat: Agent; name: string }) {
  const { setWatches, readWatches } = useContext(TileActionsContext);
  if (chat.watch === undefined) return null;
  return <WatchesMenu name={name} watch={chat.watch} onChange={(change) => setWatches(chat.sessionId, change)} onRead={() => readWatches(chat.sessionId)} />;
}

/** The ticket's Watches menu, from the eye in its header: `WatchesSheet` in a popover. */
function WatchesMenu(props: WatchesMenuProps) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen} content={<WatchesSheet {...props} />} aria-label={`What ${props.name} watches`} side="bottom" align="end" className="ticket-watches-popover">
      <TileButton icon={<Eye />} aria-label="Watches" title="What it watches on its pull request" />
    </Popover>
  );
}

/**
 * What the Watches menu shows: each watch with On tile and Tell chat, how often they read, the news not yet read with
 * Read, and what the watches may do. Nothing is on until the user turns it on.
 */
export function WatchesSheet({ name, watch, onChange, onRead }: WatchesMenuProps) {
  // All its unread news, told to its chat or not: Read here clears it all.
  const unread = watch.news;
  const on = anyOn(watch);
  return (
    <div className="ticket-watches" data-testid="ticket-watches-menu">
      <p className="ticket-watches-title">What {name} watches</p>
      <div className="ticket-watches-rows" role="group" aria-label="Watches">
        <span className="ticket-watches-heads" aria-hidden>
          <span>On tile</span>
          <span>Tell chat</span>
        </span>
        {TICKET_WATCH_KINDS.map((kind) => {
          const row = WATCH_ROWS[kind];
          const now = watch.settings[kind];
          return (
            <div key={kind} className="ticket-watches-row" data-kind={kind} data-testid="ticket-watch-row">
              <span className="ticket-watches-icon">{WATCH_KIND_ICONS[kind]}</span>
              <span className="ticket-watches-name">
                {row.name}
                <span className="ticket-watches-detail">{row.detail}</span>
              </span>
              <Switch aria-label={`${row.name}: on tile`} checked={now.tile} onChange={(event) => onChange({ watches: { [kind]: { ...now, tile: event.currentTarget.checked } } })} />
              <Switch aria-label={`${row.name}: tell chat`} checked={now.chat} onChange={(event) => onChange({ watches: { [kind]: { ...now, chat: event.currentTarget.checked } } })} />
            </div>
          );
        })}
      </div>
      <div className="ticket-watches-every">
        <span>Check every · and after a push</span>
        <Segmented
          aria-label="Check every"
          options={EVERY_OPTIONS}
          value={String(watch.settings.everyMinutes) as `${TicketWatchEvery}`}
          onChange={(minutes) => onChange({ everyMinutes: Number(minutes) as TicketWatchEvery })}
        />
      </div>
      {watch.problem !== null && (
        <p className="ticket-watches-problem" role="status">
          {watch.problem}
        </p>
      )}
      {on && watch.pullRequest === null && watch.problem === null && <p className="ticket-watches-note">No pull request yet: they start once it has one.</p>}
      {unread.length > 0 && (
        <div className="ticket-watches-news" data-testid="ticket-watches-news">
          <ul>
            {unread.toReversed().map((news) => (
              <li key={`${news.kind}-${news.at}-${news.text}`}>{news.text}</li>
            ))}
          </ul>
          <Button size="xs" variant="secondary" onClick={onRead}>
            Read
          </Button>
        </div>
      )}
      <p className="ticket-watches-fine">
        It reads GitHub with your own gh sign-in. It never approves or merges. Tell chat gives the news to the ticket chat on its next turn, as one of its clocks would.
      </p>
    </div>
  );
}
