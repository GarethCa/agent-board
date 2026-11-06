import { memo, useCallback, useContext, useState } from 'react';
import { type NodeProps } from '@xyflow/react';
import { MEMORY_CARD_SIZE, LIST_CARD_FOLDED_SIZE, type MemoryChange, type MemoryEntry } from '@agent-board/daemon/protocol';
import { useToast } from '../../ui';
import { useNow } from '../../inbox/use-now';
import { ItemActionsContext, useOnlySelected, type ItemNodeType } from './items';
import { ListCardPeekPopover, ListCardToolbar, useFocusOnce, useFresh, useLift, useRows, useZone, why } from './ListCardNodeParts';
import { MemoryCardView, MemoryIconView, MemoryPeek, type AddEntry } from './MemoryCard';
import { entryName, freshEntry, inListOrder, memoryData, newestWrite, scopeText, whoText } from './memory-card';

/** A memory's entries in list order, for the user. */
const readEntries = (id: string) => window.agentBoard.items.readMemory(id).then((view) => inListOrder(view.entries));

/**
 * A memory on the board: open, a card listing its newest entries with a box to remember something (A); folded, its
 * brain icon alone (D). Either opens the peek beside it, with every entry to search, edit, pin or remove.
 */
export const MemoryNode = memo(function MemoryNode({ id: nodeId, data, selected: picked, dragging }: NodeProps<ItemNodeType>) {
  const selected = useOnlySelected(picked);
  const { update, remove } = useContext(ItemActionsContext);
  const toast = useToast();
  const { item } = data;
  const memory = memoryData(item.data);
  const zone = useZone(item.zoneId);
  const zoneName = zone.name;
  const lift = useLift(memory.folded === true);
  const scope = scopeText(memory.noAgents, zoneName);
  const entries = useRows(item.id, item.updatedAt, readEntries, (error) =>
    toast.show({ tone: 'error', id: `memory-read-${item.id}`, message: `Could not read “${memory.title}”: ${why(error)}` }),
  );
  // A memory just made opens with its add box focused.
  const focusAdd = useFocusOnce(nodeId, data.editing);
  const fresh = useFresh(entries, freshEntry, newestWrite);
  const now = new Date(useNow(false));
  const [peek, setPeek] = useState(false);
  const shown = entries ?? [];
  const count = entries?.length ?? memory.count;

  const change = useCallback(
    (what: MemoryChange) =>
      window.agentBoard.items.changeMemory(item.id, what).then(
        () => true,
        (error: unknown) => {
          toast.show({ tone: 'error', id: `memory-${item.id}`, message: `Could not change “${memory.title}”: ${why(error)}` });
          return false;
        },
      ),
    [item.id, memory.title, toast],
  );
  const add: AddEntry = (entry) => void change({ action: 'add', ...entry });
  // A removed entry is one Undo from back: its history keeps the value it had.
  const removeEntry = (entry: MemoryEntry) =>
    void change({ action: 'remove', entry: entry.id }).then((removed) => {
      if (!removed) return;
      toast.show({
        message: `Removed ${entryName(entry)} from “${memory.title}”`,
        action: {
          label: 'Undo',
          onClick: () =>
            void window.agentBoard.items.memoryHistory(item.id, entry.id).then(
              (versions) => {
                const kept = versions.find((version) => version.value !== null);
                if (kept !== undefined) void change({ action: 'restore', entry: entry.id, version: kept.version });
              },
              (error: unknown) => toast.show({ tone: 'error', id: `memory-${item.id}`, message: `Could not put back ${entryName(entry)}: ${why(error)}` }),
            ),
        },
      });
    });
  const fold = (folded: boolean) => {
    if (folded) setPeek(false);
    update({ id: item.id, data: { folded }, ...(folded ? LIST_CARD_FOLDED_SIZE : MEMORY_CARD_SIZE) });
  };
  const toolbar = (
    <ListCardToolbar
      visible={selected && !dragging}
      folded={memory.folded === true}
      onFold={fold}
      agents={{ noAgents: memory.noAgents, scope: scopeText(false, zoneName), toggle: () => update({ id: item.id, data: { noAgents: !memory.noAgents } }) }}
      noun="memory"
      onDelete={() => remove(item.id)}
    />
  );

  const body = memory.folded ? (
    <MemoryIconView
      title={memory.title}
      scope={scope}
      zoneColor={zone.color}
      lift={lift}
      count={count}
      pulse={fresh !== undefined}
      sub={fresh === undefined ? undefined : `${whoText(fresh.changedBy)} wrote ${entryName(fresh)}`}
      onOpen={() => setPeek(true)}
    >
      {toolbar}
    </MemoryIconView>
  ) : (
    <MemoryCardView
      title={memory.title}
      scope={scope}
      zoneColor={zone.color}
      count={count}
      entries={shown}
      loaded={entries !== undefined}
      now={now}
      onAdd={add}
      onOpen={() => setPeek(true)}
      fresh={fresh?.id}
      focusAdd={focusAdd}
    >
      {toolbar}
    </MemoryCardView>
  );

  return (
    <ListCardPeekPopover
      anchor={<div className="listcard-anchor">{body}</div>}
      open={peek}
      onOpenChange={setPeek}
      aria-label={`${memory.title}: every entry`}
      className="listcard-peek-popover"
    >
      <MemoryPeek
        title={memory.title}
        scope={scope}
        zoneColor={zone.color}
        entries={shown}
        now={now}
        focusAdd={shown.length === 0}
        onAdd={add}
        onEdit={(entry, text) => void change({ action: 'edit', entry: entry.id, text })}
        onPin={(entry, pinned) => void change({ action: 'edit', entry: entry.id, pinned })}
        onRemove={removeEntry}
        onGone={(entry, draft) =>
          toast.show({
            message: `${entryName(entry)} was removed while you edited it`,
            ...(draft.trim() === '' ? {} : { persistent: true, action: { label: 'Add your text back', onClick: () => add({ key: entry.key, text: draft.trim() }) } }),
          })
        }
      />
    </ListCardPeekPopover>
  );
});
