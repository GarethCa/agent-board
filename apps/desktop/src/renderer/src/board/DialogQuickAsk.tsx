// Claude's own question dialog answered from the board: the quick ask, drawn from the question prompt the
// daemon holds, in Needs you, the Captain's panel, the Simplified pane and on the tile's chip. The answers are kept on
// the prompt in the daemon until Send, which answers Claude's held hook; nothing is typed into its terminal.
import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { SquareArrowOutUpRight } from 'lucide-react';
import type { PromptAnswer } from '@agent-board/daemon/protocol';
import { AnchoredPopover, Button, ErrorText, type Measured } from '../ui';
import { useAction } from '../use-action';
import { AskChip, QuickAsk, type QuickAskActions, type QuickAskDrafts } from './QuickAsk';
import { dialogAsk, dialogStatus, firstOpen, type DialogPrompt } from './quick-ask';

/**
 * What the quick ask of Claude's question prompt does, through the daemon, and the last error. A single question is
 * sent once answered, as an ask's is; of several, Send sends them all, as Claude's Submit does. `toTerminal` opens the
 * agent, where its dialog asks too.
 */
function useDialogActions(
  sessionId: string,
  prompt: DialogPrompt,
  toTerminal: (() => void) | undefined,
): { actions: QuickAskActions; error: string | undefined; busy: boolean } {
  const { error, run, busy } = useAction();
  const count = prompt.questions.length;
  const actions = useMemo<QuickAskActions>(() => {
    const agents = () => window.agentBoard.agents;
    return {
      answer: (index, answer, onDone) =>
        run(async () => {
          // The quick ask gives Claude's dialog only an option, several, or words: never a skip.
          await agents().answerQuestion(sessionId, prompt.id, index, answer as PromptAnswer);
          if (count === 1) await agents().sendAnswers(sessionId, prompt.id);
        }, onDone),
      send: () => run(() => agents().sendAnswers(sessionId, prompt.id)),
      ...(toTerminal === undefined ? {} : { toTerminal }),
    };
  }, [run, sessionId, prompt.id, count, toTerminal]);
  return { actions, error, busy };
}

/** What a sent or kept-open dialog says in place of its questions; null while the board can answer it. */
function DialogNote({ prompt, onOpen }: { prompt: DialogPrompt; onOpen: (() => void) | undefined }): ReactNode {
  const status = dialogStatus(prompt);
  if (status === 'sent') {
    return (
      <p className="quick-ask-note" data-testid="dialog-sent">
        Sent to its dialog. Waiting for Claude to take it.
      </p>
    );
  }
  if (status !== 'kept-open') return null;
  return (
    <p className="quick-ask-note" data-testid="dialog-kept-open" data-bad>
      Claude kept its dialog open. Answer it in its terminal.
      {onOpen !== undefined && (
        <Button size="xs" variant="ghost" icon={<SquareArrowOutUpRight />} onClick={onOpen}>
          Open
        </Button>
      )}
    </p>
  );
}

/**
 * Claude's question dialog where a list draws it (Needs you, the Captain's panel, the Simplified pane): the quick ask
 * while the board can answer it, then what became of the answers. It takes no focus as it shows, unless `still` is false.
 */
export function DialogQuickAsk({ sessionId, name, prompt, onOpen, still = true }: { sessionId: string; name: string; prompt: DialogPrompt; onOpen?(): void; still?: boolean }) {
  const ask = dialogAsk(prompt);
  const [at, setAt] = useState(() => firstOpen(ask));
  const { actions, error, busy } = useDialogActions(sessionId, prompt, onOpen);
  const drafts = useRef<QuickAskDrafts>(new Map()).current;
  const open = dialogStatus(prompt) === 'open';
  return (
    <div className="inbox-quick-ask" data-testid="dialog-quick-ask">
      {open ? (
        <QuickAsk name={name} ask={ask} at={Math.min(at, ask.questions.length)} onAt={setAt} actions={actions} busy={busy} drafts={drafts} still={still} dialog />
      ) : (
        <DialogNote prompt={prompt} onOpen={onOpen} />
      )}
      {error !== undefined && <ErrorText>{error}</ErrorText>}
    </div>
  );
}

/** The chip on a tile whose Claude asks in its dialog, and the quick ask it opens beside the tile, as an ask's does. */
export function TileDialogAsk({ sessionId, name, prompt, onOpen }: { sessionId: string; name: string; prompt: DialogPrompt; onOpen?(): void }) {
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState(0);
  const close = useCallback(() => setOpen(false), []);
  const toTerminal = useMemo(
    () =>
      onOpen === undefined
        ? undefined
        : () => {
            close();
            onOpen();
          },
    [onOpen, close],
  );
  const { actions, error, busy } = useDialogActions(sessionId, prompt, toTerminal);
  const kept = useRef<{ id: string; drafts: QuickAskDrafts }>({ id: prompt.id, drafts: new Map() });
  if (kept.current.id !== prompt.id) kept.current = { id: prompt.id, drafts: new Map() };
  const ask = dialogAsk(prompt);
  const chip = useRef<HTMLButtonElement>(null);
  const frame = useRef<Measured>({ getBoundingClientRect: () => (chip.current?.closest('.hybrid-tile') ?? chip.current!).getBoundingClientRect() });
  const show = (next: boolean) => {
    if (next) setAt(firstOpen(ask));
    setOpen(next);
  };
  return (
    <>
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
        onPointerDownOutside={(event) => {
          if (chip.current?.contains(event.target as Node) === true) event.preventDefault();
        }}
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        {dialogStatus(prompt) === 'open' ? (
          <QuickAsk name={name} ask={ask} at={Math.min(at, ask.questions.length)} onAt={setAt} actions={actions} busy={busy} drafts={kept.current.drafts} dialog />
        ) : (
          <DialogNote prompt={prompt} onOpen={toTerminal} />
        )}
        {error !== undefined && <ErrorText>{error}</ErrorText>}
      </AnchoredPopover>
    </>
  );
}
