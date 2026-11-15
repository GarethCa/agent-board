import { useEffect, useState } from 'react';
import { paneIds } from '@agent-board/daemon/pane-layout';
import { INTERRUPT_KEY, type Agent, type ExternalSession, type Shell, type SplitDirection } from '@agent-board/daemon/protocol';
import { Copy, FolderOpen, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { errorMessage } from '../../../shared/errors';
import { keyText } from '../keys/registry';
import { STATE_LABELS } from '../states';
import { Button, Hint, IconButton, Kbd, PanelRow, Section, StatusPill } from '../ui';
import { useAction } from '../use-action';
import { closePane } from './close-pane';
import { sessionControls, type Control, type ControlId } from './controls';
import { useDetailsWidth } from './DetailsHandle';
import { CONTROL_ICONS, PANE_ICONS, SectionIcon, type SectionId } from './details-icons';
import { paneLabel } from '../board/rename';
import { tildify, useLiveFolder } from './live-folder';
import { panesLabel } from './panes';

export interface SessionDetailsProps {
  /** The session the controls act on; none while a shell tile is still being listed. */
  sessionId: string | undefined;
  /** A session started outside the app: only what its hooks reported, and no controls (it has no terminal here). */
  external?: ExternalSession;
  shell?: Shell;
  /** For the tab showing, a shell tile's: the focused pane, and how to focus another (e.g. a new one). */
  focusedPane?: string;
  onFocusPane?(sessionId: string): void;
  /** Splits the tab's focused pane. */
  onSplit?(direction: SplitDirection): void;
  live: boolean;
  /** Says why a control failed, or clears that with undefined when the next one starts. Must be stable. */
  onProblem(problem: string | undefined): void;
  /** Whether it is collapsed to an icon rail, and how to change that (⌘I). */
  collapsed: boolean;
  onCollapsed(collapsed: boolean): void;
}

/**
 * The details strip, on the LEFT of a session window that shows no agent's shelves (a shell's, a session not listed as
 * an agent, one started outside the app): its controls, a shell's panes and live folder, or what an outside session's
 * hooks reported, in the board menu's section style, or the same collapsed to an icon rail, whose actions act and whose
 * facts open the strip at their section. An agent's window has its shelves instead.
 */
export function SessionDetails(props: SessionDetailsProps) {
  const { sessionId, external, shell, focusedPane, onFocusPane, onSplit, live, onProblem, collapsed, onCollapsed } = props;
  const width = useDetailsWidth();
  const { busy, error, run } = useAction();
  useEffect(() => onProblem(error), [error, onProblem]);
  /** The section the rail last asked for, drawn open even if it was closed. */
  const [reveal, setReveal] = useState<SectionId>();

  const act = (id: ControlId) => {
    if (sessionId === undefined) return;
    run(controlAction(id, sessionId, undefined));
  };
  const controls = external ? [] : sessionControls({ agent: undefined, live });
  const closeFocusedPane = () => {
    if (shell === undefined || focusedPane === undefined) return;
    run(() => closePane(shell, focusedPane, onFocusPane));
  };
  const paneActions = onSplit !== undefined && [
    { label: 'Split horizontally', icon: PANE_ICONS.splitHorizontally, hint: 'Split inside the tab: a shell beside the focused pane', onClick: () => onSplit('horizontal') },
    { label: 'Split vertically', icon: PANE_ICONS.splitVertically, hint: 'Split inside the tab: a shell below the focused pane', onClick: () => onSplit('vertical') },
    ...(shell ? [{ label: 'Close pane', icon: PANE_ICONS.closePane, hint: 'Close the focused pane, ending its shell', onClick: closeFocusedPane }] : []),
  ];
  const open = (section: SectionId) => {
    setReveal(section);
    onCollapsed(false);
  };

  if (collapsed) {
    const fact = (section: SectionId, label: string) => (
      <IconButton key={section} icon={<SectionIcon id={section} />} aria-label={label} tooltip={label} onClick={() => open(section)} />
    );
    return (
      <nav className="session-details session-details-rail" aria-label="Session controls">
        {controls.map((control) => (
          <IconButton
            key={control.id}
            icon={CONTROL_ICONS[control.id]}
            variant={control.id === 'stop' ? 'danger' : 'ghost'}
            aria-label={control.label}
            tooltip={control.hint}
            disabled={!control.enabled || busy}
            onClick={() => act(control.id)}
          />
        ))}
        {paneActions &&
          paneActions.map((action) => (
            <IconButton key={action.label} icon={action.icon} aria-label={action.label} tooltip={action.hint} disabled={busy} onClick={action.onClick} />
          ))}
        {external && (
          <>
            {fact('status', 'Status file')}
            {fact('worktree', 'Folder')}
            {fact('subagents', subagentsLabel(external))}
          </>
        )}
        <span className="details-rail-fill" />
        <IconButton icon={<PanelLeftOpen />} aria-label="Show details" tooltip={<>Show details<Kbd>{keyText('window.details')}</Kbd></>} onClick={() => onCollapsed(false)} />
      </nav>
    );
  }

  /** The section's props: its id, and drawn open while the rail just asked for it. */
  const sectionProps = (id: SectionId) => (reveal === id ? { open: true, onOpenChange: () => setReveal(undefined) } : {});
  return (
    <aside className="session-details" aria-label="Session details" style={{ width }}>
      <div className="session-details-head">
        <span className="session-details-title">Details</span>
        <Kbd>{keyText('window.details')}</Kbd>
        <IconButton icon={<PanelLeftClose />} size="sm" aria-label="Hide details" tooltip="Collapse to an icon rail" onClick={() => onCollapsed(true)} />
      </div>
      <div className="session-details-sections">
        {!external && (
        <nav aria-label="Session controls">
          <Section label="Controls" {...sectionProps('controls')}>
            <div className="session-controls">
              {controls.map((control) => (
                <ControlButton key={control.id} control={control} busy={busy} onClick={() => act(control.id)} />
              ))}
            </div>
          </Section>
          {paneActions && (
            <Section label="Panes" meta={paneCount(shell?.layout)} {...sectionProps('panes')}>
              <div className="session-controls session-controls-column">
                {paneActions.map((action) => (
                  <Button key={action.label} size="sm" className="session-control" icon={action.icon} disabled={busy} title={action.hint} onClick={action.onClick}>
                    {action.label}
                  </Button>
                ))}
              </div>
            </Section>
          )}
        </nav>
        )}
        {shell && (
          <LiveFolder
            sessionId={focusedPane}
            fallback={focusedPane === undefined ? undefined : shell.paneFolders[focusedPane]}
            pane={paneIds(shell.layout).length > 1 && focusedPane !== undefined ? (paneLabel(shell, focusedPane) ?? shell.name) : undefined}
            onProblem={onProblem}
          />
        )}
        {external && <ExternalSections session={external} sectionProps={sectionProps} />}
      </div>
    </aside>
  );
}

/** The home folder, for writing paths with `~`; undefined until the daemon says. */
export function useHomeDir(): string | undefined {
  const [home, setHome] = useState<string>();
  useEffect(() => {
    window.agentBoard.daemonHealth().then((health) => setHome(health.homeDir), () => {});
  }, []);
  return home;
}

/** The focused pane's folder now, following `cd` and the focus. Copyable, and opens in the file manager. */
function LiveFolder({
  sessionId,
  fallback,
  pane,
  onProblem,
}: {
  sessionId: string | undefined;
  /** What to show until the first lookup answers: where it started, or was last seen. */
  fallback: string | undefined;
  pane: string | undefined;
  onProblem(problem: string | undefined): void;
}) {
  const folder = useLiveFolder(sessionId) ?? fallback;
  const home = useHomeDir();
  return (
    <Section label="Folder (live)" icon={<SectionIcon id="worktree" />} meta={pane}>
      {folder === undefined ? (
        <Hint>Looking…</Hint>
      ) : (
        <>
          <p className="details-mono" data-testid="details-folder" title={folder}>
            {tildify(folder, home)}
          </p>
          <div className="details-folder-actions">
            <IconButton
              icon={<Copy />}
              size="sm"
              aria-label="Copy folder"
              tooltip="Copy the folder's path"
              onClick={() => void navigator.clipboard.writeText(folder).catch((error: unknown) => onProblem(`could not copy: ${errorMessage(error)}`))}
            />
            <IconButton
              icon={<FolderOpen />}
              size="sm"
              aria-label="Reveal folder in Finder"
              tooltip="Reveal in Finder"
              onClick={() => void window.agentBoard.sessions.revealFolder(folder).catch((error: unknown) => onProblem(`could not reveal the folder: ${errorMessage(error)}`))}
            />
          </div>
        </>
      )}
    </Section>
  );
}

/** An external session's details: what its hooks and status file told the board. */
function ExternalSections({
  session,
  sectionProps,
}: {
  session: ExternalSession;
  sectionProps(id: SectionId): { open?: boolean; onOpenChange?(open: boolean): void };
}) {
  const { status } = session;
  return (
    <>
      <Section label="Status file" icon={<SectionIcon id="status" />} meta={status?.state ?? 'None'} {...sectionProps('status')}>
        {status === null ? (
          <Hint>Its worktree has no status file from this session.</Hint>
        ) : (
          <>
            <p className="details-message" data-testid="details-status">
              {status.summary}
            </p>
            {status.handover && <p className="details-mono details-soft">handover {status.handover}</p>}
            {status.reviewDoc && <p className="details-mono details-soft">review {status.reviewDoc}</p>}
          </>
        )}
      </Section>
      <Section label="First prompt">{session.description ? <p className="details-message">{session.description}</p> : <Hint>Not seen yet.</Hint>}</Section>
      <Section label="Folder" icon={<SectionIcon id="worktree" />} {...sectionProps('worktree')}>
        {session.branch !== null && <p className="details-mono details-branch">{session.branch}</p>}
        <p className="details-mono details-soft" title={session.worktree ?? session.cwd}>
          {session.worktree ?? session.cwd}
        </p>
      </Section>
      <Section label="Subagents" icon={<SectionIcon id="subagents" />} meta={session.subagents.length === 0 ? 'None' : String(session.subagents.length)} {...sectionProps('subagents')}>
        {session.subagents.length === 0 ? (
          <Hint>None</Hint>
        ) : (
          <ul className="details-list">
            {session.subagents.map((subagent) => (
              <PanelRow
                key={subagent.id}
                as="li"
                mark={<SectionIcon id="subagents" className="details-row-icon" />}
                name={subagent.type}
                end={<StatusPill state={subagent.state} label={STATE_LABELS[subagent.state]} />}
              />
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}

function ControlButton({ control, busy, onClick }: { control: Control; busy: boolean; onClick(): void }) {
  return (
    <Button
      size="sm"
      variant={control.id === 'stop' ? 'danger' : control.id === 'wake' ? 'primary' : 'secondary'}
      className="session-control"
      icon={CONTROL_ICONS[control.id]}
      disabled={!control.enabled || busy}
      title={control.hint}
      onClick={onClick}
    >
      {control.label}
    </Button>
  );
}

const paneCount = (layout: Shell['layout'] | undefined) => panesLabel(layout === undefined ? 1 : paneIds(layout).length);

function subagentsLabel(session: Pick<ExternalSession, 'subagents'>): string {
  return session.subagents.length === 0 ? 'Subagents: none' : `Subagents: ${session.subagents.length}`;
}

/**
 * What a control does: the agent's daemon call, or for a shell, the keystroke or kill. Its failure says which control
 * failed.
 */
export function controlAction(id: ControlId, sessionId: string, agent: Agent | undefined): () => Promise<unknown> {
  const { agents, sessions } = window.agentBoard;
  const failing = (verb: string, action: () => Promise<unknown>) => () =>
    action().catch((failure: unknown) => {
      throw new Error(`could not ${verb}: ${errorMessage(failure)}`);
    });
  switch (id) {
    case 'interrupt':
      return failing('interrupt', agent ? () => agents.interrupt(sessionId) : async () => sessions.write(sessionId, INTERRUPT_KEY));
    case 'pause':
      return failing('pause', () => agents.pause(sessionId));
    case 'wake':
      return failing('wake', () => agents.resume(sessionId));
    case 'stop':
      return failing('stop', agent ? () => agents.stop(sessionId) : () => sessions.kill(sessionId));
  }
}
