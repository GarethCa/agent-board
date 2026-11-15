// What a ticket tile shows of its watches (`Agent.watch`): an icon for each watch that is on, grey until it matters, the
// news its chat was not told of as the card's line, and the rows of its Watches menu. Pure, so the rules are unit-tested;
// `TicketTile` and `TicketWatchesMenu` draw them.
import { TICKET_WATCH_KINDS, type TicketWatch, type TicketWatchKind, type TicketWatchNews, type TicketWatchSwitch } from '@agent-board/daemon/protocol';

/** How a watch's icon is drawn: grey while nothing is new, blue for news, green for good, orange for the user's to fix. */
export type WatchTone = 'quiet' | 'new' | 'good' | 'bad';

export interface WatchIcon {
  kind: TicketWatchKind;
  /** A word beside the icon, where the icon alone would leave the user guessing: a reviewer, a count. */
  label: string | undefined;
  tone: WatchTone;
  /** What it says, in words, for its tooltip and its accessible name. */
  title: string;
}

/** Each watch's name and what it watches, as its row in the Watches menu says them. */
export const WATCH_ROWS: Record<TicketWatchKind, { name: string; detail: string }> = {
  reviews: { name: 'Human reviews', detail: 'New reviews and comments from people on the pull request' },
  approvals: { name: 'Approval status', detail: 'Who approved, and what the repo’s rules make of it' },
  merge: { name: 'Merge status', detail: 'Merged, closed, conflicts, behind its base' },
  checks: { name: 'Checks (CI)', detail: 'Failing, or passing again' },
};

const isOn = (watch: TicketWatchSwitch) => watch.tile || watch.chat;

/** The watches that are on, in their order. */
export const watchesOn = (watch: TicketWatch): TicketWatchKind[] => TICKET_WATCH_KINDS.filter((kind) => isOn(watch.settings[kind]));

const REVIEW_WORDS: Record<string, string> = { APPROVED: 'approved', CHANGES_REQUESTED: 'requested changes', COMMENTED: 'reviewed' };

/** More watches on than this, and none has a word: the row keeps room for its helpers and pull request. */
export const LABELLED_WATCHES = 2;

/**
 * The tile's watch icons: one for each watch that is on. While the tile shows its news to read (`fresh`: its line, with
 * Read), a quiet one with news its chat was not told turns blue; orange and green stay, as they say more. With `quiet`
 * off (Simplified), the grey ones are left out. Past two watches shown, or with no `room` for words beside the rest of
 * its row (`midRowFits`), none has a word, and its tooltip says it all.
 */
export function watchIcons(watch: TicketWatch | undefined, fresh: boolean, { room = true, quiet = true }: { room?: boolean; quiet?: boolean } = {}): WatchIcon[] {
  if (watch === undefined) return [];
  const unread = new Set(fresh ? untoldNews(watch).map((each) => each.kind) : []);
  const icons = watchesOn(watch).map((kind): WatchIcon => {
    const icon = iconOf(kind, watch);
    if (!unread.has(kind)) return icon;
    return { ...icon, tone: icon.tone === 'quiet' ? 'new' : icon.tone, title: `${icon.title} · news to read` };
  });
  const shown = quiet ? icons : icons.filter((icon) => icon.tone !== 'quiet');
  const crowded = !room || shown.length > LABELLED_WATCHES;
  return crowded ? shown.map((icon) => ({ ...icon, label: undefined })) : shown;
}

function iconOf(kind: TicketWatchKind, { seen }: TicketWatch): WatchIcon {
  const name = WATCH_ROWS[kind].name;
  if (seen === null) return { kind, label: undefined, tone: 'quiet', title: `${name}: not read yet` };
  if (kind === 'reviews') {
    const last = seen.lastReview;
    if (last === null) return { kind, label: undefined, tone: 'quiet', title: `${name}: no review yet` };
    // Someone outside the repo is named, never said how they reviewed.
    const how = REVIEW_WORDS[last.state];
    return { kind, label: last.by, tone: 'quiet', title: how === undefined ? `${name}: last from @${last.by}` : `${name}: ${last.by} ${how}` };
  }
  if (kind === 'approvals') {
    const { by, decision } = seen.approvals;
    const label = by.length > 0 ? String(by.length) : undefined;
    // A bot's or the user's own approval can move the repo's decision too: it says the rules approve, not who.
    if (decision === 'APPROVED') return { kind, label, tone: 'good', title: by.length > 0 ? `${name}: approved by ${by.join(', ')}` : `${name}: approved under the repo’s rules` };
    if (decision === 'CHANGES_REQUESTED') return { kind, label, tone: 'quiet', title: `${name}: changes requested` };
    return { kind, label, tone: 'quiet', title: by.length > 0 ? `${name}: approved by ${by.join(', ')}; needs more under the repo’s rules` : `${name}: no approval yet` };
  }
  if (kind === 'merge') {
    const { state, mergeable, mergeStateStatus } = seen.merge;
    if (state === 'merged') return { kind, label: undefined, tone: 'good', title: `${name}: merged` };
    if (state === 'closed') return { kind, label: undefined, tone: 'quiet', title: `${name}: closed without merging` };
    if (mergeable === 'CONFLICTING') return { kind, label: undefined, tone: 'bad', title: `${name}: conflicts with its base branch` };
    if (mergeStateStatus === 'BEHIND') return { kind, label: undefined, tone: 'bad', title: `${name}: behind its base branch` };
    return { kind, label: undefined, tone: 'quiet', title: `${name}: open` };
  }
  const { state, passing, total } = seen.checks;
  const label = total > 0 ? `${passing}/${total}` : undefined;
  if (state === 'failing') return { kind, label, tone: 'bad', title: `${name}: failing, ${passing} of ${total} passing` };
  if (state === 'passing') return { kind, label, tone: 'good', title: `${name}: passing` };
  if (state === 'pending') return { kind, label, tone: 'quiet', title: `${name}: running` };
  return { kind, label, tone: 'quiet', title: `${name}: none` };
}

/** The news its chat was not told of (Tell chat off for its kind), which is the user's to read, oldest first. */
export const untoldNews = (watch: TicketWatch): TicketWatchNews[] => watch.news.filter((each) => !watch.settings[each.kind].chat);

/** What the card's line says of its watches: the newest review it asks the user to read, or its newest quiet news. */
export interface WatchLine {
  text: string;
  /** A review or approval: the ticket's New review ask. Else merge or check news, a quiet line. */
  review: boolean;
}

/**
 * The card's line from its watches, if its news is the user's to read: while it asks New review, the newest review or
 * approval on its pull request; else its newest merge or check news. Undefined when its chat was told it all.
 */
export function watchLine(watch: TicketWatch | undefined): WatchLine | undefined {
  if (watch === undefined) return undefined;
  const untold = untoldNews(watch);
  const on = watch.pullRequest === null ? '' : ` on #${watch.pullRequest.number}`;
  if (watch.ask === 'new-review') {
    const review = untold.findLast((each) => each.kind === 'reviews' || each.kind === 'approvals');
    if (review !== undefined) return { text: `${review.text}${on}.`, review: true };
  }
  const quiet = untold.findLast((each) => each.kind === 'merge' || each.kind === 'checks');
  return quiet === undefined ? undefined : { text: `${quiet.text}.`, review: false };
}

