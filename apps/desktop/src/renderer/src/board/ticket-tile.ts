// What a ticket says, from one ticket chat and the helpers it holds (`Agent.ticketChat`, `Agent.ticket`): the ticket and its
// title, one line of what is true now, its helpers as icons, what it watches, and a state word with at most one button,
// which its opened tile and its board draw; and a helper's ask, which its chat's agent tile shows at rest. Pure, so the
// rules are unit-tested.
import { chatBuilds } from '@agent-board/daemon/ticket-tiles';
import { needsYouKind, needsYouNow, shortIssueId, statusLine, type Agent, type NeedsYouShows, type PullRequest } from '@agent-board/daemon/protocol';
import { agentPill, TILE_STATE_LABELS } from '../states';
import { FLAT_STATES, TILE_STATE_WORDS, tileAbout, tileButton, tileNow, tileState, type TileButton, type TileState } from './tile-headline';
import { watchIcons, watchLine, type WatchIcon } from './ticket-watch-view';

/** The one thing a ticket tile asks for, most urgent first: the first that holds is the one it shows. */
export const TICKET_ASKS = ['needs-you', 'ready-to-merge', 'new-review', 'working'] as const;
export type TicketAsk = (typeof TICKET_ASKS)[number];

/** What decides a ticket tile's ask. */
export interface TicketAskFacts {
  /** Its chat, or one of its helpers, needs the user. */
  needsYou: boolean;
  /** Its pull request is open with its checks passing, and its chat says the work is ready. */
  readyToMerge: boolean;
  /** A review it watches has landed and not been read. */
  newReview: boolean;
}

/** Its one ask: Needs you, then Ready to merge, then New review, else Working. */
export function ticketAsk({ needsYou, readyToMerge, newReview }: TicketAskFacts): TicketAsk {
  if (needsYou) return 'needs-you';
  if (readyToMerge) return 'ready-to-merge';
  if (newReview) return 'new-review';
  return 'working';
}

/** A helper's icon: a pen for design, a hammer for building, a lens for review. */
export type HelperKind = 'design' | 'build' | 'review';

/** How a helper's icon is drawn: asking the user, ringed while it works, ticked once done, failed, or asleep. */
export type HelperState = 'you' | 'working' | 'done' | 'failed' | 'sleep';

export interface HelperIcon {
  sessionId: string;
  kind: HelperKind;
  state: HelperState;
  /** Its name and its state in words, for its tooltip and its label. */
  title: string;
  /** Its name, for its card in the terminal view's strip or the opened card's column. */
  name: string;
  /** Its state in a word, for its card. */
  word: string;
  /** The line under its name on its card: its status line, else its state. */
  line: string;
}

const HELPER_WORDS: Record<HelperState, string> = { you: 'needs you', working: 'working', done: 'done', failed: 'failed', sleep: 'idle' };
const capitalised = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** Its state on a tile, read through the pill its own tile would draw. */
const stateOf = (agent: Agent, shows: NeedsYouShows): TileState => tileState(agent, shows, agentPill(agent, shows, TILE_STATE_LABELS).state);

function helperKind(agent: Pick<Agent, 'role' | 'roleName' | 'reviewOf'>): HelperKind {
  if (agent.reviewOf !== null || agent.role === 'reviewer' || agent.role === 'follow-up-reviewer') return 'review';
  if (agent.roleName !== null && /design/i.test(agent.roleName)) return 'design';
  return 'build';
}

const HELPER_STATES: Record<TileState, HelperState> = { 'needs-you': 'you', thinking: 'working', done: 'done', failed: 'failed', waiting: 'sleep', idle: 'sleep', paused: 'sleep' };

/** A helper as its ticket tile draws it. */
export function helperIcon(agent: Agent, shows: NeedsYouShows): HelperIcon {
  const state = HELPER_STATES[stateOf(agent, shows)];
  const word = capitalised(HELPER_WORDS[state]);
  return {
    sessionId: agent.sessionId,
    kind: helperKind(agent),
    state,
    title: `${agent.name}: ${HELPER_WORDS[state]}`,
    name: agent.name,
    word,
    line: agent.status === null ? word : statusLine(agent.status),
  };
}

/**
 * The ticket tile's one button: Answer or Open what needs the user, Merge (which opens the pull request), Wake, or Read,
 * which marks its watches' news read.
 */
