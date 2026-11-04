import { createContext, useContext, useState, type CSSProperties, type MouseEvent } from 'react';
import { NodeResizer, type NodeProps } from '@xyflow/react';
import { Ellipsis } from 'lucide-react';
import { leastZoneSize, zoneGrid } from '@agent-board/daemon/board-layout';
import { MIN_ZONE_SIZE, type ArrangeSpacing } from '@agent-board/daemon/protocol';
import { Chip, ContextMenu, EditableName, Menu, useRenaming } from '../ui';
import { useTechnicalDetails } from '../technical';
import { CrewFramesContext } from './crew-view';
import { projectContextMenu, projectMenu, type ProjectMenuInput } from './menu-model';
import { ProjectSummaryContext } from './project-summary';
import { StatusGlyph } from './StatusMark';
import {
  AddIssueContext,
  BindZoneContext,
  CancelCloneContext,
  DropTargetContext,
  NewAgentContext,
  NewShellContext,
  SaveZoneLayoutContext,
  whyNoAgents,
  ZoneBindingContext,
  ZoneResizeContext,
  ZoneTrackerContext,
  type ZoneNodeType,
} from './ZoneNode';

/** Puts a new sticky note on the board where the screen point `at` is. */
export const NewNoteContext = createContext<(at: { x: number; y: number }) => void>(() => {});

/**
 * A zone under the Simplified design: a project, drawn as a neutral well with a heading of its colour's dot, its name, how
 * many of its agents need the user and a count of the rest. Every control of the Classic zone's tab is in its ⋯ and its
 * right-click menu, from the menu model; a double-click on the name still renames it.
 */
