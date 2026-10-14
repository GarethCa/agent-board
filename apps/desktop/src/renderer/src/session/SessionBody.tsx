import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent, type ReactNode } from 'react';
import { ChevronsDownUp, ChevronsUpDown } from 'lucide-react';
import { paneIds } from '@agent-board/daemon/pane-layout';
import type { Agent, Shell } from '@agent-board/daemon/protocol';
import { STATE_LABELS } from '../states';
import { Button, ErrorText, Kbd, Textarea } from '../ui';
import { useAction } from '../use-action';
import { errorMessage } from '../../../shared/errors';
import { SessionDetails } from './SessionDetails';
import { DetailsHandle } from './DetailsHandle';
import { ChatView } from './ChatView';
import type { RunsChoice, RunsMode } from './chat';
import { ShellPanes } from './ShellPanes';
import { TerminalPane, type AttachState, type PaneStatus } from './TerminalPane';
import { panesLabel } from './panes';
import { composerBlock } from './composer-block';
import { composerKey, droppedPath, insertAt } from './composer-input';
import { canRestart, ENDED_SHELL_LABEL, exitText, RestartAgent } from './RestartAgent';

/**
 * What a session window or an expanded tile shows: one session's terminal (with its agent, live, for an agent's
 * controls and composer), or a shell tile's panes, its controls acting on the focused pane. The shell is undefined
 * until it is listed.
 */
export type WindowContent = { kind: 'session'; sessionId: string; agent?: Agent } | { kind: 'shell'; shellId: string; shell: Shell | undefined };

interface SessionBodyProps {
  content: WindowContent;
  /** Whether the details are collapsed to an icon rail, and how to change that. */
  detailsCollapsed: boolean;
  onDetailsCollapsed(collapsed: boolean): void;
  /** A line about the session shown above its terminal, e.g. why it is not asking yet. */
  notice?: ReactNode;
  /** Hears how the terminal (or a shell's focused pane) is attached. */
  onAttachState?(state: AttachState): void;
  /** Whether the terminal takes the keyboard as it opens. True by default. */
  autoFocus?: boolean;
  /** An agent's terminal, or its chat view; the terminal stays attached behind the chat. */
  view?: SessionView;
  /** Shows the terminal again, from a chat that can't read the agent's transcript. */
  onShowTerminal?(): void;
}

/** What an agent's session window shows of it: its terminal (the harness's own TUI) or its conversation as a chat. */
export type SessionView = 'terminal' | 'chat';

/**
 * The body shared by the session window and the expanded tile: the details strip
 * on the LEFT, and the dark terminal column, with a strip naming its pane and how it is attached, the terminal or a
 * shell's panes, and for an agent in its chat view a message composer under it. The terminal is attached while this is mounted.
 */
