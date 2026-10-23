// Deleting an agent's records from its sidebar: what Delete, its Undo and a section's Show do, apart from React, so it
// is unit-tested.
import type { AgentRecord } from '@agent-board/daemon/protocol';
import type { ToastOptions } from '../ui';

export interface RecordDeleteDeps {
  /** Deletes the record, or brings it back, in the daemon. */
  set(record: AgentRecord, deleted: boolean): Promise<void>;
  toast(options: ToastOptions): void;
  /** Keeps the deleted record's row drawn, fading, while its Undo is up; and stops. */
  fade(key: string): void;
  unfade(key: string): void;
}

export interface RecordDeleter {
  /** Deletes the record, its row fading, with Undo in a toast; `what` names it there. */
  remove(record: AgentRecord, what: string): void;
  /** Brings the records back: a section's Show, for what its deleted records hide. */
  restore(records: readonly AgentRecord[]): void;
}

export function recordDeleter(deps: RecordDeleteDeps): RecordDeleter {
  return {
    remove(record, what) {
      deps.fade(record.key);
      void deps.set(record, true);
      deps.toast({
        message: `Deleted the ${what} record`,
        action: {
          label: 'Undo',
          onClick: () => {
            deps.unfade(record.key);
            void deps.set(record, false);
          },
        },
      });
    },
    restore(records) {
      for (const record of records) void deps.set(record, false);
    },
  };
}
