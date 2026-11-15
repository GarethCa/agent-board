// What an agent holds on the board: the agent notes it wrote and the document cards it showed. They go off the board
// with it, unless it passes one to another agent first (`orchestrator.passItem`), which then holds it. The user's own
// notes, and an agent note the user has edited, are no agent's to take away.
import type { DatabaseSync } from 'node:sqlite';
import { agentNoteAuthor } from './agent-notes.ts';
import type { AgentHost } from './agents.ts';
import type { BoardConnection } from './board.ts';
import type { DocumentHost } from './documents.ts';
import type { DaemonCall } from './orchestrator-layout.ts';
import type { ActivityEntry, OrchestratorAccess } from './orchestrators.ts';
import { invalidParams, paramsObject, stringParam } from './params.ts';
import { BOARD_ERROR, type AgentNoteAuthor, type BoardItem, type DaemonMethods } from './protocol.ts';
import { RpcMethodError, type RpcHandlers } from './rpc.ts';
import { cutText } from './text-cut.ts';

type ItemOwnerMethods = Pick<DaemonMethods, 'orchestrator.passItem'>;

export interface ItemOwnersOptions {
  db: DatabaseSync;
  access: OrchestratorAccess;
  call: DaemonCall;
  agents: Pick<AgentHost, 'get'>;
  documents: Pick<DocumentHost, 'pass' | 'tell'>;
  log(message: string): void;
}

export interface ItemOwners {
  handlers<Context extends BoardConnection>(): RpcHandlers<ItemOwnerMethods, Context>;
  /**
   * The agent `sessionId` is being removed: the agent notes it holds go with it, but not one the user edited. A ticket's
   * chat takes its ticket's board with it, every item on it.
   */
  agentRemoved(sessionId: string): Promise<void>;
  /**
   * At start: the agent notes of agents no longer on the board (removed while the daemon was down, or mid-way through
   * taking their notes away) go too. Not one the user edited, nor a lane's note an arrange made, which the next
   * arrange in its zone takes over. So do the items on the board of a ticket whose chat is gone.
   */
  sweep(): Promise<void>;
}

const outOfScope = (message: string) => new RpcMethodError(BOARD_ERROR.outOfScope, message);

const quoted = (text: string) => `“${cutText(text, 40)}”`;

/** What a passed item is called in a log line and the message to its new holder. */
function passedName(item: BoardItem): string {
  return item.kind === 'document' ? `document ${quoted(String(item.data.title ?? ''))}` : `note ${quoted(String(item.data.text ?? ''))}`;
}

