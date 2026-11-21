import { useEffect } from 'react';
import type { Agent, PullRequest, Shell, SplitDirection } from '@agent-board/daemon/protocol';
import type { Surface } from '@agent-board/daemon/window-layout';
import { MoreHorizontal } from 'lucide-react';
import { useGateRun } from '../gate/GatesProvider';
import { gated } from '../gate/gate-view';
import { useNow } from '../inbox/use-now';
import { useNeedsYouShows } from '../needs-you-setting';
import { useTechnicalDetails } from '../technical';
import { useAction } from '../use-action';
import { Button, IconButton, Menu, type MenuEntry } from '../ui';
import { errorMessage } from '../../../shared/errors';
import { AgentShelves, type ShelfViews } from './AgentShelves';
import { closePane } from './close-pane';
import { leadControl, sessionControls, type ControlId } from './controls';
import { CONTROL_ICONS, PANE_ICONS } from './details-icons';
import { useDetailsWidth } from './DetailsHandle';
import { useLiveFolder } from './live-folder';
import { useRecordDeletes } from './RecordList';
import { controlAction, useHomeDir } from './SessionDetails';
import { requestTab } from './tab-request';
import { gateSurfaceOf } from './tabs';
import { useShelvesAgents } from './use-live-board';

const NO_AGENTS: readonly Agent[] = [];

interface LiveShelvesProps {
  agent: Agent;
  /** Collapsed to the rail (⌘I), and how to change that. */
  collapsed: boolean;
  onCollapsed(collapsed: boolean): void;
  /** Says why something it did failed. Must be stable. */
  onProblem(problem: string | undefined): void;
  onOpenLink(url: string): void;
  onOpenPullRequest(pr: Pick<PullRequest, 'url'>): void;
  onOpenSurface?(surface: Surface): void;
  onOpenWeb(url: string): void;
  /** A pop-up's views, listed first in its sidebar. */
  views?: ShelfViews | undefined;
}

/**
 * An agent's sidebar in its window, at its leading edge, under both designs.
 * Its shelves (AgentShelves.tsx), kept current from the board: its crew (and who started it, read through
 * `useShelvesAgents`, so it renders for no other agent's change), its folder now, its gate and its clock.
 */
export function LiveShelves({ agent, collapsed, onCollapsed, onProblem, onOpenLink, onOpenPullRequest, onOpenSurface, onOpenWeb, views }: LiveShelvesProps) {
  const agents = useShelvesAgents(agent) ?? NO_AGENTS;
  const shows = useNeedsYouShows();
  const technical = useTechnicalDetails();
  const folder = useLiveFolder(agent.shellSessionId ?? agent.sessionId) ?? agent.cwd;
  const home = useHomeDir();
  const gateRun = useGateRun(agent.sessionId);
  const now = useNow(agent.schedule !== null);
  const records = useRecordDeletes(agent.sessionId, onProblem);
  const width = useDetailsWidth();
  const failed = (what: string) => (error: unknown) => onProblem(`could not ${what}: ${errorMessage(error)}`);
  const hasGate = gated(agent);
  return (
    <AgentShelves
      agent={agent}
      agents={agents}
      shows={shows}
      technical={technical}
      folder={folder}
      home={home}
      gate={hasGate ? gateRun : null}
      now={new Date(now)}
      records={records}
      width={width}
      collapsed={collapsed}
      onCollapsed={onCollapsed}
      views={views}
      actions={{
        openLink: onOpenLink,
        openPullRequest: onOpenPullRequest,
        openSurface: onOpenSurface,
        openWeb: onOpenWeb,
        revealFile: (path) => void window.agentBoard.sessions.revealFile(path).catch(failed('show the file')),
        copyFolder: (path) => void navigator.clipboard.writeText(path).catch(failed('copy')),
        revealFolder: (path) => void window.agentBoard.sessions.revealFolder(path).catch(failed('reveal the folder')),
        runGate: hasGate
          ? () => {
              requestTab(agent.sessionId, gateSurfaceOf(agent.sessionId));
              void window.agentBoard.gates.run(agent.sessionId).catch(failed('run the gate'));
            }
          : undefined,
      }}
    />
  );
}

/**
 * Under Classic, the window controls the shelves leave out, in its header: one state button (Wake while it is paused,
 * else Interrupt while it is mid-turn, else Pause) and ⋯ for the rest, Stop, splitting the tab and, while a shell split
 * into the tab has the focus, closing that pane. The header keeps its Run gate and Delete; the Simplified header has its
 * own state action and ⋯.
 */
export function ShelfControls({
  agent,
  live,
  compact = false,
  onSplit,
  shell,
  focusedPane,
  onFocusPane,
  onProblem,
}: {
  agent: Agent;
  live: boolean;
  compact?: boolean;
  onSplit?(direction: SplitDirection): void;
  /** The tab's panes, and the one with the focus: a shell pane there, not the agent's own, can be closed. */
  shell?: Shell;
  focusedPane?: string;
  onFocusPane?(sessionId: string): void;
  onProblem(problem: string | undefined): void;
}) {
  const { busy, error, run } = useAction();
  useEffect(() => onProblem(error), [error, onProblem]);
  const controls = sessionControls({ agent, live });
  const lead = leadControl(controls);
  const act = (id: ControlId) => run(controlAction(id, agent.sessionId, agent));
  const entries: MenuEntry[] = [
    ...controls
      .filter((control) => control !== lead)
      .map((control) => ({ label: control.label, icon: CONTROL_ICONS[control.id], hint: control.hint, danger: control.id === 'stop', disabled: !control.enabled || busy, onSelect: () => act(control.id) })),
    ...(onSplit
      ? [
          'separator' as const,
          { label: 'Split horizontally', icon: PANE_ICONS.splitHorizontally, hint: 'A shell beside the focused pane', onSelect: () => onSplit('horizontal') },
          { label: 'Split vertically', icon: PANE_ICONS.splitVertically, hint: 'A shell below the focused pane', onSelect: () => onSplit('vertical') },
        ]
      : []),
    ...(shell !== undefined && focusedPane !== undefined && focusedPane !== agent.sessionId
      ? [{ label: 'Close pane', icon: PANE_ICONS.closePane, hint: 'Close the focused pane, ending its shell', disabled: busy, onSelect: () => run(() => closePane(shell, focusedPane, onFocusPane)) }]
      : []),
  ];
  return (
    <span className="shelf-controls" data-testid="shelf-controls">
      {lead &&
        (compact ? (
          <IconButton icon={CONTROL_ICONS[lead.id]} size="sm" aria-label={lead.label} tooltip={`${lead.label}: ${lead.hint}`} disabled={!lead.enabled || busy} onClick={() => act(lead.id)} />
        ) : (
          <Button size="sm" icon={CONTROL_ICONS[lead.id]} variant={lead.id === 'wake' ? 'primary' : 'secondary'} disabled={!lead.enabled || busy} tooltip={lead.hint} onClick={() => act(lead.id)}>
            {lead.label}
          </Button>
        ))}
      <Menu align="end" entries={entries}>
        <IconButton icon={<MoreHorizontal />} size="sm" aria-label="More controls" tooltip="More: Stop, Split, Close pane" />
      </Menu>
    </span>
  );
}