export function SessionBody({
  content,
  detailsCollapsed,
  onDetailsCollapsed,
  notice,
  onAttachState,
  autoFocus = true,
  view = 'terminal',
  onShowTerminal,
}: SessionBodyProps) {
  const agent = content.kind === 'session' ? content.agent : undefined;
  const shell = content.kind === 'shell' ? content.shell : undefined;
  const [single, setSingle] = useState<PaneStatus>({ state: 'attaching' });
  const [problem, setProblem] = useState<string>();
  const [focus, setFocus] = useState<string>();
  const [paneStatuses, setPaneStatuses] = useState<Record<string, PaneStatus>>({});
  const onPaneStatus = useCallback(
    (paneId: string, status: PaneStatus) => setPaneStatuses((current) => ({ ...current, [paneId]: status })),
    [],
  );
  const panes = shell ? paneIds(shell.layout) : [];
  // The focused pane, or the first when it was closed elsewhere (or none was clicked yet).
  const focusedPane = shell && (focus !== undefined && panes.includes(focus) ? focus : panes[0]);
  const pane = (focusedPane !== undefined && paneStatuses[focusedPane]) || single;
  // A shell tile not listed yet has no pane for its controls to act on.
  const controlSession = content.kind === 'session' ? content.sessionId : focusedPane;
  const live = controlSession !== undefined && pane.state !== 'exited' && pane.state !== 'unavailable';
  const openLink = useCallback(
    (url: string) => void window.agentBoard.trackers.openLink(url).catch((error: unknown) => setProblem(`could not open the link: ${errorMessage(error)}`)),
    [],
  );
  useEffect(() => onAttachState?.(pane.state), [pane.state, onAttachState]);
  const chat = view === 'chat' && agent !== undefined;
  // Expand all and Collapse all, kept while the window is open, through switches to the terminal and back.
  const [runs, setRuns] = useState<RunsChoice>({ mode: 'auto', at: 0 });
  const pressRuns = (mode: RunsMode) => setRuns((current) => ({ mode, at: current.at + 1 }));
  // Back from the chat, the terminal takes the keyboard again: it lost it when it was hidden.
  const terminalView = useRef<HTMLDivElement>(null);
  const wasChat = useRef(chat);
  useEffect(() => {
    if (wasChat.current && !chat) terminalView.current?.querySelector<HTMLElement>('.xterm-helper-textarea')?.focus();
    wasChat.current = chat;
  }, [chat]);

  return (
    <div className="session-window-body">
      <SessionDetails
        sessionId={controlSession}
        agent={agent}
        shell={shell}
        focusedPane={focusedPane}
        onFocusPane={setFocus}
        live={live}
        onProblem={setProblem}
        collapsed={detailsCollapsed}
        onCollapsed={onDetailsCollapsed}
        onOpenLink={openLink}
      />
      <DetailsHandle collapsed={detailsCollapsed} onCollapsed={onDetailsCollapsed} />
      <div className="session-window-main" data-surface="window">
        <div className="session-window-strip">
          <span className="session-window-pane">
            <span className="session-window-pane-dot" data-state={pane.state} aria-hidden />
            {agent ? HARNESS_COMMANDS[agent.harness] : shell ? panesLabel(panes.length) : 'shell'}
          </span>
          {chat && (
            <span className="chat-runs-actions">
              <Button variant="ghost" size="xs" icon={<ChevronsUpDown />} onClick={() => pressRuns('expanded')} tooltip="Open every run of tool calls">
                Expand all
              </Button>
              <Button variant="ghost" size="xs" icon={<ChevronsDownUp />} onClick={() => pressRuns('collapsed')} tooltip="Close every run of tool calls">
                Collapse all
              </Button>
            </span>
          )}
          <span className="session-window-status" data-testid="session-window-status" data-error={pane.state === 'exited' || problem !== undefined}>
            {statusText(pane, agent)}
            {problem && ` · ${problem}`}
          </span>
        </div>
        {notice}
        {agent && <BlockedBanner agent={agent} chat={chat} onShowTerminal={() => onShowTerminal?.()} />}
        {agent && canRestart(agent) && (
          <div className="agent-exit-banner" role="status" data-testid="agent-exit-banner">
            {exitText(agent)}
            <RestartAgent agent={agent} />
          </div>
        )}
        <div className="session-panes">
          {content.kind === 'session' ? (
            <>
              <div ref={terminalView} className="session-terminal-view" hidden={chat}>
                {/* Keyed by when its session started, so a relaunched agent's session is attached afresh; an ended
                    agent's pane shows the shell it dropped into, while that runs. */}
                <TerminalPane
                  key={`${content.agent?.createdAt}/${content.agent?.shellSessionId}`}
                  sessionId={content.agent?.shellSessionId ?? content.sessionId}
                  onStatus={setSingle}
                  autoFocus={autoFocus}
                  // The shell an ended agent dropped into is a plain shell.
                  harness={content.agent?.shellSessionId ? null : (content.agent?.harness ?? null)}
                />
              </div>
              {agent && (
                <div className="session-chat-view" hidden={!chat}>
                  <ChatView
                    key={agent.sessionId}
                    agent={agent}
                    active={chat}
                    onShowTerminal={() => onShowTerminal?.()}
                    runs={runs}
                    onOpenLink={openLink}
                  />
                </div>
              )}
            </>
          ) : shell && focusedPane !== undefined ? (
            <ShellPanes
              shell={shell}
              focused={focusedPane}
              onFocus={setFocus}
              onStatus={onPaneStatus}
              autoFocus={autoFocus}
              onResize={(splitId, ratio) =>
                window.agentBoard.shells.resizeSplit(shell.id, splitId, ratio).then(
                  () => {},
                  (error: unknown) => setProblem(`could not resize: ${errorMessage(error)}`),
                )
              }
            />
          ) : (
            <p className="session-window-pending">Loading panes…</p>
          )}
        </div>
        {agent && chat && <Composer agent={agent} />}
      </div>
    </div>
  );
}

/** Gives the keyboard to the terminal in the window around `from`, where a permission prompt waits; whether it could. */
function focusTerminal(from: HTMLElement): boolean {
  const terminal = from.closest('.session-window-main')?.querySelector<HTMLElement>('.xterm-helper-textarea');
  terminal?.focus();
  return terminal !== null && terminal !== undefined;
}

/**
 * The slim banner over the panes (the exit banner's) when an agent can't take a message and something gets it
 * going: Resume after a restart, Show prompt for a permission prompt. An ended agent's Restart is the exit banner's.
 * From the chat, where the terminal is hidden, Show prompt switches to it.
 */
