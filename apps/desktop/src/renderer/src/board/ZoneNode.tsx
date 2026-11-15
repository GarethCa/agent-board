import { memo, useContext, useId, useState, type CSSProperties, type ReactNode } from 'react';
import { usePrefabs } from '../crews/prefab-store';
import { NodeResizer, type Node, type NodeProps } from '@xyflow/react';
import { ChevronDown, CircleDot, Ellipsis, GitBranch, LayoutGrid, Link2, ListPlus, Plus, X } from 'lucide-react';
import { Chip, EditableName, Menu, useRenaming } from '../ui';
import { folderLabel } from './folders';
import { bindEntries, newAgentMenu, tidyBlocked, tidyMenu, zoneMenu, zoneTabEntries, type ModelEntry, type ZoneBindingActions, type ZoneTabChip } from './menu-model';
import { leastZoneSize, zoneGrid } from '@agent-board/daemon/board-layout';
import { CrewFramesContext } from './crew-view';
import { CrewFrameBoxes } from './CrewFrameBoxes';
import { tokenNumber } from '../theme';
import { useZoneTabFold } from './zone-tab-fold';
import { useSimplified } from '../design';
import { FoldButton, FoldedZone } from './FoldedZone';
import { ProjectWell } from './ProjectWell';
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
} from './zone-contexts';
import type { ClusterView, ShelfView } from './shelves';
import { ClustersView, ShelvesView } from './ShelvesView';
import { ZoneTodoBadge } from './items/ZoneTodoBadge';
import { useMenuBarSection } from '../keys/menu-bar-bridge';
import {
  MIN_ZONE_SIZE,
  TRACKER_PROVIDERS,
  type ArrangeSpacing,
  type Zone,
} from '@agent-board/daemon/protocol';

/**
 * The part of the board, in board coordinates, a zone must cover to hold its tiles with room round them, and to be
 * at least its least size: left and top are Infinity with no tiles.
 */