export interface TicketButton {
  kind: 'open' | 'merge' | 'wake' | 'read';
  label: string;
  prominent: boolean;
}

/** How its state word is drawn: by its dot's colour. */
export type TicketWordKind = 'you' | 'merge' | 'new' | 'run' | 'failed' | 'rest';

export interface TicketFace {
  /** Its ticket's short id, when its chat has an issue. */
  ticketId: string | undefined;
  /** Its ticket's title, else its chat's name. */
  title: string;
  /** Whether a rename shows: only with no issue, as the title is the ticket's otherwise. */
  renames: boolean;
  /** What is true now, in one line; undefined when there is nothing to say. */
  line: string | undefined;
  /** Its line is its watches' news, which its chat was not told: Read marks it read. */
  news: boolean;
  ask: TicketAsk;
  word: string;
  wordKind: TicketWordKind;
  /** It lies flat, with no shadow: merged, or nothing works and nothing asks. */
  flat: boolean;
  button: TicketButton | undefined;
  /** Who needs the user: the chat first, else the first helper that does; the chat when none does. */
  asker: Agent;
  /** Its chat or a helper needs the user and has not been seen: the tile's usual needs-you look. */
  needsYouNow: boolean;
  helpers: HelperIcon[];
  /** Its watches that are on, as icons: none until the user turns one on. Beside the chat that builds, none has a word. */
  watches: WatchIcon[];
  /** Whether its builds mark (its chat builds) says "builds": only while no watch shares its row, else its hammer alone. */
  buildsWord: boolean;
  /** Its pull request: the first open one of its chat's, then its helpers'; else the one that merged. */
  pr: PullRequest | undefined;
  merged: boolean;
}

const WORD_KINDS: Record<TicketAsk, TicketWordKind> = { 'needs-you': 'you', 'ready-to-merge': 'merge', 'new-review': 'new', working: 'run' };
const ASK_WORDS: Record<Exclude<TicketAsk, 'working'>, string> = { 'needs-you': 'Needs you', 'ready-to-merge': 'Ready to merge', 'new-review': 'New review' };

/** Its chat's pull requests first, then its helpers', in order. */
export function ticketPr(team: readonly Pick<Agent, 'pullRequests'>[]): PullRequest | undefined {
  const all = team.flatMap((agent) => agent.pullRequests);
  return all.find((pr) => pr.state === 'open' || pr.state === 'draft') ?? all.find((pr) => pr.state === 'merged');
}

/** Whether its chat says the work is ready: it set Ready for review, or said it finished. */
const chatSaysReady = (chat: Pick<Agent, 'workCategory' | 'workFinishedAt'>): boolean => chat.workCategory?.category === 'ready-for-review' || chat.workFinishedAt !== null;

/**
 * The ticket tile's face, from its chat and its helpers (in the order their icons go). A helper's question rolls up into
 * the ticket, as its permission prompts do; a helper's finished turn is its chat's to handle, as `needsYouKind` says.
 */