function BlockedBanner({ agent, chat, onShowTerminal }: { agent: Agent; chat: boolean; onShowTerminal(): void }) {
  const [problem, setProblem] = useState<string>();
  const { busy, error, run } = useAction();
  const blocked = composerBlock(agent);
  if (blocked?.action !== 'resume' && blocked?.action !== 'show-prompt') return null;
  const resume = blocked.action === 'resume';
  return (
    <div className="agent-exit-banner" role="status" data-testid="agent-blocked-banner">
      {blocked.reason}
      <Button
        type="button"
        size="xs"
        variant="primary"
        loading={busy}
        onClick={(event) => {
          setProblem(undefined);
          if (resume) run(() => window.agentBoard.agents.resume(agent.sessionId));
          else if (chat) onShowTerminal();
          else if (!focusTerminal(event.currentTarget)) setProblem('the terminal is not attached yet');
        }}
      >
        {resume ? 'Resume' : 'Show prompt'}
      </Button>
      {(error ?? problem) && <ErrorText className="banner-error">{error ?? problem}</ErrorText>}
    </div>
  );
}

/** What the terminal strip calls an agent's pane: the command it runs. */
const HARNESS_COMMANDS: Record<Agent['harness'], string> = { claude: 'claude', codex: 'codex' };

function statusText({ state, ended, problem }: PaneStatus, agent: Agent | undefined): string {
  switch (state) {
    case 'attaching':
      return 'attaching…';
    case 'attached':
      if (agent?.shellSessionId != null) return ENDED_SHELL_LABEL;
      return agent ? STATE_LABELS[agent.state] : 'running';
    case 'exited':
      // An agent's own state says how it went: a stop and a clean exit are both just ended.
      if (agent?.state === 'done') return 'ended';
      if (agent?.state === 'stopped-by-restart' || ended?.stoppedByRestart) return 'stopped by a restart';
      return `exited${ended?.exitCode == null ? '' : ` (${ended.exitCode})`}`;
    case 'detached':
      return 'lost connection to the daemon';
    case 'unavailable':
      return `could not open the session: ${problem}`;
  }
}

/**
 * Sends the agent a message, as the needs-you inbox answers it: typed at its prompt and submitted. Enter sends;
 * Shift+Enter or Option+Enter make a new line, as in its terminal, and the lines reach it as one message. A pasted
 * image is kept where the agent can read it and its path put in the message, which is then pasted, as a terminal
 * pastes a dropped file.
 */
function Composer({ agent }: { agent: Agent }) {
  const [text, setText] = useState('');
  const [images, setImages] = useState<string[]>([]);
  const [pasting, setPasting] = useState(false);
  const [pasteError, setPasteError] = useState<string>();
  const field = useRef<HTMLTextAreaElement>(null);
  const { busy, error, run } = useAction();
  const blocked = composerBlock(agent);
  const send = () => {
    if (text.trim() === '' || blocked !== undefined || pasting) return;
    const withImage = images.some((path) => text.includes(path));
    run(
      () => window.agentBoard.agents.answer(agent.sessionId, text, withImage),
      () => {
        setText('');
        setImages([]);
      },
    );
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const action = composerKey(event.nativeEvent);
    if (action === undefined) return;
    event.preventDefault();
    if (action === 'send') return send();
    const box = event.currentTarget;
    box.setRangeText('\n', box.selectionStart, box.selectionEnd, 'end');
    setText(box.value);
  };
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...event.clipboardData.files].filter((file) => file.type.startsWith('image/'));
    if (files.length === 0) return;
    event.preventDefault();
    setPasting(true);
    setPasteError(undefined);
    void Promise.all(files.map(async (file) => droppedPath(await window.agentBoard.agents.pasteImage(await file.arrayBuffer()))))
      .then((paths) => {
        // Where the caret is now: the user may have typed on while the image was kept.
        const box = field.current;
        if (box === null) return;
        const placed = insertAt(box.value, box.selectionStart, box.selectionEnd, paths.join(' '));
        setText(placed.text);
        setImages((current) => [...current, ...paths]);
        requestAnimationFrame(() => field.current?.setSelectionRange(placed.caret, placed.caret));
      })
      .catch((problem: unknown) => setPasteError(`could not paste the image: ${errorMessage(problem)}`))
      .finally(() => setPasting(false));
  };
  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
    >
      <label className="composer-field">
        <span className="composer-prompt" aria-hidden>
          &gt;
        </span>
        <Textarea
          ref={field}
          className="composer-input"
          aria-label="Message to the agent"
          placeholder={blocked?.reason ?? `Message ${agent.name}…`}
          rows={1}
          value={text}
          disabled={blocked !== undefined}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
        {blocked === undefined && (
          <Button type="submit" size="sm" variant="primary" loading={busy || pasting} disabled={text.trim() === ''}>
            Send
            <Kbd className="composer-key">↵</Kbd>
          </Button>
        )}
      </label>
      {blocked === undefined && (
        <p className="composer-hint">
          <Kbd>⇧↵</Kbd> new line · paste an image to attach it
        </p>
      )}
      {(error ?? pasteError) && <ErrorText className="composer-error">{error ?? pasteError}</ErrorText>}
    </form>
  );
}