export interface ZoneCovers {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * `covers` says what the zone must cover to hold the tiles the board has put in it where they are, and `tileCount`
 * how many there are: shrinking it past them packs them inward. `resizeMin` is how far the resize under way can go,
 * once a step of it found the tiles can be packed no tighter. `grown` marks a zone drawn bigger than it is stored.
 */
export type ZoneNodeType = Node<
  {
    zone: Zone;
    covers?: ZoneCovers;
    tileCount?: number;
    resizeMin?: { width?: number; height?: number };
    /** Grown for now round an expanded tile and the tiles it pushed aside: no snap target meanwhile. */
    grown?: true;
    /** A shelved zone's shelves, as drawn (`withShelves`): it is drawn at least big enough for them, and not resized by hand. */
    shelves?: ShelfView;
    /** A zone in clusters' outlines and labels, as drawn (`withShelves`). */
    clusters?: ClusterView;
    /** Whether it holds its stage board, as drawn (`withStageBoards`). */
    stageBoard?: true;
  },
  'zone'
>;

/** The fill opacity the theme gives a zone that has none of its own, in percent. */
function themeFillOpacity(): number {
  return tokenNumber('--zone-fill-default');
}

/**
 * The tab's Tidy button, and the ▾ beside it: a menu of Tidy now, the zone's spacing, and where the spacing for new zones
 * is set (named as it is now, read as the menu opens).
 */
function TidyChips({ zone, binding }: { zone: Zone; binding: ZoneBindingActions }) {
  const [newZones, setNewZones] = useState<ArrangeSpacing>();
  const readNewZones = (open: boolean) => {
    if (open) window.agentBoard.flowEdges.settings().then((settings) => setNewZones(settings.arrangeSpacing), () => {});
  };
  const blocked = tidyBlocked(zone);
  return (
    <span className="zone-tab-split">
      <Chip
        className="zone-tab-control nodrag"
        icon={<LayoutGrid />}
        aria-label="Tidy zone"
        // Not `disabled`, which would hide the tooltip saying why.
        aria-disabled={blocked.disabled}
        title={blocked.hint ?? 'Tidy: its tiles in rows, in reading order'}
        onClick={() => blocked.disabled === undefined && binding.tidy(zone)}
      />
      <Menu
        onOpenChange={readNewZones}
        entries={tidyMenu(zone, newZones, binding)}
      >
        <Chip className="zone-tab-control nodrag" icon={<ChevronDown />} aria-label="Tidy and spacing" title="Tidy now, or pick this zone's spacing" />
      </Menu>
    </span>
  );
}

/** The tab's chips, the first to fold into ⋯ first when the zone is too narrow for them all. */
const FOLD_ORDER: readonly ZoneTabChip[] = ['fold', 'tidy', 'issue', 'tracker', 'bind', 'default-repo', 'shell', 'agent', 'cancel-clone'];

/** A chip on the tab now, and what ⋯ offers in its place once it folds: nothing when ⋯ has it already. */
interface TabChip {
  key: ZoneTabChip;
  chip: ReactNode;
  entry: ModelEntry | undefined;
}

export function zoneNode(zone: Zone): ZoneNodeType {
  return {
    id: zone.id,
    type: 'zone',
    position: { x: zone.x, y: zone.y },
    width: zone.width,
    height: zone.height,
    data: { zone },
    // Moved by its tab or its bare body: its tiles and items are nodes of their own, drawn over it, so a press
    // on one moves only that, and its tab's buttons are `nodrag`. A marquee inside it starts with Shift held, or in box
    // select, where its body lets presses through to the board.
    zIndex: 0,
  };
}

/** A zone under Classic: a tinted region with a labelled tab. */
function ClassicZone({
  data: { zone, tileCount = 0, resizeMin, shelves, clusters, stageBoard },
  selected,
  positionAbsoluteX,
  positionAbsoluteY,
  width,
  height,
}: NodeProps<ZoneNodeType>) {
  const saveLayout = useContext(SaveZoneLayoutContext);
  const resize = useContext(ZoneResizeContext);
  // Never smaller than rows of its tiles, nor than it is now if they already need more, nor than this resize can go.
  const rows = leastZoneSize(tileCount, { width: width ?? 0, height: height ?? 0 }, zoneGrid(zone.spacing));
  const least = {
    width: resizeMin?.width ?? Math.min(rows.width, width ?? 0),
    height: resizeMin?.height ?? Math.min(rows.height, height ?? 0),
  };
  const newAgent = useContext(NewAgentContext);
  const newShell = useContext(NewShellContext);
  const pickTracker = useContext(ZoneTrackerContext);
  const bind = useContext(BindZoneContext);
  const binding = useContext(ZoneBindingContext);
  const cancelClone = useContext(CancelCloneContext);
  const addIssue = useContext(AddIssueContext);
  const dropTarget = useContext(DropTargetContext) === zone.id;
  // A shelved zone's crew is in its stacks: no frame round where their tiles are saved.
  const crews = useContext(CrewFramesContext).filter((frame) => frame.zoneId === zone.id && shelves === undefined && clusters === undefined);
  const unbound = zone.repoRoot === null;
  const { clone } = zone;
  // A group starts agents too: in its default repo, or one picked for each. Only a clone holds them back.
  const noAgents = clone === null ? undefined : whyNoAgents(zone);
  const whyNoAgentsId = useId();
  const renaming = useRenaming(zone.name, (name) => binding.rename(zone, name));
  const path =
    clone !== null
      ? `Cloning ${clone.repo} into ${clone.path}`
      : zone.repoRoot === null
      ? zone.userFolder
        ? `${zone.groupFolder}, outside git: its agents share it`
        : 'A group: bound to no repo'
      : zone.folder === ''
        ? zone.repoRoot
        : `${zone.repoRoot}/${zone.folder}`;
  const tracker = zone.tracker && { ...TRACKER_PROVIDERS[zone.tracker.provider], scope: zone.tracker.scope };
  const tabEntries = zoneTabEntries(zone, noAgents, { newAgent, newShell, pickTracker, bind, cancelClone, addIssue, pickDefaultRepo: binding.pickDefaultRepo, tidy: binding.tidy });
  // The chips on the tab now, in the order drawn, each with what ⋯ offers in its place once it folds. A chip is
  // drawn under the same rule `zoneTabEntries` gives it a row by: change one, change the other.
  const chips: TabChip[] = [
    ...(zone.defaultRepo === null
      ? []
      : [
          {
            key: 'default-repo' as const,
            chip: (
              <Chip
                className="zone-tab-control zone-default-repo nodrag"
                icon={<GitBranch />}
                aria-label="Default repo"
                title={`New agents here start in ${zone.defaultRepo}`}
                onClick={() => binding.pickDefaultRepo(zone)}
              >
                {folderLabel(zone.defaultRepo, undefined)}
              </Chip>
            ),
            entry: tabEntries['default-repo'],
          },
        ]),
    ...(clone === null
      ? []
      : [
          {
            key: 'cancel-clone' as const,
            chip: (
              <Chip className="zone-tab-control nodrag" icon={<X />} aria-label="Cancel clone" onClick={() => cancelClone(zone)}>
                Cancel
              </Chip>
            ),
            entry: tabEntries['cancel-clone'],
          },
        ]),
    {
      key: 'tracker',
      chip: (
        <Chip
          className="zone-tab-control nodrag"
          icon={<CircleDot />}
          aria-label="Zone tracker"
          title={tracker === null ? 'Pick where issues come from' : `Issues from ${tracker.name} ${tracker.scopeName} ${tracker.scope}`}
          onClick={() => pickTracker(zone)}
        >
          {zone.tracker === null ? 'issues' : zone.tracker.scope}
        </Chip>
      ),
      entry: tabEntries.tracker,
    },
    ...(zone.tracker === null
      ? []
      : [
          {
            key: 'issue' as const,
            chip: (
              <Chip
                className="zone-tab-control nodrag"
                icon={<ListPlus />}
                aria-label="Add issue"
                title={`Pick an issue from ${zone.tracker.scope}`}
                onClick={() => addIssue(zone)}
              >
                issue
              </Chip>
            ),
            entry: tabEntries.issue,
          },
        ]),
    ...(unbound && clone === null
      ? [
          {
            key: 'bind' as const,
            chip: (
              <Menu entries={bindEntries(zone, { bind, pickTracker })}>
                <Chip className="zone-tab-control nodrag" icon={<Link2 />} aria-label="Bind zone" title="Bind this zone to a repo, or to a new project">
                  Bind…
                </Chip>
              </Menu>
            ),
            entry: tabEntries.bind,
          },
        ]
      : []),
    {
      key: 'agent',
      chip: (
        <>
          <span className="zone-tab-split">
            <Chip
              className="zone-tab-control nodrag"
              icon={<Plus />}
              aria-label="New agent"
              // Not `disabled`, which would take it out of the tab order and hide the tooltip saying why.
              aria-disabled={noAgents !== undefined}
              aria-describedby={noAgents === undefined ? undefined : whyNoAgentsId}
              title={noAgents}
              onClick={() => noAgents === undefined && newAgent(zone)}
            >
              agent
            </Chip>
            {/* A blank agent first, then the library's prefabs: this zone draws again when the library changes. */}
            <Menu entries={newAgentMenu(zone, noAgents, { ...binding, newAgent })}>
              <Chip className="zone-tab-control nodrag" icon={<ChevronDown />} aria-label="Blank agent or prefab" title="A blank agent, or a crew from a prefab" />
            </Menu>
          </span>
          {noAgents !== undefined && (
            // The tooltip is for the mouse; this says the same to the keyboard and screen readers.
            <span id={whyNoAgentsId} className="visually-hidden">
              {noAgents}
            </span>
          )}
        </>
      ),
      entry: tabEntries.agent,
    },
    {
      key: 'shell',
      chip: (
        <Chip className="zone-tab-control nodrag" icon={<Plus />} aria-label="New shell in zone" onClick={() => newShell(zone)}>
          shell
        </Chip>
      ),
      entry: tabEntries.shell,
    },
    {
      key: 'tidy',
      chip: <TidyChips zone={zone} binding={binding} />,
      entry: tabEntries.tidy,
    },
    // The first to give way: ⋯ folds the zone too, so a narrow zone keeps its + agent.
    ...(clone === null
      ? [
          {
            key: 'fold' as const,
            chip: <FoldButton className="zone-tab-control" noun="zone" onFold={() => binding.fold(zone)} />,
            entry: tabEntries.fold,
          },
        ]
      : []),
  ];
  const foldable = FOLD_ORDER.filter((key) => chips.some((chip) => chip.key === key));
  // What changes the tab's width without changing the zone's.
  const content = [zone.name, zone.tracker?.scope, zone.defaultRepo, clone?.phase, clone?.percent].join('\n');
  const { stripRef, tabRef, folded } = useZoneTabFold(foldable, content);
  // Each folded chip's action, at the head of ⋯, the most needed first.
  const foldedEntries = FOLD_ORDER.toReversed().flatMap((key) => {
    const entry = folded.has(key) ? chips.find((chip) => chip.key === key)?.entry : undefined;
    return entry === undefined ? [] : [entry];
  });
  // Its New crew lists the library as it is now, and this zone is drawn only when something of its own changes.
  usePrefabs();
  const menu = zoneMenu({ zone, folded: foldedEntries, themeFill: themeFillOpacity(), rename: renaming.startSoon, stageBoard, actions: binding });
  useMenuBarSection('project', selected === true, menu);
  return (
    <div
      className="zone"
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
    >
      {/* Under its tiles: each orchestrator's crew, framed beside it. */}
      <CrewFrameBoxes frames={crews} />
      {shelves !== undefined && <ShelvesView zoneId={zone.id} view={shelves} />}
      {clusters !== undefined && <ClustersView zoneId={zone.id} view={clusters} />}
      <NodeResizer
        // Grown round an expanded tile, it resizes from the size it is drawn at, and saves the size it is let go at. A
        // shelved zone is as big as its shelves.
        isVisible={selected && shelves === undefined && clusters === undefined}
        color={zone.color}
        minWidth={Math.max(MIN_ZONE_SIZE.width, least.width)}
        minHeight={Math.max(MIN_ZONE_SIZE.height, least.height)}
        onResizeStart={() => resize.start(zone.id)}
        // Shrinking past its tiles packs them inward as it goes, and stops once they fit no tighter.
        shouldResize={(_event, next) => resize.resize(zone.id, next)}
        onResizeEnd={(_event, { x, y, width, height }) => saveLayout(zone.id, { x, y, width, height })}
      />
      <div className="zone-tab-strip" ref={stripRef}>
        <div className="zone-tab" data-testid="zone-tab" title={path} ref={tabRef}>
          {unbound && clone === null && <span className="zone-tab-dot" aria-hidden="true" />}
          <span className="zone-tab-kind">{clone !== null ? 'clone' : unbound ? 'group' : zone.kind}</span>
          <EditableName className="zone-tab-name" value={zone.name} renaming={renaming} label="Zone name" />
          <ZoneTodoBadge zoneId={zone.id} />
          {clone !== null && (
            <span className="zone-clone" data-testid="zone-clone" role="status" aria-label={`Cloning ${clone.repo}`}>
              <span className="zone-clone-bar" aria-hidden="true">
                <span className="zone-clone-fill" style={{ width: `${clone.percent ?? 0}%` }} />
              </span>
              <span className="zone-clone-text">
                {clone.percent === null ? 'Cloning…' : `${clone.phase ?? 'Cloning'} · ${clone.percent}%`}
              </span>
            </span>
          )}
          {chips
            .filter(({ key }) => !folded.has(key))
            .map(({ key, chip }) => (
              <span key={key} className="zone-tab-slot" data-fold={key}>
                {chip}
              </span>
            ))}
          {clone !== null && foldedEntries.length > 0 && (
            <Menu entries={menu}>
              <Chip className="zone-tab-control nodrag" icon={<Ellipsis />} aria-label="Zone options" title="What doesn't fit on the tab" />
            </Menu>
          )}
          {clone === null && (
            <Menu entries={menu}>
              <Chip className="zone-tab-control nodrag" icon={<Ellipsis />} aria-label="Zone options" title="Tidy, spacing, rename, colour, default repo, unbind, trusting its folder, board MCP, orchestrating, gate command, role templates, delete" />
            </Menu>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * A zone, drawn as the design has it: under Classic a tinted region with a labelled tab, under the Simplified design a
 * project's neutral well (`ProjectWell`). Resizable from its edges once selected.
 */
export const ZoneNode = memo(function ZoneNode(props: NodeProps<ZoneNodeType>) {
  const simplified = useSimplified();
  // Folded, it is one chip in either design.
  if (props.data.zone.folded) return <FoldedZone {...props} />;
  return simplified ? <ProjectWell {...props} /> : <ClassicZone {...props} />;
});
