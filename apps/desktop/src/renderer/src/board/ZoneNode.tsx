import { createContext, memo, useContext, useId, type CSSProperties } from 'react';
import { NodeResizer, type Node, type NodeProps } from '@xyflow/react';
import { CircleDot, Ellipsis, FolderGit2, FolderPlus, GitBranch, LayoutGrid, Link2, ListPlus, ListTodo, Pencil, Plus, Unlink, X } from 'lucide-react';
import { Chip, EditableName, Menu, useRenaming } from '../ui';
import { folderLabel } from './folders';
import { leastZoneSize } from './layout';
import {
  MIN_ZONE_SIZE,
  TRACKER_PROVIDERS,
  ZONE_COLOR_NAMES,
  ZONE_COLORS,
  type Zone,
  type ZoneBinding,
  type ZoneLayout,
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
  },
  'zone'
>;

/** Persists a zone's layout once the user has finished moving or resizing it. */
export const SaveZoneLayoutContext = createContext<(id: string, layout: ZoneLayout) => void>(() => {});

/** What the board does as a zone is resized: its tiles are packed inward as it shrinks past them. */
export interface ZoneResize {
  /** A resize of the zone begins. */
  start(id: string): void;
  /** Whether the zone can take the layout `next`: false once its tiles can be packed no tighter, keeping those that fit. */
  resize(id: string, next: ZoneLayout): boolean;
}
export const ZoneResizeContext = createContext<ZoneResize>({ start: () => {}, resize: () => true });

/** Why a group with no default repo can't start an agent from an issue: there is no repo to ask for one in. */
const BIND_FIRST = 'Bind this zone to a repo, or give it a default repo, first';
/** Why a cloning zone's New agent button does nothing (S2). */
const AFTER_CLONE = 'Available after clone finishes';

/**
 * Why no agent can start in the zone with no repo picked for it: it is cloning, or a group with no default repo.
 * Undefined when one can.
 */
export function whyNoAgents(zone: Pick<Zone, 'clone' | 'repoRoot' | 'defaultRepo'>): string | undefined {
  if (zone.clone !== null) return AFTER_CLONE;
  return zone.repoRoot === null && zone.defaultRepo === null ? BIND_FIRST : undefined;
}

/** Stops a zone's clone; the zone goes with it. */
export const CancelCloneContext = createContext<(zone: Zone) => void>(() => {});

/** Asks the user for an issue from the zone's tracker, to put its card in the zone or start an agent from it. */
export const AddIssueContext = createContext<(zone: Zone) => void>(() => {});

/** Asks the user for a new agent's task, to start it in the zone. */
export const NewAgentContext = createContext<(zone: Zone) => void>(() => {});

/** Starts a shell tile in the zone: in its folder, or at home if it is unbound. */
export const NewShellContext = createContext<(zone: Zone) => void>(() => {});

/** Asks the user which tracker team or repo the zone's issues come from. */
export const ZoneTrackerContext = createContext<(zone: Zone) => void>(() => {});

/** The zone a dragged tile or note would move into if dropped now, which shows it is the drop target. */
export const DropTargetContext = createContext<string | undefined>(undefined);

/** Asks the user for a folder to bind an unbound zone to, as a repo or as a new project. */
export const BindZoneContext = createContext<(zone: Zone, as: ZoneBinding) => void>(() => {});

/**
 * What a zone's tab can do to the zone: to its binding, unbind it back into a group or set a group's default
 * repo; Tidy it; rename or recolour it, and dissolve a group.
 */
export interface ZoneBindingActions {
  unbind(zone: Zone): void;
  /** Asks for a group's default repo, to set or clear it. */
  pickDefaultRepo(zone: Zone): void;
  /** Lays its tiles out in rows, in reading order, and fits its height to them. */
  tidy(zone: Zone): void;
  /** Renames it; rejects if the daemon refuses. */
  rename(zone: Zone, name: string): Promise<unknown>;
  recolor(zone: Zone, color: string): void;
  /** Removes a group, leaving its tiles loose on the board where they are, and its notes and cards. */
  dissolve(zone: Zone): void;
}
export const ZoneBindingContext = createContext<ZoneBindingActions>({
  unbind: () => {},
  pickDefaultRepo: () => {},
  tidy: () => {},
  rename: () => Promise.resolve(),
  recolor: () => {},
  dissolve: () => {},
});

export function zoneNode(zone: Zone): ZoneNodeType {
  return {
    id: zone.id,
    type: 'zone',
    position: { x: zone.x, y: zone.y },
    width: zone.width,
    height: zone.height,
    data: { zone },
    // Moved by its tab, so the body stays free for the tiles that will live in it.
    dragHandle: '.zone-tab',
    zIndex: 0,
  };
}

