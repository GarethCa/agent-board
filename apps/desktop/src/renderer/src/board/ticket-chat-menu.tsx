import { DEFAULT_TICKET_CHAT_KIND, type Agent, type PullRequest, type TicketChatKind, type TicketWatch } from '@agent-board/daemon/protocol';
import { CircleX, Eye, GitPullRequest, LayoutDashboard, Users } from 'lucide-react';
import { withoutRows, type ModelEntry } from './menu-model';
import { ticketPr } from './ticket-tile';

const KINDS: readonly { kind: TicketChatKind; label: string }[] = [
  { kind: 'lead', label: 'Its own lead' },
  { kind: 'implementer', label: 'The implementer' },
];

/** What a switch to `kind` waits for: the builder's hand-off to become the implementer, the chat's own to become its lead. */
const WAITS_FOR: Record<TicketChatKind, string> = { implementer: 'after the builder hands off', lead: 'after the chat hands off' };

/** What a ticket's chat ⋯ menu does that an agent's own menu doesn't. */
export interface TicketChatMenuActions {
  /** Zooms into the ticket's own board: its helpers as tiles, beside its notes and docs. */
  openBoard(): void;
  /** Opens its Watches sheet; absent where the tile has nowhere to show it. */
  openWatches?(): void;
  openPullRequest(owner: Agent, pr: PullRequest): void;
  setChatKind(kind: TicketChatKind): void;
  /** Asks first, then ends the chat and its helpers; their branches stay. */
  closeTicket(): void;
}

export interface TicketChatMenuInput {
  chat: Agent;
  /** Its helpers; undefined for an agent that is no ticket's chat. */
  helpers: readonly Agent[] | undefined;
  /** The rows that switch how its tile shows (Card, Terminal). */
  views: readonly ModelEntry[];
  /** The agent's own menu, as any agent's tile has it. */
  own: ModelEntry[];
  actions: TicketChatMenuActions;
}

/** An agent tile's ⋯ menu: a ticket's chat's (`ticketChatMenu`), or for a plain agent its own menu as it is. */
export function tileMenuEntries(input: TicketChatMenuInput): ModelEntry[] {
  return input.helpers === undefined ? input.own : ticketChatMenu({ ...input, helpers: input.helpers });
}

/**
 * A ticket's chat ⋯ menu, in order: the ticket's own items (its board, Watches…, its pull request and its checks, what
 * kind of chat it is), then the rows that switch its view, then every agent's rows, and last Close ticket…, which is the
 * only place a ticket closes.
 */
export function ticketChatMenu({ chat, helpers = [], views, own, actions }: TicketChatMenuInput): ModelEntry[] {
  const kind = ticketChatRow(chat, actions.setChatKind);
  const ticket: ModelEntry[] = [
    { id: 'ticket-board', label: "Open the ticket's board", icon: <LayoutDashboard />, onSelect: actions.openBoard },
    ...(chat.watch === undefined || actions.openWatches === undefined ? [] : [{ id: 'ticket-watches', label: 'Watches…', icon: <Eye />, onSelect: actions.openWatches }]),
    ...prRow([chat, ...helpers], chat.watch, actions.openPullRequest),
    ...(kind === undefined ? [] : [kind]),
  ];
  // Its own rows have no Stop session, and no Delete agent while any of the ticket is live or paused: either would end
  // the chat alone and leave its helpers running. Once Close ticket… has ended them all, Delete removes its tile.
  const open = [chat, ...helpers].some(closable);
  const mine = withoutRows(own, open ? ['stop', 'delete'] : ['stop']);
  return [...ticket, 'separator', ...(views.length === 0 ? [] : [...views, 'separator' as const]), ...mine, 'separator', closeRow(chat, helpers, actions.closeTicket)];
}

/** Whether an agent still has a session to end: live, or paused. */
const closable = (agent: Agent): boolean => agent.endedAt === null || agent.state === 'hibernated';

function closeRow(chat: Agent, helpers: readonly Agent[], close: () => void): ModelEntry {
  const open = [chat, ...helpers].some(closable);
  return { id: 'close-ticket', label: 'Close ticket…', icon: <CircleX />, disabled: !open, hint: open ? undefined : 'Its chat and helpers have ended', onSelect: close };
}

