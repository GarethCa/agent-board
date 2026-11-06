// The quick ask on an agent's tile: its chip, and the ask it opens beside the tile. Only a click on the chip opens it,
// never the ask arriving; esc or a click elsewhere closes it, and the answers so far stay on the ask, in the daemon.
import { useCallback, useMemo, useRef, useState } from 'react';
import type { AgentAsk } from '@agent-board/daemon/protocol';
import { AnchoredPopover, ErrorText, type Measured } from '../ui';
import { useAction } from '../use-action';
import { AskChip, QuickAsk, type QuickAskActions, type QuickAskDrafts } from './QuickAsk';
import { firstOpen } from './quick-ask';

/** What the quick ask of the agent's ask `askId` does, through the daemon, and the last error; `onCard` once it is put on the board. */
export function useQuickAskActions(sessionId: string, askId: string, onCard?: () => void): { actions: QuickAskActions; error: string | undefined; busy: boolean } {
  const { error, run, busy } = useAction();
  // Read as each is done, not as it draws: a tile is drawn with no app around it too (the gallery, a static render).
  const actions = useMemo<QuickAskActions>(() => {
    const asks = () => window.agentBoard.asks;
    return {
      answer: (index, answer, onDone) => run(() => asks().answer(sessionId, askId, answer, index), onDone),
      send: () => run(() => asks().sendAsk(sessionId, askId)),
      skip: () => run(() => asks().answer(sessionId, askId, { skip: true })),
      toCard: () => run(() => asks().askToCard(sessionId, askId), onCard),
    };
  }, [run, sessionId, askId, onCard]);
  return { actions, error, busy };
}

export function TileQuickAsk({ sessionId, name, ask }: { sessionId: string; name: string; ask: AgentAsk }) {
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState(0);
  const close = useCallback(() => setOpen(false), []);
  const { actions, error, busy } = useQuickAskActions(sessionId, ask.id, close);
  // What is typed but not given yet, kept as the ask closes and opens again; a new ask starts with none.
  const kept = useRef<{ askId: string; drafts: QuickAskDrafts }>({ askId: ask.id, drafts: new Map() });
  if (kept.current.askId !== ask.id) kept.current = { askId: ask.id, drafts: new Map() };
  const { drafts } = kept.current;
  const chip = useRef<HTMLButtonElement>(null);
  // It opens beside the tile, never over it: pointed at the tile's frame, whichever corner its chip is in.
  const frame = useRef<Measured>({ getBoundingClientRect: () => (chip.current?.closest('.hybrid-tile') ?? chip.current!).getBoundingClientRect() });
  const show = (next: boolean) => {
    // It opens where the user left off: their first unanswered question, else Send.
    if (next) setAt(firstOpen(ask));
    setOpen(next);
  };
  return (
    <>
      {/* A double-click on the chip is two clicks on it, not a double-click on the tile, which opens its window. */}
      <AskChip ref={chip} ask={ask} open={open} aria-haspopup="dialog" onClick={() => show(!open)} onDoubleClick={(event) => event.stopPropagation()} />
      <AnchoredPopover
        anchor={{ measured: frame }}
        aria-label={`${name} asks`}
        side="right"
        align="start"
        sideOffset={12}
        className="quick-ask-popover"
        open={open}
        onOpenChange={show}
        // A press on its chip is the chip's own: it toggles the ask, rather than closing it to open it again.
        onPointerDownOutside={(event) => {
          if (chip.current?.contains(event.target as Node) === true) event.preventDefault();
        }}
        // The ask puts focus on its question, or its words field, itself.
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <QuickAsk name={name} ask={ask} at={Math.min(at, ask.questions.length)} onAt={setAt} actions={actions} busy={busy} drafts={drafts} />
        {error !== undefined && <ErrorText>{error}</ErrorText>}
      </AnchoredPopover>
    </>
  );
}
