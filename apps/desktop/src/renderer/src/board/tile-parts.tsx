// The parts an agent's tile is made of under either design: its head's buttons, its name's class, the rows that wait on
// the user's click (unsent, undelivered, trust, untyped), and its last message for the hover card.
import { useEffect, useState, type MouseEvent } from 'react';
import { FolderCheck, MoreHorizontal, RotateCcw, SendHorizontal, SquareTerminal } from 'lucide-react';
import { permissionPrompt, planPending, questionPrompt, type Agent, type UndeliveredMessage } from '@agent-board/daemon/protocol';
import { stepsWaitLine, toolSummary } from '../../../shared/needs-you';
import { Button, IconButton, Menu, type IconButtonProps, type MenuEntry } from '../ui';
import { cx } from '../ui/cx';
import { askTitle, tileDialogOf } from './quick-ask';
import { twoStep, TWO_STEP_MS, type TwoStep, type TwoStepEvent } from './two-step';

/**
 * The agent's last message for the card that shows below its tile, with the time its turn ended in the card's label:
 * none while the tile's body is an ask or a notice, which take its place.
 */
export function lastMessageCard(agent: Agent): { text: string; label: string } | undefined {
  if (askOf(agent) !== undefined || agent.notice !== null || !agent.lastMessage) return undefined;
  const at = agent.finishedAt === null ? undefined : new Date(agent.finishedAt);
  const time = at === undefined || Number.isNaN(at.getTime()) ? '' : ` · ${at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  return { text: agent.lastMessage, label: `Last message${time}` };
}

/**
 * What a tile waiting for you asks, in place of its task: the tool it wants to use, the question it asks through the
 * board with its options, or the plan it waits on. An ask on its steps card isn't repeated: the tile points
 * at it, the question in its tooltip. Its last message is on its hover card instead.
 */
export function askOf(agent: Agent): { tool?: string; text: string; title?: string; question?: true } | undefined {
  // A permission comes before questions: it is what Needs you lists the agent for.
  const prompt = permissionPrompt(agent) ?? questionPrompt(agent);
  // Claude's question tool's call shows as its questions with their options, as a question through the board does.
  if (prompt?.questions != null) {
    const text = prompt.questions.map(({ question, options }) => (options.length === 0 ? question : `${question}\n${options.map((option) => option.label).join(' · ')}`)).join('\n');
    const where = tileDialogOf(agent) !== undefined ? 'Answer from its chip, or in its terminal.' : 'Open the agent to answer.';
    return { text, title: `${text}\n\n${where}`, question: true };
  }
  if (prompt !== undefined) return { tool: prompt.toolName, text: toolSummary(prompt) };
  if (agent.ask !== null && agent.ask.card !== null) return { text: 'Asking you on a steps card', title: agent.ask.question, question: true };
  if (agent.ask !== null && agent.ask.questions.length > 1) return { text: agent.ask.question, title: askTitle(agent.name, agent.ask), question: true };
  if (agent.ask !== null) return { text: agent.ask.options.length === 0 ? agent.ask.question : `${agent.ask.question}\n${agent.ask.options.join(' · ')}`, question: true };
  if (planPending(agent)) return { text: `Waiting for you to decide on its plan: ${agent.plan.title}` };
  // Loose: a record from an older daemon has no steps wait at all.
  if (agent.stepsWait != null) return { text: stepsWaitLine(agent.stepsWait) };
  return undefined;
}

/**
 * What was typed at the agent's prompt and never sent, its Enter lost however often pressed: Send presses it again,
 * and Clear clears its prompt. Nothing more is typed at the agent until one of them is done. The question the agent
 * asked, which the row hides, is in its tooltip.
 */
export function UnsentRow({
  fitted,
  what,
  asked,
  onSend,
  onClear,
}: {
  fitted: (element: HTMLElement | null) => void;
  what: string;
  asked: string | undefined;
  onSend(): Promise<void>;
  onClear(): Promise<void>;
}) {
  const [pending, setPending] = useState<'send' | 'clear'>();
  const run = (action: 'send' | 'clear', act: () => Promise<void>) => {
    setPending(action);
    void act().finally(() => setPending(undefined));
  };
  const text = pending === 'send' ? `Sending ${what.charAt(0).toLowerCase()}${what.slice(1)}…` : `${what} not sent: it is typed at its prompt`;
  return (
    <span
      ref={fitted}
      className="hybrid-tile-body hybrid-tile-unsent"
      role="note"
      data-testid="tile-unsent"
      title={asked === undefined ? text : `${text}\n\nIt asked: ${asked}`}
      onDoubleClick={stopPropagation}
    >
      <span className="hybrid-tile-text">{text}</span>
      <Button size="xs" variant="primary" icon={<SendHorizontal />} className="nodrag" data-testid="send-unsent" disabled={pending !== undefined} onClick={() => run('send', onSend)}>
        Send
      </Button>
      <Button size="xs" className="nodrag" data-testid="clear-unsent" disabled={pending !== undefined} onClick={() => run('clear', onClear)}>
        Clear
      </Button>
    </span>
  );
}

/**
 * What was sent to the agent before its session was up and never typed: Resend sends it again (an ended agent starts
 * again with it), Clear forgets it.
 */
export function UndeliveredRow({
  fitted,
  items,
  onResend,
  onClear,
}: {
  fitted: (element: HTMLElement | null) => void;
  items: readonly UndeliveredMessage[];
  onResend(): Promise<void>;
  onClear(): Promise<void>;
}) {
  const [pending, setPending] = useState<'resend' | 'clear'>();
  const run = (which: 'resend' | 'clear', action: () => Promise<void>) => {
    setPending(which);
    void action().finally(() => setPending(undefined));
  };
  const what = items.length === 1 ? `${items[0]!.what} not delivered:` : `${items.length} messages not delivered:`;
  return (
    <span
      ref={fitted}
      className="hybrid-tile-body hybrid-tile-unsent"
      role="note"
      data-testid="tile-undelivered"
      title={items.map((item) => `${item.what} (${item.reason}):\n${item.text}`).join('\n\n')}
      onDoubleClick={stopPropagation}
    >
      <span className="hybrid-tile-text">
        {pending === 'resend' ? (
          'Resending…'
        ) : (
          <>
            <strong>{what}</strong> {items.map((item) => item.text).join(' · ')}
          </>
        )}
      </span>
      <Button size="xs" variant="primary" icon={<SendHorizontal />} className="nodrag" data-testid="resend-undelivered" disabled={pending !== undefined} onClick={() => run('resend', onResend)}>
        Resend
      </Button>
      <Button size="xs" className="nodrag" data-testid="clear-undelivered" disabled={pending !== undefined} onClick={() => run('clear', onClear)}>
        Clear
      </Button>
    </span>
  );
}

/**
 * Claude's trust screen, which its first prompt waits on: Trust folder answers it `Yes, I trust this folder`, only on
 * the user's click; the first prompt is typed once its session is up.
 */
export function TrustRow({ fitted, folder, onTrust }: { fitted: (element: HTMLElement | null) => void; folder: string; onTrust(): Promise<void> }) {
  const [pending, setPending] = useState(false);
  return (
    <span
      ref={fitted}
      className="hybrid-tile-body hybrid-tile-unsent"
      role="note"
      data-testid="tile-trust"
      title={`Claude is asking whether to trust this folder before it starts:\n${folder}\n\nTrust folder answers "Yes, I trust this folder"; its first prompt is typed once it is up.`}
      onDoubleClick={stopPropagation}
    >
      <span className="hybrid-tile-text">
        {pending ? (
          'Trusting its folder…'
        ) : (
          <>
            <strong>Claude asks to trust this folder:</strong> {folder}
          </>
        )}
      </span>
      <Button
        size="xs"
        variant="primary"
        icon={<FolderCheck />}
        className="nodrag"
        data-testid="trust-folder"
        disabled={pending}
        onClick={() => {
          setPending(true);
          void onTrust().finally(() => setPending(false));
        }}
      >
        Trust folder
      </Button>
    </span>
  );
}

/**
 * The first prompt its session never said it was up for, so never typed: Send types it at its prompt, once the user
 * has seen its terminal is ready for it (a startup screen of its harness answered).
 */
export function UntypedRow({ fitted, prompt, onSend }: { fitted: (element: HTMLElement | null) => void; prompt: string; onSend(): Promise<void> }) {
  const [pending, setPending] = useState(false);
  // What to do before Send (beside it), short enough to fit the one line a crowded tile leaves the row: Send on a
  // startup screen (trust this folder?) answers it.
  const hint = 'Answer its terminal first:';
  return (
    <span
      ref={fitted}
      className="hybrid-tile-body hybrid-tile-unsent"
      role="note"
      data-testid="tile-untyped"
      title={`Its first prompt is not typed yet: its session never said it was up. Answer its terminal first, then Send.\n\n${prompt}`}
      onDoubleClick={stopPropagation}
    >
      <span className="hybrid-tile-text">
        {pending ? (
          'Sending its first prompt…'
        ) : (
          <>
            <strong>{hint}</strong> {prompt}
          </>
        )}
      </span>
      <Button
        size="xs"
        variant="primary"
        icon={<SendHorizontal />}
        className="nodrag"
        data-testid="send-untyped"
        disabled={pending}
        onClick={() => {
          setPending(true);
          void onSend().finally(() => setPending(false));
        }}
      >
        Send
      </Button>
    </span>
  );
}

/** Why a session whose hooks never came leaves the board blind to it, and what to try: the warning row's tooltip. */
const HOOKS_SILENT_TITLE =
  "Its session sent no hooks in its first minute, nor since, so the board can't follow its turns: its state, needs-you and hand-offs don't update.\n\nHooks may be turned off in its settings (disableAllHooks), not installed, or unable to reach the board. Open shows its terminal; Stop and restart, pressed twice, ends it and starts it again, carrying on its conversation (the board can't tell whether it is mid-turn). This stays through restarts and clears on its first hook.";

/**
 * A live agent whose session sent no hook in its first minute, nor since: the board can't follow its turns. Open shows
 * its terminal; Stop and restart, offered only when its restart carries it on in place (`canRestartLive`), asks first, then
 * ends it and starts it again. The row goes on its first hook.
 */
export function HooksSilentRow({ fitted, onOpen, onRestart }: { fitted: (element: HTMLElement | null) => void; onOpen(): void; onRestart?: () => void }) {
  return (
    <span ref={fitted} className="hybrid-tile-body hybrid-tile-unsent" role="note" data-testid="tile-hooks-silent" title={HOOKS_SILENT_TITLE} onDoubleClick={stopPropagation}>
      <span className="hybrid-tile-text">
        <strong>No hooks from this session:</strong> the board can&apos;t follow its turns
      </span>
      <Button size="xs" icon={<SquareTerminal />} className="nodrag" data-testid="hooks-silent-open" onClick={onOpen}>
        Open
      </Button>
      {onRestart !== undefined && <StopAndRestart onRestart={onRestart} />}
    </span>
  );
}

/** Stop and restart, in two steps: a first press asks "Restart?", and only a second, separate one stops the agent. */
function StopAndRestart({ onRestart }: { onRestart(): void }) {
  const [step, setStep] = useState<TwoStep>('idle');
  const send = (event: TwoStepEvent) => {
    const next = twoStep(step, event);
    setStep(next.step);
    if (next.act) onRestart();
  };
  const armed = step !== 'idle';
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setStep((now) => twoStep(now, { kind: 'timeout' }).step), TWO_STEP_MS);
    return () => clearTimeout(timer);
  }, [armed]);
  return (
    <Button
      size="xs"
      variant={armed ? 'danger' : undefined}
      icon={<RotateCcw />}
      className="nodrag"
      data-testid="hooks-silent-restart"
      data-armed={armed || undefined}
      title={armed ? 'Press again to stop it and start it again' : undefined}
      onClick={() => send({ kind: 'press', now: Date.now() })}
      onPointerLeave={() => armed && send({ kind: 'leave' })}
      onBlur={() => armed && send({ kind: 'leave' })}
    >
      {armed ? 'Restart?' : 'Stop and restart'}
    </Button>
  );
}

/** A name this long fills both of its lines, so the rename pencil laid over its end would hide letters: it leaves room. */
const LONG_NAME = 24;
export const nameClass = (name: string) => (name.length > LONG_NAME ? 'hybrid-tile-name hybrid-tile-name-long' : 'hybrid-tile-name');

/** Keeps a double-click on a tile's control from also opening its session. */
export const stopPropagation = (event: MouseEvent) => event.stopPropagation();

/** An icon button in a tile's head: small, and kept from dragging the tile or opening its session. */
export function TileButton(props: Omit<IconButtonProps, 'size'>) {
  return <IconButton size="xs" {...props} className={cx('nodrag', props.className)} onDoubleClick={stopPropagation} />;
}

/** A tile's More button and its menu of the rarer actions; `onOpen` is called as the menu opens. */
export function TileMenu({ entries, onOpen }: { entries: MenuEntry[]; onOpen?(): void }) {
  return (
    <Menu entries={entries} align="end" onOpenChange={(open) => open && onOpen?.()}>
      <TileButton icon={<MoreHorizontal />} aria-label="More" title="More actions" />
    </Menu>
  );
}