/** Close ticket?'s words: who ends, and what stays. */
export function closeTicketLines(chat: Agent, helpers: readonly Agent[]): string[] {
  const live = helpers.filter(closable).length;
  const keeps = 'Their worktrees, branches and conversations stay, and Restart carries each on.';
  if (!closable(chat)) return [`Its ${live} helper${live === 1 ? ' ends' : 's end'}. ${live === 1 ? 'Its worktree, branch and conversation stay, and Restart carries it on.' : keeps}`];
  if (live === 0) return [`${chat.name} ends. Its worktree, branch and conversation stay, and Restart carries it on.`];
  return [`${chat.name} and its ${live} helper${live === 1 ? '' : 's'} end. ${keeps}`];
}

/**
 * Who Close ticket… ends, as the board is now: its helpers that are live or paused, then its chat if it is, so none is
 * left working for a chat that has gone. Read at the confirm, not at the click, as one may end or start meanwhile.
 */
export function closeTicketTeam(agents: readonly Agent[], chatSessionId: string): Agent[] {
  const chat = agents.find((agent) => agent.sessionId === chatSessionId);
  if (chat === undefined) return [];
  const helpers = agents.filter((agent) => agent.ticket === chatSessionId && closable(agent));
  return closable(chat) ? [...helpers, chat] : helpers;
}

/**
 * Stops each of the team in turn, going on past one that fails (it may have ended since), so that one never leaves the
 * rest running. Resolves with those that failed, and why.
 */
export async function stopTeam(team: readonly Agent[], stop: (sessionId: string) => Promise<unknown>): Promise<{ agent: Agent; error: unknown }[]> {
  const failed: { agent: Agent; error: unknown }[] = [];
  for (const agent of team) {
    try {
      await stop(agent.sessionId);
    } catch (error) {
      failed.push({ agent, error });
    }
  }
  return failed;
}

/** The ticket's pull request, as the tile shows it, with its checks: the one row that opens it. */
function prRow(team: readonly Agent[], watch: TicketWatch | undefined, open: (owner: Agent, pr: PullRequest) => void): ModelEntry[] {
  const pr = ticketPr(team);
  const owner = pr === undefined ? undefined : team.find((agent) => agent.pullRequests.includes(pr));
  if (pr === undefined || owner === undefined) return [];
  return [{ id: 'ticket-pr', label: prLabel(pr, watch), icon: <GitPullRequest />, hint: pr.title, onSelect: () => open(owner, pr) }];
}

/** "PR #725 · checks 3 of 7": its checks counted from what its watches last read of it, else in a word. */
export function prLabel(pr: PullRequest, watch: TicketWatch | undefined): string {
  const head = `PR #${pr.number}`;
  if (pr.state === 'merged' || pr.state === 'closed') return `${head} · ${pr.state}`;
  const counted = watch?.pullRequest?.number === pr.number ? watch.seen?.checks : undefined;
  if (counted !== undefined && counted.total > 0 && pr.checks !== 'failing') return `${head} · checks ${counted.passing} of ${counted.total}`;
  return pr.checks === 'none' ? head : `${head} · checks ${pr.checks}`;
}

/**
 * Chat kind ▸: who builds the ticket, its chat as the implementer or its own lead with a builder helper. A pick switches
 * at a hand-off, never mid-edit; while one waits, its row says what for. None for an agent that is no ticket's chat,
 * works outside git (no branch to hand over) or has ended.
 */
export function ticketChatRow(chat: Agent, set: (kind: TicketChatKind) => void): ModelEntry | undefined {
  if (!chat.ticketChat || chat.plainFolder || chat.endedAt !== null) return undefined;
  const now = chat.chatKind ?? DEFAULT_TICKET_CHAT_KIND;
  const label = KINDS.find((each) => each.kind === now)!.label;
  return {
    id: 'ticket-chat',
    label: `Chat kind: ${label.charAt(0).toLowerCase()}${label.slice(1)}`,
    icon: <Users />,
    entries: KINDS.map(({ kind, label }) => ({
      id: `ticket-chat-${kind}`,
      label,
      checked: kind === now,
      hint: chat.chatSwitch === kind ? WAITS_FOR[kind] : undefined,
      onSelect: () => set(kind),
    })),
  };
}
