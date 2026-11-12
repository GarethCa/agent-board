import { memo, useCallback, useContext, useEffect, useState } from 'react';
import { type NodeProps } from '@xyflow/react';
import { MEMORY_CARD_SIZE, LIST_CARD_FOLDED_SIZE, type MemoryChange, type MemoryEntry } from '@agent-board/daemon/protocol';
import { useToast } from '../../ui';
import { pressed } from '../../keys/registry';
import { isTyping } from '../../keys/typing';
import { useNow } from '../../inbox/use-now';
import { ItemActionsContext, useOnlySelected, type ItemNodeType } from './items';
import { ListCardPeekPopover, ListCardToolbar, useFocusOnce, useFresh, useLift, useRows, useZone, why } from './ListCardNodeParts';
import { MemoryCardView, MemoryIconView, MemoryPeek, type AddEntry } from './MemoryCard';
import { MemoryFull, type Unsaved } from './MemoryFull';
import { entryName, freshEntry, inListOrder, memoryData, newestWrite, scopeText, whoText } from './memory-card';

/** A memory's entries in list order, and who read them, for the user. The read key's `#` part is a re-read's count. */
const readView = (id: string) => window.agentBoard.items.readMemory(id).then((view) => ({ entries: inListOrder(view.entries), readers: view.readers }));

/**
 * A memory on the board: open, a card listing its documents and facts with a box to remember a fact (A); folded, its
 * brain icon alone (D). The icon opens the peek beside it, with every entry to search, edit, pin or remove; the card's
 * Open (a double-click, or ⌘↵ while it is selected) opens it full screen, where documents are read and written.
 */
export const MemoryNode = memo(function MemoryNode({ id: nodeId, data, selected: picked, dragging }: NodeProps<ItemNodeType>) {
  const selected = useOnlySelected(picked);
  const { update, remove, openLink } = useContext(ItemActionsContext);
  const toast = useToast();
  const { item } = data;
  const memory = memoryData(item.data);
  const zone = useZone(item.zoneId);
  const zoneName = zone.name;
  const lift = useLift(memory.folded === true);
  const scope = scopeText(memory.noAgents, zoneName);
  // Opening it full screen reads it again: who read it moves without a write.
  const [opens, setOpens] = useState(0);
  const view = useRows(item.id, `${item.updatedAt}#${opens}`, readView, (error) =>
    toast.show({ tone: 'error', id: `memory-read-${item.id}`, message: `Could not read “${memory.title}”: ${why(error)}` }),
  );
  const entries = view?.entries;
  // A memory just made opens with its add box focused.
  const focusAdd = useFocusOnce(nodeId, data.editing);
  const fresh = useFresh(entries, freshEntry, newestWrite);
  const now = new Date(useNow(false));
  const [peek, setPeek] = useState(false);
  const [full, setFull] = useState(false);
  const openFull = useCallback(() => {
    setPeek(false);
    setOpens((count) => count + 1);
    setFull(true);
  }, []);
  // ⌘↵ on the selected memory opens it full screen.
  useEffect(() => {
    if (!selected || full) return;
    const onKey = (event: KeyboardEvent) => {
      if (!pressed('tile.full', event) || isTyping(event) || document.querySelector('[role="dialog"]') !== null) return;
      event.preventDefault();
      openFull();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected, full, openFull]);
  const shown = entries ?? [];
  const count = entries?.length ?? memory.count;

  const change = useCallback(
    (what: MemoryChange) =>
      window.agentBoard.items.changeMemory(item.id, what).then(
        ({ entry }) => entry,
        (error: unknown) => {
          toast.show({ tone: 'error', id: `memory-${item.id}`, message: `Could not change “${memory.title}”: ${why(error)}` });
          return false as const;
        },
      ),
    [item.id, memory.title, toast],
  );
  const history = useCallback((entry: string) => window.agentBoard.items.memoryHistory(item.id, entry), [item.id]);
  const add: AddEntry = (entry) => void change({ action: 'add', ...entry });
  // A removed entry is one Undo from back: its history keeps the value it had.
  const removeEntry = (entry: MemoryEntry) =>
    void change({ action: 'remove', entry: entry.id }).then((removed) => {
      if (removed === false) return;
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
  // The entry being written went: the user's draft, offered back.
  const gone = (entry: MemoryEntry, draft: string) =>
    toast.show({
      message: `${entryName(entry)} was removed while you edited it`,
      ...(draft.trim() === '' ? {} : { persistent: true, action: { label: 'Add your text back', onClick: () => void change({ action: 'add', key: entry.key, text: entry.file ? draft : draft.trim(), ...(entry.file ? { file: true } : {}) }) } }),
    });
  // A draft full screen couldn't keep as it closed: saved from the toast when it can be, else copied.
  const unsaved = ({ name, text, change: save }: Unsaved) =>
    toast.show({
      message: `${name} wasn't saved`,
      persistent: true,
      action:
        save === undefined
          ? { label: 'Copy your text', onClick: () => void navigator.clipboard.writeText(text) }
          : { label: save.action === 'add' ? 'Add it' : 'Save it', onClick: () => void change(save) },
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
      readers={view?.readers.memory}
      loaded={entries !== undefined}
      now={now}
      onAdd={add}
      onOpen={openFull}
      fresh={fresh?.id}
      focusAdd={focusAdd}
    >
      {toolbar}
    </MemoryCardView>
  );

  return (
    <>
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
          onGone={gone}
          onFull={openFull}
        />
      </ListCardPeekPopover>
      {full && (
        <MemoryFull
          title={memory.title}
          scope={scope}
          zoneColor={zone.color}
          entries={shown}
          readers={view?.readers}
          now={now}
          onChange={change}
          history={history}
          onRemove={removeEntry}
          onGone={gone}
          onUnsaved={unsaved}
          onClose={() => setFull(false)}
          openLink={openLink}
        />
      )}
    </>
  );
});