export function ProjectWell({ data: { zone, tileCount = 0, resizeMin }, selected, positionAbsoluteX, positionAbsoluteY, width, height }: NodeProps<ZoneNodeType>) {
  const saveLayout = useContext(SaveZoneLayoutContext);
  const resize = useContext(ZoneResizeContext);
  const rows = leastZoneSize(tileCount, { width: width ?? 0, height: height ?? 0 }, zoneGrid(zone.spacing));
  const least = {
    width: resizeMin?.width ?? Math.min(rows.width, width ?? 0),
    height: resizeMin?.height ?? Math.min(rows.height, height ?? 0),
  };
  const newAgent = useContext(NewAgentContext);
  const newShell = useContext(NewShellContext);
  const newNote = useContext(NewNoteContext);
  const pickTracker = useContext(ZoneTrackerContext);
  const bind = useContext(BindZoneContext);
  const binding = useContext(ZoneBindingContext);
  const cancelClone = useContext(CancelCloneContext);
  const addIssue = useContext(AddIssueContext);
  const dropTarget = useContext(DropTargetContext) === zone.id;
  const crews = useContext(CrewFramesContext).filter((frame) => frame.zoneId === zone.id);
  const summary = useContext(ProjectSummaryContext).get(zone.id);
  const technical = useTechnicalDetails();
  const renaming = useRenaming(zone.name, (name) => binding.rename(zone, name));
  // The spacing new projects take, read as a menu opens: its row names it.
  const [newZones, setNewZones] = useState<ArrangeSpacing>();
  const [menuAt, setMenuAt] = useState<{ x: number; y: number }>();
  // Its ⋯ rows are built only while ⋯ is open: a well re-renders whenever its agents change.
  const [optionsOpen, setOptionsOpen] = useState(false);
  const { clone } = zone;
  const readOnOpen = () => {
    window.agentBoard.flowEdges.settings().then((settings) => setNewZones(settings.arrangeSpacing), () => {});
  };
  const input: ProjectMenuInput = {
    zone,
    noAgents: clone === null ? undefined : whyNoAgents(zone),
    technical,
    newZones,
    // A well with no fill of its own is drawn untinted, so its slider starts from none.
    themeFill: 0,
    rename: renaming.startSoon,
    actions: { ...binding, newAgent, newShell, pickTracker, bind, cancelClone, addIssue },
  };
  const folder = zone.repoRoot === null ? (zone.userFolder ? zone.groupFolder : null) : zone.folder === '' ? zone.repoRoot : `${zone.repoRoot}/${zone.folder}`;
  const onContextMenu = (event: MouseEvent) => {
    // A right-click in one of its menus reaches here too, through the portal: it is the menu's, not a new one.
    if (!event.currentTarget.contains(event.target as Node)) return;
    // The project's own menu, not the board's for a selected node.
    event.preventDefault();
    event.stopPropagation();
    readOnOpen();
    setMenuAt({ x: event.clientX, y: event.clientY });
  };
  return (
    <div
      className="zone project-well"
      data-testid="zone"
      data-kind={zone.kind}
      data-cloning={clone !== null || undefined}
      data-drop-target={dropTarget || undefined}
      data-x={positionAbsoluteX}
      data-y={positionAbsoluteY}
      data-width={width}
      data-height={height}
      data-fill={zone.fillOpacity ?? undefined}
      style={{ '--zone-color': zone.color, '--zone-fill-pct': zone.fillOpacity ?? undefined } as CSSProperties}
      onContextMenu={onContextMenu}
    >
      {crews.map((frame) => (
        <div
          key={frame.orchestratorId}
          className="crew-frame"
          data-testid="crew-frame"
          data-orchestrator={frame.orchestratorId}
          data-members={frame.members.join(' ')}
          style={{ left: frame.x, top: frame.y, width: frame.width, height: frame.height }}
        >
          <span className="crew-frame-label">{frame.name}&apos;s crew</span>
        </div>
      ))}
      <NodeResizer
        isVisible={selected}
        color={zone.color}
        minWidth={Math.max(MIN_ZONE_SIZE.width, least.width)}
        minHeight={Math.max(MIN_ZONE_SIZE.height, least.height)}
        onResizeStart={() => resize.start(zone.id)}
        shouldResize={(_event, next) => resize.resize(zone.id, next)}
        onResizeEnd={(_event, { x, y, width, height }) => saveLayout(zone.id, { x, y, width, height })}
      />
      <div className="project-heading" data-testid="zone-tab">
        <span className="project-dot" aria-hidden="true" />
        <EditableName className="project-name" value={zone.name} renaming={renaming} label="Project name" />
        {summary !== undefined && summary.needsYou > 0 && (
          <span className="project-needs-you" aria-label={`${summary.needsYou} ${summary.needsYou === 1 ? 'needs' : 'need'} you`}>
            <StatusGlyph status="needs-you" />
            {summary.needsYou}
          </span>
        )}
        {dropTarget ? (
          <span className="project-summary">Drop to move here</span>
        ) : clone !== null ? (
          <span className="project-summary" data-testid="zone-clone" role="status" aria-label={`Cloning ${clone.repo}`}>
            {clone.percent === null ? 'Cloning…' : `${clone.phase ?? 'Cloning'} · ${clone.percent}%`}
          </span>
        ) : (
          summary !== undefined && summary.line !== '' && <span className="project-summary">{summary.needsYou > 0 ? `· ${summary.line}` : summary.line}</span>
        )}
        {/* Takes the room left, so the folder Show technical details adds moves nothing else. */}
        <span className="project-heading-gap" />
        {folder !== null && (
          <span className="project-folder" data-technical-detail>
            {folder}
          </span>
        )}
        <Menu
          entries={optionsOpen ? projectMenu(input) : []}
          onOpenChange={(open) => {
            setOptionsOpen(open);
            if (open) readOnOpen();
          }}
        >
          <Chip className="project-options nodrag" icon={<Ellipsis />} aria-label="Project options" title="Project options" />
        </Menu>
      </div>
      {menuAt !== undefined && (
        <ContextMenu
          at={menuAt}
          label={`${zone.name} project`}
          entries={projectContextMenu({ ...input, newNote: () => newNote(menuAt) })}
          onClose={() => setMenuAt(undefined)}
        />
      )}
    </div>
  );
}