export function createItemOwners(options: ItemOwnersOptions): ItemOwners {
  const { db, access, call } = options;
  const madeByOf = db.prepare('SELECT made_by FROM board_items WHERE id = ?');
  const mark = db.prepare('UPDATE board_items SET made_by = ? WHERE id = ?');
  const notesOf = db.prepare("SELECT id, data FROM board_items WHERE kind = 'agent-note' AND made_by = ?");
  const onTicket = db.prepare('SELECT id FROM board_items WHERE ticket = ? ORDER BY rowid');
  const orphans = db.prepare('SELECT id, ticket FROM board_items WHERE ticket IS NOT NULL AND ticket NOT IN (SELECT session_id FROM agents) ORDER BY rowid');
  const strays = db.prepare(
    `SELECT id, made_by, data FROM board_items WHERE kind = 'agent-note' AND made_by IS NOT NULL
       AND made_by NOT IN (SELECT session_id FROM agents) AND made_by NOT IN (SELECT id FROM external_sessions)`,
  );

  /** The agent that holds `item`: an agent note's maker; a document card's, or the agent that showed it. Null: no agent's. */
  const holderOf = (item: BoardItem): string | null => {
    const madeBy = (madeByOf.get(item.id) as { made_by: string | null } | undefined)?.made_by ?? null;
    if (madeBy !== null || item.kind !== 'document') return madeBy;
    return (item.data.agent as AgentNoteAuthor | undefined)?.sessionId ?? null;
  };

  return {
    handlers<Context extends BoardConnection>(): RpcHandlers<ItemOwnerMethods, Context> {
      return {
        'orchestrator.passItem': async (params, connection) => {
          const p = paramsObject(params);
          const me = access.caller('orchestrator.passItem', p, connection);
          const entry: ActivityEntry = { detail: '' };
          return access.logged(me, 'pass', entry, async () => {
            const id = stringParam(p, 'id');
            const item = (await call('item.list', { allBoards: true })).find((each) => each.id === id);
            if (item === undefined) throw invalidParams(`no board item ${id}`);
            if (item.kind !== 'agent-note' && item.kind !== 'document') {
              throw invalidParams(`that is a ${item.kind} item: an agent passes only an agent note or a document`);
            }
            entry.on = { id: item.id, name: passedName(item) };
            const to = options.agents.get(stringParam(p, 'to'));
            if (to === undefined) throw invalidParams(`no agent ${stringParam(p, 'to')}`);
            entry.detail = `to ${to.name}`;
            // Passing types at its prompt, as a message does: to any agent, one the user started by hand included.
            const holder = holderOf(item);
            if (holder === null && me.agent !== null) throw outOfScope("that is the user's: an agent passes only what an agent holds");
            if (holder === to.sessionId) throw invalidParams(`${to.name} holds it already`);
            const held = holder === null ? undefined : options.agents.get(holder);
            // What any agent on the board holds may be passed on, ended or not; what one that is gone held, only as its parts are taken over.
            const mayPass = me.agent === null || held !== undefined || access.mayTakeOver(me, holder);
            if (!mayPass) throw outOfScope('that is not yours to pass');

            const giver = me.agent === null ? 'The user' : me.name;
            const from = item.data.agent as AgentNoteAuthor | undefined;
            const patch: Record<string, unknown> = { agent: agentNoteAuthor(to) };
            if (from !== undefined) patch.passedFrom = from;
            // The document (which may refuse) and the card change first; the new holder is told only once both have.
            const document = item.kind === 'document' ? options.documents.pass(String(item.data.documentId), to.sessionId) : undefined;
            mark.run(to.sessionId, item.id);
            const passed = await call('item.update', { id: item.id, data: patch });
            options.documents.tell(
              to.sessionId,
              document === undefined
                ? `[agent-board] ${giver} passed you a note on the board (${item.id}), yours now:\n${String(item.data.text ?? '')}`
                : `[agent-board] ${giver} passed you the document ${quoted(document.title)}: ${document.path}. It is yours now, and goes off the board with you.`,
            );
            return passed;
          });
        },
      };
    },

    async agentRemoved(sessionId) {
      for (const note of notesOf.all(sessionId) as { id: string; data: string }[]) {
        // Passed on meanwhile: its new holder's now.
        if ((madeByOf.get(note.id) as { made_by: string | null } | undefined)?.made_by !== sessionId) continue;
        if ((JSON.parse(note.data) as { editedByUser?: unknown }).editedByUser === true) {
          // The user's now: no agent holds it.
          mark.run(null, note.id);
          continue;
        }
        await call('item.delete', { id: note.id }).catch((error: unknown) => options.log(`could not take ${sessionId}'s note ${note.id} off the board: ${(error as Error).message}`));
      }
      // A ticket's chat takes its own board with it: every item on it is the ticket's, as its helpers are.
      for (const { id } of onTicket.all(sessionId) as { id: string }[]) {
        await call('item.delete', { id }).catch((error: unknown) => options.log(`could not take ${id} off the board of ${sessionId}'s ticket: ${(error as Error).message}`));
      }
    },

    async sweep() {
      for (const item of orphans.all() as { id: string; ticket: string }[]) {
        await call('item.delete', { id: item.id }).catch((error: unknown) => options.log(`could not take ${item.id} off the board of ${item.ticket}'s ticket, gone: ${(error as Error).message}`));
      }
      for (const note of strays.all() as { id: string; made_by: string; data: string }[]) {
        const data = JSON.parse(note.data) as { editedByUser?: unknown; arrange?: unknown };
        if (data.arrange !== undefined) continue;
        if (data.editedByUser === true) {
          mark.run(null, note.id);
          continue;
        }
        await call('item.delete', { id: note.id }).catch((error: unknown) => options.log(`could not take the note ${note.id} of ${note.made_by}, gone, off the board: ${(error as Error).message}`));
      }
    },
  };
}