/** A zone: a tinted region with a labelled tab, resizable from its edges once selected. */
export const ZoneNode = memo(function ZoneNode({
  data: { zone, tileCount = 0, resizeMin },
  selected,
  positionAbsoluteX,
  positionAbsoluteY,
  width,
  height,
}: NodeProps<ZoneNodeType>) {
  const saveLayout = useContext(SaveZoneLayoutContext);
  const resize = useContext(ZoneResizeContext);
  // Never smaller than rows of its tiles, nor than it is now if they already need more, nor than this resize can go.
  const rows = leastZoneSize(tileCount, { width: width ?? 0, height: height ?? 0 });
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
      ? 'A group: bound to no repo'
      : zone.folder === ''
        ? zone.repoRoot
        : `${zone.repoRoot}/${zone.folder}`;
  const tracker = zone.tracker && { ...TRACKER_PROVIDERS[zone.tracker.provider], scope: zone.tracker.scope };
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
      style={{ '--zone-color': zone.color } as CSSProperties}
    >
      <NodeResizer
        // Grown round an expanded tile, it resizes from the size it is drawn at, and saves the size it is let go at.
        isVisible={selected}
        color={zone.color}
        minWidth={Math.max(MIN_ZONE_SIZE.width, least.width)}
        minHeight={Math.max(MIN_ZONE_SIZE.height, least.height)}
        onResizeStart={() => resize.start(zone.id)}
        // Shrinking past its tiles packs them inward as it goes, and stops once they fit no tighter.
        shouldResize={(_event, next) => resize.resize(zone.id, next)}
        onResizeEnd={(_event, { x, y, width, height }) => saveLayout(zone.id, { x, y, width, height })}
      />
      <div className="zone-tab" data-testid="zone-tab" title={path}>
        {unbound && clone === null && <span className="zone-tab-dot" aria-hidden="true" />}
        <span className="zone-tab-kind">{clone !== null ? 'clone' : unbound ? 'group' : zone.kind}</span>
        <EditableName className="zone-tab-name" value={zone.name} renaming={renaming} label="Zone name" />
        {zone.defaultRepo !== null && (
          <Chip
            className="zone-tab-control zone-default-repo nodrag"
            icon={<GitBranch />}
            aria-label="Default repo"
            title={`New agents here start in ${zone.defaultRepo}`}
            onClick={() => binding.pickDefaultRepo(zone)}
          >
            {folderLabel(zone.defaultRepo, undefined)}
          </Chip>
        )}
        {clone !== null && (
          <>
            <span className="zone-clone" data-testid="zone-clone" role="status" aria-label={`Cloning ${clone.repo}`}>
              <span className="zone-clone-bar" aria-hidden="true">
                <span className="zone-clone-fill" style={{ width: `${clone.percent ?? 0}%` }} />
              </span>
              <span className="zone-clone-text">
                {clone.percent === null ? 'Cloning…' : `${clone.phase ?? 'Cloning'} · ${clone.percent}%`}
              </span>
            </span>
            <Chip className="zone-tab-control nodrag" icon={<X />} aria-label="Cancel clone" onClick={() => cancelClone(zone)}>
              Cancel
            </Chip>
          </>
        )}
        <Chip
          className="zone-tab-control nodrag"
          icon={<CircleDot />}
          aria-label="Zone tracker"
          title={
            tracker === null
              ? 'Pick where issues come from'
              : `Issues from ${tracker.name} ${tracker.scopeName} ${tracker.scope}`
          }
          onClick={() => pickTracker(zone)}
        >
          {zone.tracker === null ? 'issues' : zone.tracker.scope}
        </Chip>
        {zone.tracker !== null && (
          <Chip
            className="zone-tab-control nodrag"
            icon={<ListPlus />}
            aria-label="Add issue"
            title={`Pick an issue from ${zone.tracker.scope}`}
            onClick={() => addIssue(zone)}
          >
            issue
          </Chip>
        )}
        {unbound && clone === null && (
          <Menu
            entries={[
              { label: 'Open as repo…', icon: <GitBranch />, onSelect: () => bind(zone, 'repo') },
              { label: 'Open as project…', icon: <FolderPlus />, onSelect: () => bind(zone, 'project') },
              { label: 'Bind to a Linear team or GitHub repo…', icon: <ListTodo />, onSelect: () => pickTracker(zone) },
            ]}
          >
            <Chip
              className="zone-tab-control nodrag"
              icon={<Link2 />}
              aria-label="Bind zone"
              title="Bind this zone to a repo, or to a new project"
            >
              Bind…
            </Chip>
          </Menu>
        )}
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
        {noAgents !== undefined && (
          // The tooltip is for the mouse; this says the same to the keyboard and screen readers.
          <span id={whyNoAgentsId} className="visually-hidden">
            {noAgents}
          </span>
        )}
        <Chip className="zone-tab-control nodrag" icon={<Plus />} aria-label="New shell in zone" onClick={() => newShell(zone)}>
          shell
        </Chip>
        <Chip
          className="zone-tab-control nodrag"
          icon={<LayoutGrid />}
          aria-label="Tidy zone"
          title="Tidy: its tiles in rows, in reading order"
          onClick={() => binding.tidy(zone)}
        />
        {clone === null && (
          <Menu
            entries={[
              { label: 'Tidy', icon: <LayoutGrid />, hint: 'Its tiles in rows, in reading order', onSelect: () => binding.tidy(zone) },
              { label: 'Rename', icon: <Pencil />, onSelect: renaming.startSoon },
              {
                label: 'Colour',
                swatches: ZONE_COLORS.map((color) => ({ name: ZONE_COLOR_NAMES[color] ?? color, value: color, pressed: zone.color === color })),
                onPick: (color: string) => binding.recolor(zone, color),
              },
              unbound
                ? {
                    label: zone.defaultRepo === null ? 'Set a default repo…' : 'Change the default repo…',
                    icon: <FolderGit2 />,
                    hint: 'New agents here start in it without asking',
                    onSelect: () => binding.pickDefaultRepo(zone),
                  }
                : { label: 'Unbind', icon: <Unlink />, hint: 'Its agents keep their repos, and it keeps its issues', onSelect: () => binding.unbind(zone) },
              ...(unbound
                ? ['separator' as const, { label: 'Dissolve', icon: <X />, danger: true, hint: 'Its tiles stay on the board where they are', onSelect: () => binding.dissolve(zone) }]
                : []),
            ]}
          >
            <Chip className="zone-tab-control nodrag" icon={<Ellipsis />} aria-label="Zone options" title="Tidy, rename, colour, default repo, unbind, dissolve" />
          </Menu>
        )}
      </div>
    </div>
  );
});
