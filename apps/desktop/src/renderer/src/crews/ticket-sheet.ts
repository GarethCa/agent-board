// The New ticket sheet's helper presets: the library's prefabs that start inside a ticket tile, each as the row it is
// drawn as. Pure, so the sheet and its tests share it.
import { withTicketChat } from '@agent-board/daemon/ticket-tiles';
import { DEFAULT_TICKET_CHAT_KIND, isOrchestratorRole, REVIEWER_ROLES, type CrewPrefab, type LibraryPrefab, type PrefabMember, type TicketChatKind } from '@agent-board/daemon/protocol';
import type { HelperKind } from '../board/ticket-tile';

export interface TicketPreset {
  /** The prefab it starts. */
  name: string;
  /** Its helpers in the order they work: `Design → Build → Review`, or `Just the chat`. */
  label: string;
  /** Their models and reasoning, `Opus high, Opus medium`, or what a chat alone does. */
  detail: string;
  kinds: HelperKind[];
  /** The kind of chat the prefab itself starts. */
  ticketChat: TicketChatKind;
  /** Whether the chat builds, so no builder is among its helpers. */
  chatBuilds: boolean;
}

const WORDS: Record<HelperKind, string> = { design: 'Design', build: 'Build', review: 'Review' };

function helperKind(member: PrefabMember): HelperKind {
  if (member.role === 'designer') return 'design';
  if (member.role !== null && (REVIEWER_ROLES as readonly string[]).includes(member.role)) return 'review';
  return 'build';
}

const capital = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

/** A helper's model and reasoning, as the sheet words it: `Opus high`; empty for its defaults. */
const modelWords = (member: PrefabMember) => [member.model === null ? null : capital(member.model), member.effort].filter((part) => part !== null).join(' ');

/**
 * The ticket prefabs, the ones with the most helpers first, each with the chat `kind(prefab)` says: its helpers are the
 * prefab's members but the chat, as that kind of chat would start them (`withTicketChat`).
 */
export function ticketPresets(prefabs: readonly LibraryPrefab[], kind: (prefab: CrewPrefab) => TicketChatKind): TicketPreset[] {
  return prefabs
    .filter((prefab) => prefab.onBoard === 'ticket')
    .map((prefab, at) => ({ prefab, at }))
    .sort((a, b) => b.prefab.members.length - a.prefab.members.length || a.at - b.at)
    .map(({ prefab }) => {
      const chat = kind(prefab);
      const shaped = withTicketChat(prefab, chat);
      const helpers = shaped.members.filter((member) => member.starts !== 'prompt' && !isOrchestratorRole(member.role));
      const kinds = helpers.map(helperKind);
      const models = helpers.map(modelWords);
      const own = prefab.ticketChat ?? DEFAULT_TICKET_CHAT_KIND;
      // Its purpose speaks of its own kind of chat: picked as the other, the row says what that kind does instead.
      const purpose = chat === own ? prefab.purpose : chat === 'lead' ? 'The chat leads; a builder writes the code' : 'The chat builds; its helpers design and review';
      return {
        name: prefab.name,
        label: kinds.length === 0 ? 'Just the chat' : kinds.map((each) => WORDS[each]).join(' → '),
        detail: kinds.length === 0 ? 'It starts helpers when it needs them' : models.every((each) => each !== '') ? models.join(', ') : purpose,
        kinds,
        ticketChat: own,
        chatBuilds: chat === 'implementer',
      };
    });
}

/**
 * The preset and the kind of chat the sheet opens on: the prefab asked for, as the kind it says; else the implementer,
 * one session fewer, with the first prefab whose chat is one, or the first of all.
 */
export function sheetStart(presets: readonly TicketPreset[], asked?: string): { name: string | undefined; kind: TicketChatKind } {
  const named = presets.find((each) => each.name.toLowerCase() === asked?.toLowerCase());
  if (named !== undefined) return { name: named.name, kind: named.ticketChat };
  const kind = DEFAULT_TICKET_CHAT_KIND;
  return { name: (presets.find((each) => each.ticketChat === kind) ?? presets[0])?.name, kind };
}