export function ticketFace(chat: Agent, helpers: readonly Agent[], shows: NeedsYouShows, { simplified = false }: { simplified?: boolean } = {}): TicketFace {
  const chatState = stateOf(chat, shows);
  const helperStates = helpers.map((helper) => stateOf(helper, shows));
  const icons = helpers.map((helper) => helperIcon(helper, shows));
  const asking = chatState === 'needs-you' ? chat : helpers.find((_, index) => helperStates[index] === 'needs-you');
  const working = [chatState, ...helperStates].includes('thinking');
  const pr = ticketPr([chat, ...helpers]);
  const merged = pr?.state === 'merged';
  const readyToMerge = !working && !merged && pr?.state === 'open' && (pr.checks === 'passing' || pr.checks === 'none') && chatSaysReady(chat);
  const watched = watchLine(chat.watch);
  const ask = ticketAsk({ needsYou: asking !== undefined, readyToMerge, newReview: watched?.review === true });
  const asker = asking ?? chat;
  // A new review is the ask itself; quieter news (merge, checks) is the line only while the ticket asks for nothing else.
  const news = watched !== undefined && (ask === 'new-review' || (ask === 'working' && !merged));
  const flat = ask === 'working' && (merged || (!working && FLAT_STATES.has(chatState)));
  const button = ticketButton(ask, asker, chatState, merged, shows);
  // Blue only while the tile offers Read: once merged, or while something else asks, its watches keep their own colour.
  // Its middle row is one line: the watches' words show only where the row has room for them beside its helpers, who
  // builds and its pull request; the builds mark keeps its word only with no watches on.
  // Simplified hides its grey watches, so only what has something to say shows.
  const labelled = watchIcons(chat.watch, news, { quiet: !simplified });
  const watches = midRowFits(labelled, icons.length, chatBuilds(chat), pr !== undefined) ? labelled : watchIcons(chat.watch, news, { room: false, quiet: !simplified });
  return {
    ticketId: chat.issue === null ? undefined : shortIssueId(chat.issue),
    title: chat.issue?.title ?? chat.name,
    renames: chat.issue === null,
    line: news ? watched.text : ticketLine(chat, helpers, ask, chatState, helperStates, asker, merged ? pr : undefined, shows),
    news,
    ask,
    word: ask !== 'working' ? ASK_WORDS[ask] : merged ? 'Done' : working ? 'Working' : TILE_STATE_WORDS[chatState],
    wordKind: ask !== 'working' ? WORD_KINDS[ask] : working ? 'run' : chatState === 'failed' ? 'failed' : 'rest',
    flat,
    button: ask === 'new-review' ? { kind: 'read', label: 'Read', prominent: true } : (button ?? (news ? { kind: 'read', label: 'Read', prominent: false } : undefined)),
    asker,
    needsYouNow: [chat, ...helpers].some((agent) => needsYouNow(agent, shows)),
    helpers: icons,
    watches,
    buildsWord: watches.length === 0,
    pr,
    merged,
  };
}

/**
 * Widths in its middle row, in px, from the tokens (`--size-tag`, the gaps, the pill paddings) and the card at rest's
 * width less its padding: an estimate, on the safe side, of whether the watches' words fit beside the rest.
 */
const MID_ROW = { width: 220, group: 8, helper: 22, helperGap: 4, builds: 22, pr: 60, watchGap: 4, watch: 22, labelGap: 2, labelChar: 6.5, label: 72 } as const;

/** Whether its middle row holds its watches with their words, its helpers, who builds and its pull request on one line. */
export function midRowFits(watches: readonly WatchIcon[], helpers: number, builds: boolean, pr: boolean): boolean {
  if (watches.every((icon) => icon.label === undefined)) return true;
  const left = (builds ? 1 : 0) + helpers;
  const groups = [left > 0, watches.length > 0, pr].filter(Boolean).length;
  const width =
    (builds ? MID_ROW.builds : 0) +
    helpers * MID_ROW.helper +
    Math.max(0, left - 1) * MID_ROW.helperGap +
    watches.reduce((sum, icon) => sum + MID_ROW.watch + (icon.label === undefined ? 0 : MID_ROW.labelGap + Math.min(MID_ROW.label, icon.label.length * MID_ROW.labelChar)), 0) +
    Math.max(0, watches.length - 1) * MID_ROW.watchGap +
    (pr ? MID_ROW.pr : 0) +
    Math.max(0, groups - 1) * MID_ROW.group;
  return width <= MID_ROW.width;
}

/** Its one line: who asks and what; that it merged; else what its chat says is true now, else what a working helper is on. */
function ticketLine(chat: Agent, helpers: readonly Agent[], ask: TicketAsk, chatState: TileState, helperStates: readonly TileState[], asker: Agent, merged: PullRequest | undefined, shows: NeedsYouShows): string | undefined {
  if (ask === 'needs-you') {
    const words = tileNow(asker, 'needs-you');
    if (asker === chat || words === undefined) return words;
    return asks(asker, shows) ? `Its ${HELPER_ROLES[helperKind(asker)]} asks: ${words}` : `Its ${HELPER_ROLES[helperKind(asker)]}: ${words}`;
  }
  if (merged !== undefined) return `Merged as #${merged.number}.`;
  const own = tileNow(chat, chatState);
  if (own !== undefined) return own;
  const index = helperStates.indexOf('thinking');
  const helper = helpers[index];
  return helper?.status == null ? undefined : `${helper.name}: ${statusLine(helper.status)}`;
}

/** A helper by its role on its ticket, in a word, as its ticket's tile names it. */
const HELPER_ROLES: Record<HelperKind, string> = { design: 'designer', build: 'builder', review: 'reviewer' };

export interface TicketTileAsk {
  /** Who asks: a helper the chat holds, or the chat itself for its watches' news and its merge. */
  asker: Agent;
  /** Its state in a word: Needs you, Ready to merge, New review, or the chat's own while it only has news. */
  word: string;
  /** How its word is drawn: Ready to merge and New review take their own colours. */
  wordKind: TicketWordKind;
  /** A helper asks: the word has a dot before it. */
  dot: boolean;
  /** It lies flat, with no shadow: only while it asks for nothing (its news alone, once merged). */
  flat: boolean;
  /** Who asks, by its role, and what ("Its reviewer asks: keep the old order after a reload?"), or the news. */
  line: string | undefined;
  button: TicketButton | undefined;
  /** Its pull request and the agent whose branch it is, which Merge opens. */
  pullRequest: { owner: Agent; pr: PullRequest } | undefined;
  /** A helper asks and has not been seen: the tile's needs-you look. */
  needsYouNow: boolean;
}

/**
 * What a ticket's chat's tile asks beyond the chat's own state, as its helpers have no tiles: the first helper that
 * needs the user, else its merge, a new review, its watches' news or that it merged. Undefined while the chat itself needs the user (its
 * tile shows its own ask then), or there is nothing more to say.
 */
export function ticketTileAsk(chat: Agent, helpers: readonly Agent[], shows: NeedsYouShows): TicketTileAsk | undefined {
  if (stateOf(chat, shows) === 'needs-you') return undefined;
  const face = ticketFace(chat, helpers, shows);
  const owner = face.pr === undefined ? undefined : [chat, ...helpers].find((each) => each.pullRequests.includes(face.pr!));
  const pullRequest = owner === undefined ? undefined : { owner, pr: face.pr! };
  const said = { word: face.word, wordKind: face.wordKind, flat: face.flat, line: face.line, button: face.button, pullRequest };
  if (face.ask === 'needs-you' && face.asker !== chat) return { ...said, asker: face.asker, dot: true, needsYouNow: needsYouNow(face.asker, shows) };
  if (face.ask === 'working' && !face.news && !face.merged) return undefined;
  return { ...said, asker: chat, dot: false, needsYouNow: false };
}

/**
 * A ticket's chat's name and about line on its tile. Its ticket's id leads the about line; a chat named after its ticket
 * alone shows the ticket's title as its name instead, so neither says the same thing twice.
 */
export function ticketHead(chat: Pick<Agent, 'name' | 'issue' | 'purpose' | 'description'>): { name: string; id: string | undefined; about: string | undefined } {
  if (chat.issue === null) return { name: chat.name, id: undefined, about: tileAbout(chat) };
  const id = shortIssueId(chat.issue);
  const bare = chat.name === chat.issue.id || chat.name === id;
  return { name: bare ? chat.issue.title : chat.name, id, about: tileAbout(bare ? { ...chat, issue: null } : chat) };
}

/** Whether it puts a question or a permission prompt to the user, which its one button answers. */
function asks(agent: Agent, shows: NeedsYouShows): boolean {
  const kind = needsYouKind(agent, shows);
  return kind === 'asks' || kind === 'permission';
}

function ticketButton(ask: TicketAsk, asker: Agent, chatState: TileState, merged: boolean, shows: NeedsYouShows): TicketButton | undefined {
  if (ask === 'ready-to-merge') return { kind: 'merge', label: 'Merge', prominent: true };
  if (ask === 'needs-you') {
    if (asker.state === 'hibernated') return { kind: 'wake', label: 'Wake', prominent: true };
    // Resume carries on its conversation, as the usual tile's Resume does.
    if (asker.state === 'stopped-by-restart') return { kind: 'wake', label: 'Resume', prominent: true };
    return { kind: 'open', label: asks(asker, shows) ? 'Answer' : 'Open', prominent: true };
  }
  if (merged) return undefined;
  const own = tileButton(asker, chatState);
  // A done chat's Review is the Classic tile's; the ticket's pull request is on its watch row.
  return own !== undefined && notReview(own) ? own : undefined;
}

const notReview = (button: TileButton): button is TileButton & { kind: TicketButton['kind'] } => button.kind !== 'review';
